// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { resolvePath } from '../../../utils/path.ts'
import { PathSpec } from '../../../types.ts'
import { WASI, errnoFor } from './errors.ts'
import { readdir } from './list.ts'
import { stat } from './stat.ts'
import { epochToIso } from '../../../utils/dates.ts'
import { FileHandle, FileTable, parseMode, type OpenMode } from '../../handles/index.ts'
import { applyOpen } from '../../open.ts'
import type { RuntimeVFS } from '../../vfs.ts'
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// WASI preview1 errnos this shim answers with directly. The numbering
// lives beside this shim (errors.ts, the same numbers python's
// wasm/errors.py keeps): guests compare against these, so host errno
// numbering must not leak.
const ENOENT = WASI.ENOENT

/**
 * Install the `std.open`/`os.readdir` host functions on an asyncified
 * quickjs context, backed by the runtime vfs. A null vfs (no
 * workspace mounts wired) still installs the surface, but every open
 * and readdir fails cleanly — `std.open` returns null and `os.readdir`
 * reports ENOENT — so guest code sees an empty filesystem rather than a
 * missing global.
 *
 * Answers `closeAll`, which the runtime awaits when the guest ends: a
 * process's writes are in its files whether or not it closed them, so
 * each file left open still owes the mount its writes.
 *
 * @param ctx - the asyncified quickjs context
 * @param vfs - the runtime's mount vocabulary, or null when no mounts are wired
 */
export function installQuickJsFs(
  ctx: QuickJSAsyncContext,
  vfs: RuntimeVFS | null,
): () => Promise<string[]> {
  const table = new FileTable<FileHandle>()
  let cwd = PathSpec.fromStrPath('/')
  const absolute = (handle: QuickJSHandle): string => {
    const path = ctx.getString(handle)
    return path === '' ? '' : resolvePath(path, cwd.virtual)
  }

  const defineAsync = (
    name: string,
    fn: (...args: QuickJSHandle[]) => Promise<QuickJSHandle>,
  ): void => {
    const handle = ctx.newAsyncifiedFunction(name, fn)
    ctx.setProp(ctx.global, name, handle)
    handle.dispose()
  }

  const defineSync = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle): void => {
    const handle = ctx.newFunction(name, fn)
    ctx.setProp(ctx.global, name, handle)
    handle.dispose()
  }

  defineSync('__mirage_getcwd', () => ctx.newString(cwd.virtual))

  defineAsync('__mirage_chdir', async (pathH) => {
    const path = absolute(pathH)
    if (path !== '/') {
      if (path === '' || vfs === null) return ctx.newNumber(-ENOENT)
      try {
        const st = await vfs.viewStat(path)
        if (st === null) return ctx.newNumber(-ENOENT)
        if (!st.isDir) return ctx.newNumber(-WASI.ENOTDIR)
      } catch (err) {
        return ctx.newNumber(-errnoFor(err))
      }
    }
    cwd = PathSpec.fromStrPath(path)
    return ctx.newNumber(0)
  })

  defineAsync('__mirage_open', async (pathH, modeH) => {
    const path = absolute(pathH)
    // The engine validates the mode before touching the filesystem
    // (qjs-libc throws TypeError before any open); -2 tells the
    // bootstrap to raise that refusal, since a host throw would not
    // arrive typed. The shared parser is stricter than qjs-libc's
    // character scan ('rr' passes strspn but not CPython's one-base
    // rule); the strict answer is the one both guests can agree on.
    let mode: OpenMode
    try {
      mode = parseMode(ctx.getString(modeH))
    } catch {
      return ctx.newNumber(-2)
    }
    if (vfs?.serves(path) !== true) return ctx.newNumber(-1)
    // The open's effect lands through the mount at open, by the rule
    // every door shares, so write modes and a read-narrowed session
    // refuse here (the guest gets null), the ledger records the real
    // op, and a backend with a native truncate receives it. Any refusal
    // or failure is the guest's null: a transient failure or a policy
    // denial on an existing file must refuse the open, or a
    // create-capable mode would create over content this open never saw.
    let handle: FileHandle
    try {
      const row = await applyOpen(vfs, path, mode)
      // Nothing is read at open: the handle fetches what a read lands in.
      // A handle that writes reads the stored bytes, since its writes land
      // on them; a read-only one sees the rendering.
      const door = vfs
      handle = FileHandle.opened(
        path,
        row === null
          ? null
          : (offset, size) =>
              door.read(
                path,
                size === null ? { raw: mode.writable } : { offset, size, raw: mode.writable },
              ),
        { size: row?.size ?? 0, writable: mode.writable, append: mode.append },
      )
    } catch {
      return ctx.newNumber(-1)
    }
    return ctx.newNumber(table.add(handle))
  })

  defineAsync('__mirage_close', async (fdH) => {
    const file = table.pop(ctx.getNumber(fdH))
    if (file === undefined) return ctx.undefined
    if (file.dirty && vfs !== null) await vfs.flush(file.path, file.flushPlan())
    return ctx.undefined
  })

  defineAsync('__mirage_readdir', (pathH) => readdir(ctx, vfs, absolute(pathH)))

  // A file answers a read only from the bytes it holds, so the bootstrap
  // asks whether a read lacks bytes and fills until it does not; every
  // read below then answers synchronously.
  defineSync('__mirage_lacks', (fdH, sizeH) => {
    const file = table.get(ctx.getNumber(fdH))
    return file?.lacks(ctx.getNumber(sizeH)) === true ? ctx.true : ctx.false
  })

  defineSync('__mirage_lacks_line', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    return file?.lacksLine() === true ? ctx.true : ctx.false
  })

  defineAsync('__mirage_fill', async (fdH, sizeH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file !== undefined) await file.fill(ctx.getNumber(sizeH))
    return ctx.undefined
  })

  defineSync('__mirage_read', (fdH, maxH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.newString('')
    return ctx.newString(DEC.decode(file.read(ctx.getNumber(maxH))))
  })

  defineSync('__mirage_getline', (fdH) => {
    const line = table.get(ctx.getNumber(fdH))?.readLine() ?? null
    return line === null ? ctx.null : ctx.newString(DEC.decode(line))
  })

  defineSync('__mirage_write', (fdH, textH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file?.writable === true) file.write(ENC.encode(ctx.getString(textH)))
    return ctx.undefined
  })

  defineSync('__mirage_seek', (fdH, offsetH, whenceH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.undefined
    const offset = ctx.getNumber(offsetH)
    const whence = ctx.getNumber(whenceH)
    const base = whence === 1 ? file.pos : whence === 2 ? file.size : 0
    file.pos = Math.max(0, base + offset)
    return ctx.undefined
  })

  defineSync('__mirage_tell', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    return ctx.newNumber(file === undefined ? -1 : file.pos)
  })

  defineSync('__mirage_eof', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    const atEof = file === undefined || file.eof
    return atEof ? ctx.true : ctx.false
  })

  // The os.* mutation surface, matching the real engine's conventions
  // (pinned live against qjs-wasi through the python runtime): 0 on
  // success, -errno on failure in WASI numbering; os.remove takes
  // files and empty directories; os.stat answers [obj, errno].
  defineAsync('__mirage_remove', async (pathH) => {
    const path = absolute(pathH)
    if (vfs?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    try {
      const st = await vfs.stat(path)
      if (st.isDir) {
        await vfs.rmdir(path)
      } else {
        await vfs.unlink(path)
      }
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_mkdir', async (pathH) => {
    const path = absolute(pathH)
    if (vfs?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    try {
      await vfs.mkdir(path)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_utimes', async (pathH, atimeH, mtimeH) => {
    const path = absolute(pathH)
    if (vfs?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    // The engine's stamps are milliseconds (qjs-libc splits them into
    // tv_sec/tv_nsec at 1000), and the op takes ISO text.
    const atime = epochToIso(ctx.getNumber(atimeH) / 1000)
    const mtime = epochToIso(ctx.getNumber(mtimeH) / 1000)
    try {
      await vfs.setattr(path, { atime, mtime })
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_rename', async (srcH, dstH) => {
    const src = absolute(srcH)
    const dst = absolute(dstH)
    if (vfs?.serves(src) !== true || !vfs.serves(dst)) return ctx.newNumber(-ENOENT)
    // The door refuses a pair on different mounts (CROSS_MOUNT), which
    // this engine numbers -44, the real engine's answer (pinned live:
    // each mount is its own preopen and the destination never resolves).
    try {
      await vfs.rename(src, dst)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_stat', (pathH) => stat(ctx, vfs, absolute(pathH)))

  return async () => {
    const failures: string[] = []
    for (const file of table.values()) {
      if (!file.dirty || vfs === null) continue
      try {
        await vfs.flush(file.path, file.flushPlan())
      } catch (err) {
        failures.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return failures
  }
}

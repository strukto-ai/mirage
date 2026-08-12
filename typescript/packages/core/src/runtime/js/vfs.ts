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

import { classify } from '../../errors/index.ts'
import { isMissingPath } from '../../utils/errors.ts'
import { WASI } from './wasi.ts'
import { DIR_MODE, FILE_MODE } from '../../utils/stat_view.ts'
import { FileHandle, FileTable, parseMode, type OpenMode } from '../handles/index.ts'
import type { RuntimeVFS, VFSStat } from '../vfs.ts'
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten'
import { compareCodePoints } from '../../utils/sort.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// WASI preview1 errnos this shim answers with directly. The numbering
// lives beside this shim (wasi.ts, the same numbers python's abi.py
// keeps): guests compare against these, so host errno numbering must
// not leak.
const EIO = WASI.EIO
const ENOENT = WASI.ENOENT

function wasiErrno(err: unknown): number {
  // Naming is the shared classifier's; this boundary only renders the
  // condition in preview1 numbers. EIO is the same everything-else
  // fallback the python host keeps for an unnamed OSError.
  const condition = classify(err)
  return condition !== null ? WASI[condition] : EIO
}

// The `std.open`/`os.readdir` surface that qjs-wasi exposes natively,
// synthesized here over the runtime's mount vocabulary so
// quickjs-emscripten matches it. Whole-file buffering is the shared
// `FileHandle` (the same one Python's `WasiFs` rides): open fetches the
// bytes (or starts empty), the byte-level calls touch the in-memory
// buffer, and close hands the buffer to `RuntimeVFS.flush`, which ships
// a tail when the handle only extended the file. Only open, close, and
// readdir cross the async boundary, so
// they are asyncified host functions (the guest suspends until the
// dispatch resolves); the byte-level calls are synchronous.
//
// The JS bootstrap that wires these host functions into `std`/`os`.
// Appended after the main quickjs bootstrap, which defines `std`.
export const MIRAGE_FS_BOOTSTRAP = `
std.open = (path, mode) => {
  const fd = __mirage_open(String(path), String(mode === undefined ? 'r' : mode));
  if (fd === -2) throw new TypeError('invalid file mode');
  if (fd < 0) return null;
  return {
    readAsString: (max) => __mirage_read(fd, max === undefined ? -1 : (max | 0)),
    read: () => __mirage_read(fd, -1),
    getline: () => __mirage_getline(fd),
    puts: (s) => { __mirage_write(fd, String(s)); },
    write: (s) => { __mirage_write(fd, String(s)); return String(s).length; },
    seek: (offset, whence) => { __mirage_seek(fd, offset | 0, whence === undefined ? 0 : (whence | 0)); return 0; },
    tell: () => __mirage_tell(fd),
    eof: () => __mirage_eof(fd),
    flush: () => {},
    close: () => { __mirage_close(fd); return 0; },
  };
};
globalThis.os = globalThis.os || {};
os.readdir = (path) => __mirage_readdir(String(path));
os.stat = (path) => __mirage_stat(String(path));
os.remove = (path) => __mirage_remove(String(path));
os.mkdir = (path) => __mirage_mkdir(String(path));
os.rename = (a, b) => __mirage_rename(String(a), String(b));
os.S_IFMT = 61440;
os.S_IFDIR = 16384;
os.S_IFREG = 32768;
`

/**
 * Install the `std.open`/`os.readdir` host functions on an asyncified
 * quickjs context, backed by the runtime vfs. A null vfs (no
 * workspace mounts wired) still installs the surface, but every open
 * and readdir fails cleanly — `std.open` returns null and `os.readdir`
 * reports ENOENT — so guest code sees an empty filesystem rather than a
 * missing global.
 *
 * @param ctx - the asyncified quickjs context
 * @param vfs - the runtime's mount vocabulary, or null when no mounts are wired
 */
export function installMirageFs(ctx: QuickJSAsyncContext, vfs: RuntimeVFS | null): void {
  const table = new FileTable<FileHandle>()

  const mountOf = (path: string): string | null => (vfs === null ? null : vfs.mountOf(path))

  const underMount = (path: string): boolean => mountOf(path) !== null

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

  defineAsync('__mirage_open', async (pathH, modeH) => {
    const path = ctx.getString(pathH)
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
    if (vfs === null || !underMount(path)) return ctx.newNumber(-1)
    let st: VFSStat | null = null
    try {
      st = await vfs.stat(path)
    } catch (err) {
      // Only a confirmed absence reads as "no file yet" (the python
      // host's stat_or_none makes the same distinction): a transient
      // failure or a policy denial on an existing file must refuse the
      // open, or a create-capable mode would create over content this
      // open never saw.
      if (!isMissingPath(err)) return ctx.newNumber(-1)
    }
    // The same ladder as the python wasi host's path_open, so the two
    // engines refuse the same opens: a directory, an exclusive open
    // over an existing file (EEXIST in the real engine), and a missing
    // file whose mode does not create.
    if (st?.isDir === true) return ctx.newNumber(-1)
    if (st !== null && mode.exclusive) return ctx.newNumber(-1)
    if (st === null && !mode.create) return ctx.newNumber(-1)
    // The establishing op goes through the mount at open as the op it
    // is — create for a missing file, truncate for a discarded one —
    // so write modes and a read-narrowed session refuse here (the
    // guest gets null), the ledger records the real op, and a backend
    // with a native truncate receives it.
    let buf: Uint8Array = new Uint8Array()
    try {
      if (st === null) {
        await vfs.create(path)
      } else if (mode.truncate) {
        await vfs.truncate(path)
      } else {
        buf = await vfs.read(path)
      }
    } catch {
      return ctx.newNumber(-1)
    }
    const fd = table.add(FileHandle.opened(path, buf, mode))
    return ctx.newNumber(fd)
  })

  defineAsync('__mirage_close', async (fdH) => {
    const file = table.pop(ctx.getNumber(fdH))
    if (file === undefined) return ctx.undefined
    if (file.dirty && file.writable && vfs !== null) {
      await vfs.flush(file.path, file.baseLen, file.lowWrite, file.buf)
    }
    return ctx.undefined
  })

  defineAsync('__mirage_readdir', async (pathH) => {
    const path = ctx.getString(pathH)
    const names: string[] = []
    let errno = 0
    if (vfs === null || !underMount(path)) {
      errno = ENOENT
    } else {
      try {
        const prefix = path.endsWith('/') ? path : path + '/'
        for (const entry of await vfs.readdir(prefix)) {
          const rel = entry.path.replace(/\/$/, '').slice(prefix.length)
          if (rel.length > 0 && !rel.includes('/')) names.push(rel)
        }
        names.sort(compareCodePoints)
      } catch (err) {
        errno = wasiErrno(err)
      }
    }
    const namesArr = ctx.newArray()
    names.forEach((name, i) => {
      const s = ctx.newString(name)
      ctx.setProp(namesArr, i, s)
      s.dispose()
    })
    const tuple = ctx.newArray()
    ctx.setProp(tuple, 0, namesArr)
    namesArr.dispose()
    const errH = ctx.newNumber(errno)
    ctx.setProp(tuple, 1, errH)
    errH.dispose()
    return tuple
  })

  defineSync('__mirage_read', (fdH, maxH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.newString('')
    return ctx.newString(DEC.decode(file.read(ctx.getNumber(maxH))))
  })

  defineSync('__mirage_getline', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined || file.pos >= file.buf.length) return ctx.null
    let end = file.pos
    while (end < file.buf.length && file.buf[end] !== 0x0a) end++
    const line = file.buf.subarray(file.pos, end)
    file.pos = end < file.buf.length ? end + 1 : end
    return ctx.newString(DEC.decode(line))
  })

  defineSync('__mirage_write', (fdH, textH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file?.writable) file.write(ENC.encode(ctx.getString(textH)))
    return ctx.undefined
  })

  defineSync('__mirage_seek', (fdH, offsetH, whenceH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.undefined
    const offset = ctx.getNumber(offsetH)
    const whence = ctx.getNumber(whenceH)
    const base = whence === 1 ? file.pos : whence === 2 ? file.buf.length : 0
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
    const path = ctx.getString(pathH)
    if (vfs === null || !underMount(path)) return ctx.newNumber(-ENOENT)
    try {
      const st = await vfs.stat(path)
      if (st.isDir) {
        await vfs.rmdir(path)
      } else {
        await vfs.unlink(path)
      }
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_mkdir', async (pathH) => {
    const path = ctx.getString(pathH)
    if (vfs === null || !underMount(path)) return ctx.newNumber(-ENOENT)
    try {
      await vfs.mkdir(path)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_rename', async (srcH, dstH) => {
    const src = ctx.getString(srcH)
    const dst = ctx.getString(dstH)
    if (vfs === null || !underMount(src) || !underMount(dst)) return ctx.newNumber(-ENOENT)
    // The dispatcher addresses the rename's endpoints against the
    // source's mount, so a cross-mount pair would land inside the
    // wrong tree; the real engine answers -44 (pinned live: each
    // mount is its own preopen and the destination never resolves).
    if (mountOf(src) !== mountOf(dst)) return ctx.newNumber(-ENOENT)
    try {
      await vfs.rename(src, dst)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_stat', async (pathH) => {
    const path = ctx.getString(pathH)
    let st: VFSStat | null = null
    let errno = 0
    if (vfs === null || !underMount(path)) {
      errno = ENOENT
    } else {
      try {
        st = await vfs.stat(path)
      } catch (err) {
        errno = wasiErrno(err)
      }
    }
    const tuple = ctx.newArray()
    if (st === null) {
      ctx.setProp(tuple, 0, ctx.null)
    } else {
      const obj = ctx.newObject()
      const setNum = (key: string, value: number): void => {
        const h = ctx.newNumber(value)
        ctx.setProp(obj, key, h)
        h.dispose()
      }
      setNum('dev', 0)
      setNum('ino', 0)
      setNum('mode', st.isDir ? DIR_MODE : FILE_MODE)
      setNum('nlink', 1)
      setNum('uid', 0)
      setNum('gid', 0)
      setNum('rdev', 0)
      setNum('size', st.size)
      setNum('blocks', Math.ceil(st.size / 512))
      setNum('atime', st.mtimeMs)
      setNum('mtime', st.mtimeMs)
      setNum('ctime', st.mtimeMs)
      ctx.setProp(tuple, 0, obj)
      obj.dispose()
    }
    const errH = ctx.newNumber(errno)
    ctx.setProp(tuple, 1, errH)
    errH.dispose()
    return tuple
  })
}

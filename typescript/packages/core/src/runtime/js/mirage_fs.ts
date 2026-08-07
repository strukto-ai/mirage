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

import type { MirageBridge } from '../python/mirage_bridge.ts'
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// WASI preview1 errnos, the numbers the real qjs-wasi engine reports
// (python/mirage/runtime/wasm/abi.py is the reference table): guests
// compare against these, so host errno numbering must not leak.
const EACCES = 2
const EEXIST = 20
const EIO = 29
const EISDIR = 31
const ENOENT = 44
const ENOTDIR = 54
const ENOTSUP = 58

// stat mode bits (matching qjs-wasi's synthesized st_mode)
const S_IFDIR = 16384
const S_IFREG = 32768

// Mirror of the python errno_for table, keyed on the error's `code`.
const CODE_TO_WASI: Record<string, number> = {
  ENOENT: ENOENT,
  EEXIST: EEXIST,
  EISDIR: EISDIR,
  ENOTDIR: ENOTDIR,
  EACCES: EACCES,
  EPERM: EACCES,
  ENOTSUP: ENOTSUP,
}

function wasiErrno(err: unknown): number {
  const code = (err as { code?: string }).code
  if (code !== undefined && code in CODE_TO_WASI) return CODE_TO_WASI[code] ?? EIO
  return EIO
}

interface GuestFile {
  path: string
  buf: Uint8Array
  pos: number
  dirty: boolean
  writable: boolean
}

// The `std.open`/`os.readdir` surface that qjs-wasi exposes natively,
// synthesized here over the workspace bridge so quickjs-emscripten
// matches it. Whole-file buffering mirrors the Python `WasiFs`: open
// fetches the bytes (or starts empty), the byte-level calls touch the
// in-memory buffer, and close flushes a dirty buffer back through
// dispatch. Only open, close, and readdir cross the async bridge, so
// they are asyncified host functions (the guest suspends until the
// dispatch resolves); the byte-level calls are synchronous.
//
// The JS bootstrap that wires these host functions into `std`/`os`.
// Appended after the main quickjs bootstrap, which defines `std`.
export const MIRAGE_FS_BOOTSTRAP = `
std.open = (path, mode) => {
  const fd = __mirage_open(String(path), String(mode === undefined ? 'r' : mode));
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

function isWritable(mode: string): boolean {
  return /[wax+]/.test(mode)
}

function writeAt(file: GuestFile, bytes: Uint8Array): void {
  const end = file.pos + bytes.length
  if (end > file.buf.length) {
    const grown = new Uint8Array(end)
    grown.set(file.buf)
    file.buf = grown
  }
  file.buf.set(bytes, file.pos)
  file.pos = end
  file.dirty = true
}

/**
 * Install the `std.open`/`os.readdir` host functions on an asyncified
 * quickjs context, backed by the workspace bridge. A null bridge (no
 * workspace mounts wired) still installs the surface, but every open
 * and readdir fails cleanly — `std.open` returns null and `os.readdir`
 * reports ENOENT — so guest code sees an empty filesystem rather than a
 * missing global.
 *
 * @param ctx - the asyncified quickjs context
 * @param bridge - the workspace bridge, or null when no mounts are wired
 */
export function installMirageFs(ctx: QuickJSAsyncContext, bridge: MirageBridge | null): void {
  const table = new Map<number, GuestFile>()
  let nextFd = 1

  const mountOf = (path: string): string | null => {
    if (bridge === null) return null
    for (const p of bridge.prefixes()) {
      if (path === p.slice(0, -1) || path.startsWith(p)) return p
    }
    return null
  }

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
    const mode = ctx.getString(modeH)
    if (bridge === null || !underMount(path)) return ctx.newNumber(-1)
    const truncate = mode.includes('w')
    const append = mode.includes('a')
    const writable = isWritable(mode)
    let buf: Uint8Array = new Uint8Array()
    let existed = false
    if (!truncate) {
      try {
        buf = await bridge.fetch(path)
        existed = true
      } catch {
        if (!writable) return ctx.newNumber(-1)
      }
    }
    // Truncate or create writes through the bridge at open, mirroring
    // the Python runtime: this enforces write modes (a read-only mount
    // or a read-narrowed session throws here, so the guest gets null)
    // and establishes the file before the buffered writes.
    if (truncate || (writable && !existed)) {
      try {
        await bridge.flush(path, buf)
      } catch {
        return ctx.newNumber(-1)
      }
    }
    const fd = nextFd++
    table.set(fd, {
      path,
      buf,
      pos: append ? buf.length : 0,
      dirty: false,
      writable,
    })
    return ctx.newNumber(fd)
  })

  defineAsync('__mirage_close', async (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.undefined
    table.delete(ctx.getNumber(fdH))
    if (file.dirty && file.writable && bridge !== null) {
      await bridge.flush(file.path, file.buf)
    }
    return ctx.undefined
  })

  defineAsync('__mirage_readdir', async (pathH) => {
    const path = ctx.getString(pathH)
    const names: string[] = []
    let errno = 0
    if (bridge === null || !underMount(path)) {
      errno = ENOENT
    } else {
      try {
        const prefix = path.endsWith('/') ? path : path + '/'
        for (const entry of await bridge.list(prefix)) {
          const rel = entry.path.replace(/\/$/, '').slice(prefix.length)
          if (rel.length > 0 && !rel.includes('/')) names.push(rel)
        }
        names.sort()
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
    const max = ctx.getNumber(maxH)
    const end = max < 0 ? file.buf.length : Math.min(file.buf.length, file.pos + max)
    const slice = file.buf.subarray(file.pos, end)
    file.pos = end
    return ctx.newString(DEC.decode(slice))
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
    if (file?.writable) writeAt(file, ENC.encode(ctx.getString(textH)))
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
    const atEof = file === undefined || file.pos >= file.buf.length
    return atEof ? ctx.true : ctx.false
  })

  // The os.* mutation surface, matching the real engine's conventions
  // (pinned live against qjs-wasi through the python runtime): 0 on
  // success, -errno on failure in WASI numbering; os.remove takes
  // files and empty directories; os.stat answers [obj, errno].
  defineAsync('__mirage_remove', async (pathH) => {
    const path = ctx.getString(pathH)
    if (bridge === null || !underMount(path)) return ctx.newNumber(-ENOENT)
    try {
      const st = await bridge.stat(path)
      if (st.isDir) {
        await bridge.rmdir(path)
      } else {
        await bridge.unlink(path)
      }
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_mkdir', async (pathH) => {
    const path = ctx.getString(pathH)
    if (bridge === null || !underMount(path)) return ctx.newNumber(-ENOENT)
    try {
      await bridge.mkdir(path)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_rename', async (srcH, dstH) => {
    const src = ctx.getString(srcH)
    const dst = ctx.getString(dstH)
    if (bridge === null || !underMount(src) || !underMount(dst)) return ctx.newNumber(-ENOENT)
    // The dispatcher addresses the rename's endpoints against the
    // source's mount, so a cross-mount pair would land inside the
    // wrong tree; the real engine answers -44 (pinned live: each
    // mount is its own preopen and the destination never resolves).
    if (mountOf(src) !== mountOf(dst)) return ctx.newNumber(-ENOENT)
    try {
      await bridge.rename(src, dst)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-wasiErrno(err))
    }
  })

  defineAsync('__mirage_stat', async (pathH) => {
    const path = ctx.getString(pathH)
    let st = null as Awaited<ReturnType<MirageBridge['stat']>> | null
    let errno = 0
    if (bridge === null || !underMount(path)) {
      errno = ENOENT
    } else {
      try {
        st = await bridge.stat(path)
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
      setNum('mode', (st.isDir ? S_IFDIR : S_IFREG) | 0o644)
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

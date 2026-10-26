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

import { classify } from '../../../errors/index.ts'
import { resolvePath } from '../../../utils/path.ts'
import { PathSpec } from '../../../types.ts'
import { WASI, errnoFor } from '../../../errors/wasi.ts'
import { readdir } from './list.ts'
import { stat } from './stat.ts'
import { epochToIso } from '../../../utils/dates.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { concat } from '../../../utils/bytes.ts'
import { FileTable, type OpenMode } from '../../handles/index.ts'
import { Descriptor, type RuntimeFiles } from '../../files.ts'
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// WASI preview1 errnos this shim answers with directly. The numbering
// lives in errors/wasi.ts, the same numbers python's wasm/errors.py
// keeps: guests compare against these, so host errno numbering must not
// leak.
const ENOENT = WASI.ENOENT
// A pipe refuses a seek, which errors/wasi.ts has no condition for.
const ESPIPE = 70
// wasi-libc's stdio buffer, which std.in reads its input through.
const BUFSIZ = 1024
// wasi-libc's open flags, as the real engine on WASI names its os.O_*.
const O_APPEND = 1
const O_CREAT = 4096
const O_EXCL = 16384
const O_TRUNC = 32768
const O_RDONLY = 0x04000000
const O_WRONLY = 0x10000000

/**
 * Hand text to the guest. The engine takes a C string, so text holding
 * a NUL crosses as the pieces between its NULs, which the bootstrap
 * joins back.
 *
 * @param ctx - the quickjs context
 * @param text - the text the guest reads
 */
export function toGuestText(ctx: QuickJSAsyncContext, text: string): QuickJSHandle {
  if (!text.includes('\0')) return ctx.newString(text)
  const parts = ctx.newArray()
  text.split('\0').forEach((part, i) => {
    const h = ctx.newString(part)
    ctx.setProp(parts, i, h)
    h.dispose()
  })
  return parts
}

/**
 * Read text from the guest, whole or as the pieces between its NULs.
 *
 * @param ctx - the quickjs context
 * @param handle - a string, or the array the bootstrap split one into
 */
export function fromGuestText(ctx: QuickJSAsyncContext, handle: QuickJSHandle): string {
  if (ctx.typeof(handle) === 'string') return ctx.getString(handle)
  const parts: unknown = ctx.dump(handle)
  return Array.isArray(parts) ? parts.map(String).join('\0') : String(parts)
}

/**
 * The run's standard streams, which a guest's descriptors 0 to 2 name.
 */
export interface QuickJsStreams {
  /**
   * One read(2) of the run's input: what has arrived, up to `size` bytes,
   * waiting only while nothing has; empty at its end. A negative size
   * reads to the end.
   */
  read(size: number): Promise<Uint8Array>
  /** Write to the run's stdout (1) or stderr (2). */
  write(fd: 1 | 2, bytes: Uint8Array): Promise<void>
}

/**
 * A standard stream under descriptor 0, 1 or 2, in the shape the host
 * functions take a `Descriptor` in. It answers as a pipe does to qjs on
 * WASI: it has no position, so `tell` is -1 and a seek is ESPIPE, and
 * stdin takes no write (EINVAL).
 */
class Stream {
  readonly pos = -1
  readonly mode: OpenMode
  // What libc's stdio buffer holds for std.in: it fills a BUFSIZ at a
  // time, so os.read(0) after a FILE read finds what the buffer took
  // gone, as on WASI.
  private buffered: Uint8Array = new Uint8Array()

  constructor(
    readonly fd: 0 | 1 | 2,
    private readonly streams: QuickJsStreams,
  ) {
    this.mode = {
      readable: fd === 0,
      writable: fd !== 0,
      truncate: false,
      append: false,
      create: false,
      exclusive: false,
      binary: true,
    }
  }

  /** A FILE read: through the stdio buffer, until `size` bytes or the end. */
  async read(size: number | null = null): Promise<Uint8Array> {
    const want = size ?? -1
    if (want < 0) await this.fill(-1)
    while (want >= 0 && this.buffered.length < want)
      if (!(await this.fill(want - this.buffered.length))) break
    const take = want < 0 ? this.buffered.length : Math.min(want, this.buffered.length)
    const bytes = this.buffered.subarray(0, take)
    this.buffered = this.buffered.subarray(take)
    return bytes
  }

  /** A FILE line: through the stdio buffer, a BUFSIZ at a time. */
  async readLine(): Promise<Uint8Array | null> {
    for (;;) {
      const newline = this.buffered.indexOf(0x0a)
      if (newline >= 0) {
        const line = this.buffered.subarray(0, newline + 1)
        this.buffered = this.buffered.subarray(newline + 1)
        return line
      }
      if (!(await this.fill(BUFSIZ))) {
        const rest = this.buffered
        this.buffered = new Uint8Array()
        return rest.length === 0 ? null : rest
      }
    }
  }

  /** A descriptor read, `os.read`: past the stdio buffer. */
  rawRead(size: number): Promise<Uint8Array> {
    return this.streams.read(size)
  }

  // One read(2) of at most `size` bytes, whole BUFSIZ blocks; all for a
  // negative size. False once the input has ended.
  private async fill(size: number): Promise<boolean> {
    const more = await this.streams.read(size < 0 ? -1 : Math.max(BUFSIZ, size))
    if (more.length === 0) return false
    this.buffered = concat([this.buffered, more])
    return true
  }

  write(data: Uint8Array): Promise<void> {
    return this.fd === 0 ? Promise.resolve() : this.streams.write(this.fd, data)
  }

  land(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * Install the `std.open`/`os.readdir` host functions on an asyncified
 * quickjs context, backed by `RuntimeFiles`. A null `files` (no
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
 * @param sourceFiles - the runtime's mount vocabulary, or null when no mounts are wired
 */
export function installQuickJsFs(
  ctx: QuickJSAsyncContext,
  sourceFiles: RuntimeFiles | null,
  signal?: AbortSignal,
  streams?: QuickJsStreams,
): () => Promise<string[]> {
  const files = signal === undefined ? sourceFiles : (sourceFiles?.withSignal(signal) ?? null)
  // 0 to 2 are the standard streams and 3 the preopened root, as qjs on
  // WASI numbers them, so a guest's first open is 4.
  const table = new FileTable<Descriptor | Stream>(4)
  // qjs-libc's fopen opens a directory for reading, and every read of it
  // then fails: it answers nothing and sets the stream's error flag. A
  // read of zero bytes never reaches the stream, so it leaves the flag.
  const directories = new Set<number>()
  // A stream whose bytes the mount refused or failed to send: libc's
  // fread answers what it got and sets the error flag, so every read of
  // it fails the way a directory's does instead of throwing at the guest.
  const unreadable = new Set<number>()
  // A stream opened only to write (`w`, `a`): musl's fread fails on it
  // with EBADF, as on a directory, and clearerr does not change that.
  const writeOnly = new Set<number>()
  const failed = new Set<number>()
  const ended = new Set<number>()
  if (streams !== undefined) {
    for (const fd of [0, 1, 2] as const) table.set(fd, new Stream(fd, streams))
    writeOnly.add(1)
    writeOnly.add(2)
  }
  const readFails = (fd: number, size = -1): boolean => {
    if (!directories.has(fd) && !unreadable.has(fd) && !writeOnly.has(fd)) return false
    if (size === 0) return true
    failed.add(fd)
    return true
  }
  let cwd = PathSpec.fromStrPath('/')
  const absolute = (handle: QuickJSHandle): string => {
    const path = ctx.getString(handle)
    if (path === '') return ''
    const resolved = resolvePath(path, cwd.virtual)
    return resolved !== '/' && (path.endsWith('/') || path.endsWith('/.'))
      ? resolved + '/'
      : resolved
  }

  // The guest runs on the host's event loop, and a call a RAM mount
  // answers settles without ever leaving the microtask queue, so a guest
  // looping over files would hold the loop until it ended: another
  // session's I/O and timers wait. Every async call gives the loop a turn
  // once its time slice is spent.
  const budget = new YieldBudget()
  const defineAsync = (
    name: string,
    fn: (...args: QuickJSHandle[]) => Promise<QuickJSHandle>,
  ): void => {
    const handle = ctx.newAsyncifiedFunction(name, async (...args) => {
      signal?.throwIfAborted()
      await budget.run()
      signal?.throwIfAborted()
      const out = await fn(...args)
      if (signal?.aborted === true) {
        out.dispose()
        signal.throwIfAborted()
      }
      return out
    })
    ctx.setProp(ctx.global, name, handle)
    handle.dispose()
  }

  const defineSync = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle): void => {
    const handle = ctx.newFunction(name, (...args) => {
      signal?.throwIfAborted()
      return fn(...args)
    })
    ctx.setProp(ctx.global, name, handle)
    handle.dispose()
  }

  // A descriptor on the run's core for `path`, or -errno. A read-only open
  // of a directory gives one every read of which fails, as libc's does.
  const openFd = async (path: string, mode: OpenMode): Promise<number> => {
    if (files?.serves(path) !== true) return -ENOENT
    let file: Descriptor
    let directory = false
    try {
      try {
        file = new Descriptor(files, await files.open(path, mode), mode, path)
      } catch (err) {
        if (mode.writable || classify(err) !== 'EISDIR') throw err
        file = new Descriptor(
          files,
          await files.open(path, { ...mode, directory: true }),
          mode,
          path,
          true,
        )
        directory = true
      }
    } catch (err) {
      return -errnoFor(err)
    }
    const fd = table.add(file)
    if (directory) directories.add(fd)
    if (!mode.readable) writeOnly.add(fd)
    return fd
  }

  defineSync('__mirage_getcwd', () => ctx.newString(cwd.virtual))

  defineAsync('__mirage_chdir', async (pathH) => {
    const path = absolute(pathH)
    if (path !== '/') {
      if (path === '' || files === null) return ctx.newNumber(-ENOENT)
      try {
        const st = await files.viewStat(path)
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
    // The mode as the real engine reads it: qjs-libc throws TypeError for
    // a letter outside `rwa+bx` before any open (null tells the bootstrap
    // to raise it, since a host throw would not arrive typed), and musl's
    // fopen then reads only the first letter and whether `+` and `x`
    // appear, so `rr` opens like `r`. Any other refusal answers -errno,
    // which the bootstrap hands to the guest's errorObj.
    const spelled = ctx.getString(modeH)
    if (!/^[rwa+bx]*$/.test(spelled)) return ctx.null
    // An empty mode passes musl's first-letter check (strchr finds the
    // string's terminator) and opens for writing, creating the file.
    const first = spelled.charAt(0)
    if (first !== '' && !'rwa'.includes(first)) return ctx.newNumber(-WASI.EINVAL)
    const plus = spelled.includes('+')
    const mode: OpenMode = {
      readable: plus || first === 'r',
      writable: plus || first !== 'r',
      truncate: first === 'w',
      append: first === 'a',
      create: first !== 'r',
      exclusive: first !== 'r' && spelled.includes('x'),
      binary: spelled.includes('b'),
    }
    // The open's effect lands through the mount at open, by the rule
    // every entry point shares (`MountCore.open`), so write modes and a
    // read-narrowed session refuse here (the guest gets null), the ledger
    // records the real op, and a backend with a native truncate receives
    // it. Any refusal or failure is the guest's null: a transient failure
    // or a policy denial on an existing file must refuse the open, or a
    // create-capable mode would create over content this open never saw.
    return ctx.newNumber(await openFd(path, mode))
  })

  // os.open's flags, in the wasi-libc numbering the real engine on WASI
  // spells its os.O_* constants in; a descriptor shares std.open's table.
  defineAsync('__mirage_os_open', async (pathH, flagsH) => {
    const flags = ctx.getNumber(flagsH)
    const writable = (flags & O_WRONLY) !== 0
    const mode: OpenMode = {
      readable: (flags & O_RDONLY) !== 0 || !writable,
      writable,
      truncate: (flags & O_TRUNC) !== 0,
      append: (flags & O_APPEND) !== 0,
      create: (flags & O_CREAT) !== 0,
      exclusive: (flags & O_EXCL) !== 0,
      binary: true,
    }
    return ctx.newNumber(await openFd(absolute(pathH), mode))
  })

  defineAsync('__mirage_flush', async (fdH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    if (file === undefined) return ctx.newNumber(-WASI.EBADF)
    try {
      await file.land()
      return ctx.newNumber(0)
    } catch (err) {
      failed.add(fd)
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_close', async (fdH) => {
    const fd = ctx.getNumber(fdH)
    directories.delete(fd)
    unreadable.delete(fd)
    writeOnly.delete(fd)
    failed.delete(fd)
    ended.delete(fd)
    const file = table.pop(fd)
    if (file === undefined) return ctx.newNumber(-WASI.EBADF)
    try {
      await file.close()
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_readdir', (pathH) => readdir(ctx, files, absolute(pathH)))

  defineAsync('__mirage_read', async (fdH, maxH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    const size = ctx.getNumber(maxH)
    if (file === undefined || readFails(fd, size)) return ctx.newString('')
    try {
      const bytes = await file.read(size)
      if (size < 0 || bytes.length < size) ended.add(fd)
      return toGuestText(ctx, DEC.decode(bytes))
    } catch (err) {
      console.debug(`quickjs: read of fd ${String(fd)} failed: ${String(err)}`)
      unreadable.add(fd)
      failed.add(fd)
      return ctx.newString('')
    }
  })

  defineAsync('__mirage_read_bytes', async (fdH, maxH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    const size = ctx.getNumber(maxH)
    let bytes = new Uint8Array(0)
    if (file !== undefined && !readFails(fd, size)) {
      try {
        const got = await file.read(size)
        bytes = size < 0 ? got.slice() : got.slice(0, size)
        if (size < 0 || bytes.length < size) ended.add(fd)
      } catch (err) {
        console.debug(`quickjs: read of fd ${String(fd)} failed: ${String(err)}`)
        unreadable.add(fd)
        failed.add(fd)
      }
    }
    return ctx.newArrayBuffer(bytes.slice().buffer)
  })

  defineAsync('__mirage_getline', async (fdH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    if (file === undefined || readFails(fd)) return ctx.null
    try {
      const line = await file.readLine()
      // A line with no newline ran into the end of the file.
      const newline = line?.at(-1) === 0x0a
      if (!newline) ended.add(fd)
      if (line === null) return ctx.null
      return toGuestText(ctx, DEC.decode(newline ? line.subarray(0, -1) : line))
    } catch (err) {
      console.debug(`quickjs: read of fd ${String(fd)} failed: ${String(err)}`)
      unreadable.add(fd)
      failed.add(fd)
      return ctx.null
    }
  })

  defineSync('__mirage_ferror', (fdH) => (failed.has(ctx.getNumber(fdH)) ? ctx.true : ctx.false))

  defineSync('__mirage_clearerr', (fdH) => {
    // A cleared stream reads again, so a fetch that failed is tried anew.
    unreadable.delete(ctx.getNumber(fdH))
    failed.delete(ctx.getNumber(fdH))
    ended.delete(ctx.getNumber(fdH))
    return ctx.undefined
  })

  // A write the core refuses (a mount that went read-only under the
  // stream) is the stream's error, as libc's fputs sets it.
  defineAsync('__mirage_write', async (fdH, textH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    if (file?.mode.writable !== true) return ctx.undefined
    try {
      await file.write(ENC.encode(fromGuestText(ctx, textH)))
    } catch (err) {
      console.debug(`quickjs: write of fd ${String(fd)} failed: ${String(err)}`)
      failed.add(fd)
    }
    return ctx.undefined
  })

  defineAsync('__mirage_write_bytes', async (fdH, bufferH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    if (file?.mode.writable !== true) return ctx.newNumber(0)
    const bytes = ctx.getArrayBuffer(bufferH).consume((view) => view.value.slice())
    try {
      await file.write(bytes)
    } catch (err) {
      console.debug(`quickjs: write of fd ${String(fd)} failed: ${String(err)}`)
      failed.add(fd)
      return ctx.newNumber(0)
    }
    return ctx.newNumber(bytes.length)
  })

  // os.read and os.write answer -errno where the FILE calls set the
  // stream's error flag: EBADF for a descriptor that is not open for it.
  defineAsync('__mirage_os_read', async (fdH, sizeH) => {
    const fd = ctx.getNumber(fdH)
    const file = table.get(fd)
    if (file === undefined || writeOnly.has(fd)) return ctx.newNumber(-WASI.EBADF)
    if (directories.has(fd)) return ctx.newNumber(-WASI.EISDIR)
    const size = ctx.getNumber(sizeH)
    if (file instanceof Stream) return ctx.newArrayBuffer((await file.rawRead(size)).slice().buffer)
    try {
      return ctx.newArrayBuffer((await file.read(size)).slice(0, size).buffer)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_os_write', async (fdH, bufferH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file instanceof Stream && file.fd === 0) return ctx.newNumber(-WASI.EINVAL)
    if (file?.mode.writable !== true) return ctx.newNumber(-WASI.EBADF)
    const bytes = ctx.getArrayBuffer(bufferH).consume((view) => view.value.slice())
    try {
      await file.write(bytes)
      return ctx.newNumber(bytes.length)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  // 0, or -errno as the real engine's FILE.seek answers: a target before
  // the start or an unknown whence is EINVAL and leaves the position.
  defineAsync('__mirage_seek', async (fdH, offsetH, whenceH) => {
    const file = table.get(ctx.getNumber(fdH))
    if (file === undefined) return ctx.newNumber(-WASI.EBADF)
    if (file instanceof Stream) return ctx.newNumber(-ESPIPE)
    let moved: number | null
    try {
      moved = await file.seek(ctx.getNumber(offsetH), ctx.getNumber(whenceH))
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
    if (moved !== null) ended.delete(ctx.getNumber(fdH))
    return ctx.newNumber(moved === null ? -WASI.EINVAL : 0)
  })

  defineSync('__mirage_tell', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    return ctx.newNumber(file === undefined ? -1 : file.pos)
  })

  defineSync('__mirage_eof', (fdH) => {
    const file = table.get(ctx.getNumber(fdH))
    const atEof = file === undefined || ended.has(ctx.getNumber(fdH))
    return atEof ? ctx.true : ctx.false
  })

  // The os.* mutation surface, matching the real engine's conventions
  // (pinned live against qjs-wasi through the python runtime): 0 on
  // success, -errno on failure in WASI numbering; os.remove takes
  // files and empty directories; os.stat answers [obj, errno].
  defineAsync('__mirage_remove', async (pathH) => {
    const path = absolute(pathH)
    if (files?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    try {
      // A link goes as the name it is, never as what it points at: remove
      // on a link to a directory drops the link and leaves the directory.
      // A file open there keeps what it held (the core sees to it).
      const st = await files.stat(path, true)
      if (st.isDir && st.isLink !== true) await files.rmdir(path)
      else await files.unlink(path)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_mkdir', async (pathH) => {
    const path = absolute(pathH)
    if (files?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    try {
      await files.mkdir(path)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_utimes', async (pathH, atimeH, mtimeH) => {
    const path = absolute(pathH)
    if (files?.serves(path) !== true) return ctx.newNumber(-ENOENT)
    // The engine's stamps are milliseconds (qjs-libc splits them into
    // tv_sec/tv_nsec at 1000), and the op takes ISO text.
    const atime = epochToIso(ctx.getNumber(atimeH) / 1000)
    const mtime = epochToIso(ctx.getNumber(mtimeH) / 1000)
    try {
      await files.setattr(path, { atime, mtime })
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_rename', async (srcH, dstH) => {
    const src = absolute(srcH)
    const dst = absolute(dstH)
    if (files?.serves(src) !== true || !files.serves(dst)) return ctx.newNumber(-ENOENT)
    // The dispatcher refuses a pair on different mounts with EXDEV, which this
    // engine numbers -75, as the real engine does. The streams open on
    // either end follow the rename (the core sees to it).
    try {
      await files.rename(src, dst)
      return ctx.newNumber(0)
    } catch (err) {
      return ctx.newNumber(-errnoFor(err))
    }
  })

  defineAsync('__mirage_stat', (pathH) => stat(ctx, files, absolute(pathH)))

  return async () => {
    const failures: string[] = []
    for (const file of [...table.values()]) {
      if (file instanceof Stream) continue
      // Through the run's own adapter, past its signal: a process's writes
      // are in its files however it ended.
      try {
        await sourceFiles?.close(file.fd)
      } catch (err) {
        failures.push(`${file.opened}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return failures
  }
}

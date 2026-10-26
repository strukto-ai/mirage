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

import { enoent, enotdir } from '../../errors/fs.ts'
import { errnoFor } from '../../errors/wasi.ts'
import { FileTable } from '../handles/file_table.ts'
import type { OpenMode } from '../handles/mode.ts'
import { posixStat } from '../stat.ts'
import type { VFSStat } from '../types.ts'
import { posixNormpath } from '../../utils/path.ts'
import { CHAR_MODE } from '../../utils/stat_view.ts'
import {
  FDFLAG_APPEND,
  FST_ATIM,
  FST_ATIM_NOW,
  FST_MTIM,
  FST_MTIM_NOW,
  FT_CHR,
  FT_DIR,
  FT_REG,
  LOOKUP_SYMLINK_FOLLOW,
  OFLAG_CREAT,
  OFLAG_DIRECTORY,
  OFLAG_EXCL,
  OFLAG_TRUNC,
  RIGHT_FD_READ,
  RIGHT_FD_WRITE,
} from './constants.ts'
import { EBADF, EINVAL, ELOOP, ENOENT, ENOTDIR, EPIPE, ESPIPE, LINK_REFUSAL, OK } from './errors.ts'
import { packDirent } from './list.ts'
import { filetypeOf, packFdstat, packFilestat, packPrestat } from './stat.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type FdKind = 'stdin' | 'stdout' | 'stderr' | 'dir' | 'file'

/**
 * One open file the run's view handed out, answered by the host: the
 * guest's twin of the `Descriptor` it holds there, each call made
 * synchronously across the bridge.
 */
export interface GuestFile {
  readonly mode: OpenMode
  /** The path it was opened at. */
  readonly opened: string
  /** Where the links on `opened` led as it opened, which names its inode. */
  readonly inode: string
  /** The path its file has now; a rename moves it. */
  path(): string
  position(): number
  size(): number
  read(size: number): Uint8Array
  pread(offset: number, size: number): Uint8Array
  write(data: Uint8Array): void
  pwrite(offset: number, data: Uint8Array): void
  seek(offset: number, whence: number): number | null
  truncate(size: number): void
  land(): void
  close(): void
  /** The core's row for it, the size it holds counted. */
  fstat(): VFSStat
  /** Whether the name its file had went, so the file has no link left. */
  unlinked(): boolean
}

/** The run's `WasmView`, answered synchronously across the bridge. */
export interface GuestView {
  stat(path: string): VFSStat
  lstat(path: string): VFSStat
  statOrNull(path: string, nofollow?: boolean): VFSStat | null
  open(path: string, mode: OpenMode): GuestFile
  unlink(path: string): void
  mkdir(path: string): void
  rmdir(path: string): void
  rename(src: string, dst: string): void
  symlink(path: string, target: string): void
  walked(path: string, follow?: boolean): string
  readlink(path: string): string
  setattr(path: string, atime: string | null, mtime: string | null, nofollow: boolean): void
  readdir(path: string): [string, number][]
}

/** What ends a guest from inside a host call: `proc_exit`, or a stop met
 * while the guest waited. The run's caller catches it out of `_start`. */
export class GuestExit extends Error {
  constructor(readonly code: number) {
    super(`the guest exited ${String(code)}`)
    this.name = 'GuestExit'
  }
}

/** One utimensat stamp as ISO text, null when the call omits it. preview1
 * splits each of the two stamps into "write the argument" and "write the
 * host clock" bits, and neither set is UTIME_OMIT: leave that field alone. */
function stamp(
  fstFlags: number,
  setBit: number,
  nowBit: number,
  value: bigint,
  now: number,
): string | null {
  if ((fstFlags & nowBit) !== 0) return new Date(now).toISOString()
  if ((fstFlags & setBit) !== 0) return new Date(Number(value / 1_000_000n)).toISOString()
  return null
}

/** The open facts preview1 spells as oflags, rights and fdflags. */
function openMode(oflags: number, rightsBase: bigint, fdflags: number): OpenMode {
  const create = (oflags & OFLAG_CREAT) !== 0
  const truncate = (oflags & OFLAG_TRUNC) !== 0
  const append = (fdflags & FDFLAG_APPEND) !== 0
  return {
    readable: (rightsBase & RIGHT_FD_READ) !== 0n,
    writable: create || truncate || append || (rightsBase & RIGHT_FD_WRITE) !== 0n,
    truncate,
    append,
    create,
    exclusive: create && (oflags & OFLAG_EXCL) !== 0,
    binary: true,
  }
}

/** A clock reading in nanoseconds: 0 is the epoch clock, 1 monotonic. */
function clockNs(clock: number): bigint {
  const ms = clock === 0 ? performance.timeOrigin + performance.now() : performance.now()
  const whole = Math.floor(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000))
}

/** One guest fd: a directory, a stdio stream, or a file. Mirrors Python's `FdEntry`. */
class FdEntry {
  constructor(
    readonly kind: FdKind,
    public file: GuestFile | null = null,
    readonly pipe: ((size: number) => Uint8Array) | null = null,
    readonly path = '',
    readonly preopen = false,
    public dirents: [string, number][] | null = null,
    readonly opened = '',
    readonly readable = true,
  ) {}

  /** Read from the position, advancing it. */
  read(size: number): Uint8Array {
    if (this.file !== null) return this.file.read(size)
    if (this.pipe !== null) return size > 0 ? this.pipe(size) : new Uint8Array()
    return new Uint8Array()
  }

  /** Read at an explicit offset without moving the position. */
  pread(offset: number, size: number): Uint8Array {
    return this.file === null ? new Uint8Array() : this.file.pread(offset, size)
  }

  /** Where the next read or write lands. */
  position(): number {
    return this.file === null ? 0 : this.file.position()
  }

  /** The file's length, what was written and not landed counted. */
  size(): number {
    return this.file === null ? 0 : this.file.size()
  }
}

/**
 * Preview1 host functions over the run's view. One per run: it owns the
 * guest fd table (stdin, stdout and stderr plus one preopen at "/"),
 * keeps each open file's writes on the host until its close (or the
 * guest's exit), and translates the preview1 ABI (iovecs, filestats,
 * dirents) for the view. Mirrors Python's `WasiFs`, the args, environment
 * and clock calls included, which wasmtime serves natively there.
 *
 * @param fs - the files the guest sees.
 * @param stdin - reads the guest's input as a pipe does; null gives it none.
 * @param output - takes each stdout or stderr write as the guest makes it,
 *   the guest waiting until it is taken; false once its reader has gone.
 * @param wait - holds the guest for a poll's delay; true when the run was
 *   stopped while it waited.
 * @param argv - the guest's argv, its program name first.
 * @param env - its environment as `NAME=value` entries.
 */
export class WasiFs {
  exitCode: number | null = null
  memory: WebAssembly.Memory | null = null
  private readonly fds = new FileTable<FdEntry>(4)

  constructor(
    private readonly fs: GuestView,
    stdin: ((size: number) => Uint8Array) | null,
    private readonly output: (fd: 1 | 2, bytes: Uint8Array) => boolean,
    private readonly wait: (ms: number) => boolean,
    private readonly argv: readonly string[],
    private readonly env: readonly string[],
  ) {
    this.fds.set(0, new FdEntry('stdin', null, stdin ?? (() => new Uint8Array())))
    this.fds.set(1, new FdEntry('stdout'))
    this.fds.set(2, new FdEntry('stderr'))
    this.fds.set(3, new FdEntry('dir', null, null, '/', true))
  }

  // -- guest memory -------------------------------------------------------

  private bytes(): Uint8Array {
    if (this.memory === null) throw new Error('wasm module exports no memory')
    return new Uint8Array(this.memory.buffer)
  }

  private data(): DataView {
    return new DataView(this.bytes().buffer)
  }

  private load(ptr: number, n: number): Uint8Array {
    return this.bytes().slice(ptr, ptr + n)
  }

  private store(ptr: number, data: Uint8Array): void {
    this.bytes().set(data, ptr)
  }

  private storeU32(ptr: number, value: number): void {
    this.data().setUint32(ptr, value, true)
  }

  private storeU64(ptr: number, value: bigint): void {
    this.data().setBigUint64(ptr, value, true)
  }

  private iovs(ptr: number, count: number): [number, number][] {
    const view = this.data()
    const out: [number, number][] = []
    for (let i = 0; i < count; i++)
      out.push([view.getUint32(ptr + i * 8, true), view.getUint32(ptr + i * 8 + 4, true)])
    return out
  }

  private pathArg(dirfd: number, ptr: number, length: number): string | null {
    const entry = this.fds.get(dirfd)
    if (entry?.kind !== 'dir') return null
    const rel = DEC.decode(this.load(ptr, length))
    if (rel === '') throw enoent(rel)
    const joined = rel.startsWith('/') ? rel : `${entry.path.replace(/\/$/, '')}/${rel}`
    const parts = joined.split('/')
    for (const [index, part] of parts.entries()) {
      if ((part === '.' || part === '..') && index > 1) {
        const ancestor = parts.slice(0, index).join('/')
        if (!this.fs.stat(ancestor).isDir) throw enotdir(ancestor)
      }
    }
    const trailing = joined.endsWith('/') || joined.endsWith('/.')
    const normed = posixNormpath(this.fs.walked(joined, false))
    if (trailing && normed !== '/') {
      const row = this.fs.statOrNull(normed)
      if (row !== null && !row.isDir) throw enotdir(joined)
    }
    const lexical = posixNormpath(joined)
    let requested = parts.includes('..') && normed !== lexical ? joined : lexical
    if (trailing && requested !== '/') requested = `${requested.replace(/\/+$/, '')}/`
    return requested.startsWith('/') ? requested : `/${requested}`
  }

  // -- fd lookups ---------------------------------------------------------

  /** The entry under `fd` when it reads: a file's, or stdin. */
  private readableEntry(fd: number): FdEntry | null {
    const entry = this.fds.get(fd)
    if (entry === undefined || (entry.kind !== 'file' && entry.kind !== 'stdin')) return null
    return entry.readable ? entry : null
  }

  /** The mount file under `fd` when its open asked to write. */
  private writer(fd: number): GuestFile | null {
    const file = this.fds.get(fd)?.file ?? null
    return file?.mode.writable === true ? file : null
  }

  // -- process ------------------------------------------------------------

  proc_exit(code: number): never {
    this.exitCode = code & 255
    throw new GuestExit(this.exitCode)
  }

  private strings(ptrs: number, buf: number, items: readonly string[]): number {
    let at = buf
    for (const [index, item] of items.entries()) {
      const encoded = ENC.encode(`${item}\0`)
      this.storeU32(ptrs + index * 4, at)
      this.store(at, encoded)
      at += encoded.byteLength
    }
    return OK
  }

  private sizes(countPtr: number, sizePtr: number, items: readonly string[]): number {
    this.storeU32(countPtr, items.length)
    this.storeU32(
      sizePtr,
      items.reduce((total, item) => total + ENC.encode(item).byteLength + 1, 0),
    )
    return OK
  }

  args_get(ptrs: number, buf: number): number {
    return this.strings(ptrs, buf, this.argv)
  }

  args_sizes_get(count: number, size: number): number {
    return this.sizes(count, size, this.argv)
  }

  environ_get(ptrs: number, buf: number): number {
    return this.strings(ptrs, buf, this.env)
  }

  environ_sizes_get(count: number, size: number): number {
    return this.sizes(count, size, this.env)
  }

  random_get(ptr: number, length: number): number {
    const out = new Uint8Array(length)
    for (let at = 0; at < length; at += 65536) crypto.getRandomValues(out.subarray(at, at + 65536))
    this.store(ptr, out)
    return OK
  }

  sched_yield(): number {
    return OK
  }

  clock_time_get(clock: number, _precision: bigint, result: number): number {
    if (clock !== 0 && clock !== 1) return EINVAL
    this.storeU64(result, clockNs(clock))
    return OK
  }

  clock_res_get(clock: number, result: number): number {
    if (clock !== 0 && clock !== 1) return EINVAL
    this.storeU64(result, 1000n)
    return OK
  }

  poll_oneoff(incoming: number, outgoing: number, count: number, nevents: number): number {
    if (count <= 0) return EINVAL
    const subscriptions = new DataView(this.load(incoming, count * 48).buffer)
    const now = clockNs(1)
    const events: [bigint, Uint8Array][] = []
    for (let offset = 0; offset < count * 48; offset += 48) {
      const userdata = subscriptions.getBigUint64(offset, true)
      const kind = subscriptions.getUint8(offset + 8)
      let [error, nbytes, deadline] = [OK, 0, now]
      if (kind === 0) {
        const clock = subscriptions.getUint32(offset + 16, true)
        const timeout = subscriptions.getBigUint64(offset + 24, true)
        const flags = subscriptions.getUint16(offset + 40, true)
        if ((clock !== 0 && clock !== 1) || (flags & ~1) !== 0) error = EINVAL
        else {
          let remaining = timeout
          if ((flags & 1) !== 0) remaining -= clock === 0 ? clockNs(0) : now
          deadline = now + (remaining > 0n ? remaining : 0n)
        }
      } else if (kind === 1 || kind === 2) {
        const fd = subscriptions.getUint32(offset + 16, true)
        const entry = this.fds.get(fd)
        if (entry === undefined || entry.kind === 'dir') error = EBADF
        else if (kind === 1) {
          if ((entry.file === null && entry.pipe === null) || !entry.readable) error = EBADF
          else nbytes = Math.max(0, entry.size() - entry.position())
        } else if (
          entry.kind === 'stdin' ||
          (entry.kind === 'file' && entry.file?.mode.writable !== true)
        )
          error = EBADF
      } else return EINVAL
      const event = new Uint8Array(32)
      const view = new DataView(event.buffer)
      view.setBigUint64(0, userdata, true)
      view.setUint16(8, error, true)
      view.setUint8(10, kind)
      view.setBigUint64(16, BigInt(nbytes), true)
      events.push([deadline, event])
    }
    const soonest = events.reduce((least, [at]) => (at < least ? at : least), events[0]?.[0] ?? now)
    const delay = soonest - clockNs(1)
    if (this.wait(delay > 0n ? Number(delay / 1_000_000n) : 0)) {
      this.exitCode = 130
      throw new GuestExit(130)
    }
    const after = clockNs(1)
    const ready = events.filter(([at]) => at <= after).map(([, event]) => event)
    let at = outgoing
    for (const event of ready) {
      this.store(at, event)
      at += event.byteLength
    }
    this.storeU32(nevents, ready.length)
    return OK
  }

  // -- prestat ------------------------------------------------------------

  fd_prestat_get(fd: number, buf: number): number {
    const entry = this.fds.get(fd)
    if (entry?.preopen !== true) return EBADF
    this.store(buf, packPrestat(ENC.encode(entry.path).byteLength))
    return OK
  }

  fd_prestat_dir_name(fd: number, ptr: number, length: number): number {
    const entry = this.fds.get(fd)
    if (entry?.preopen !== true) return EBADF
    this.store(ptr, ENC.encode(entry.path).subarray(0, length))
    return OK
  }

  // -- open/close ---------------------------------------------------------

  path_open(
    dirfd: number,
    dirflags: number,
    ptr: number,
    length: number,
    oflags: number,
    rightsBase: bigint,
    _rightsInherit: bigint,
    fdflags: number,
    out: number,
  ): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    if ((dirflags & LOOKUP_SYMLINK_FOLLOW) === 0) {
      const row = this.fs.statOrNull(path, true)
      if (row?.isLink === true) return ELOOP
    }
    if ((oflags & OFLAG_DIRECTORY) !== 0) {
      const st = this.fs.statOrNull(path)
      if (st === null) return ENOENT
      if (!st.isDir) return ENOTDIR
      return this.openDir(path, out)
    }
    const mode = openMode(oflags, rightsBase, fdflags)
    let file: GuestFile
    try {
      file = this.fs.open(path, mode)
    } catch (err) {
      // POSIX opens a directory read-only without O_DIRECTORY too; only a
      // mode that would write refuses it.
      if ((err as { code?: unknown }).code !== 'EISDIR' || mode.writable) throw err
      return this.openDir(path, out)
    }
    const fd = this.fds.add(new FdEntry('file', file, null, '', false, null, path, mode.readable))
    this.storeU32(out, fd)
    return OK
  }

  private openDir(path: string, out: number): number {
    this.storeU32(out, this.fds.add(new FdEntry('dir', null, null, path)))
    return OK
  }

  fd_close(fd: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined || entry.preopen) return EBADF
    this.fds.pop(fd)
    entry.file?.close()
    return OK
  }

  /**
   * Send what every file the guest left open still owes the mount. A
   * process's writes are in its files whether or not it closed them, so
   * the guest's exit flushes each open file the way a close would. One
   * that fails does not stop the rest.
   *
   * @returns one line per file whose writes could not land.
   */
  closeAll(): string[] {
    const failures: string[] = []
    for (const entry of this.fds.values()) {
      const file = entry.file
      entry.file = null
      if (file === null) continue
      try {
        file.close()
      } catch (err) {
        failures.push(`${entry.opened}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return failures
  }

  fd_renumber(fd: number, to: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined) return EBADF
    if (fd === to) return OK
    this.fd_close(to)
    this.fds.pop(fd)
    this.fds.set(to, entry)
    return OK
  }

  // -- read/write/seek ----------------------------------------------------

  private scatter(vectors: [number, number][], data: Uint8Array, nread: number): number {
    let total = 0
    for (const [bptr, blen] of vectors) {
      const chunk = data.subarray(total, total + blen)
      if (chunk.byteLength > 0) this.store(bptr, chunk)
      total += chunk.byteLength
      if (chunk.byteLength < blen) break
    }
    this.storeU32(nread, total)
    return OK
  }

  fd_read(fd: number, iovs: number, count: number, nread: number): number {
    const entry = this.readableEntry(fd)
    if (entry === null) return EBADF
    const vectors = this.iovs(iovs, count)
    const data = entry.read(vectors.reduce((sum, [, length]) => sum + length, 0))
    return this.scatter(vectors, data, nread)
  }

  fd_pread(fd: number, iovs: number, count: number, offset: bigint, nread: number): number {
    const entry = this.readableEntry(fd)
    if (entry?.kind !== 'file') return EBADF
    const vectors = this.iovs(iovs, count)
    const data = entry.pread(
      Number(offset),
      vectors.reduce((sum, [, length]) => sum + length, 0),
    )
    return this.scatter(vectors, data, nread)
  }

  fd_write(fd: number, iovs: number, count: number, nwritten: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined) return EBADF
    let total = 0
    for (const [bptr, blen] of this.iovs(iovs, count)) {
      const data = this.load(bptr, blen)
      if (entry.kind === 'stdout' || entry.kind === 'stderr') {
        if (!this.output(entry.kind === 'stdout' ? 1 : 2, data)) return EPIPE
      } else if (entry.kind === 'file') {
        if (entry.file?.mode.writable !== true) return EBADF
        entry.file.write(data)
      } else return EINVAL
      total += blen
    }
    this.storeU32(nwritten, total)
    return OK
  }

  fd_pwrite(fd: number, iovs: number, count: number, offset: bigint, nwritten: number): number {
    const file = this.writer(fd)
    if (file === null) return EBADF
    let [total, pos] = [0, Number(offset)]
    for (const [bptr, blen] of this.iovs(iovs, count)) {
      file.pwrite(pos, this.load(bptr, blen))
      pos += blen
      total += blen
    }
    this.storeU32(nwritten, total)
    return OK
  }

  fd_seek(fd: number, offset: bigint, whence: number, out: number): number {
    if (fd === 0 || fd === 1 || fd === 2) return ESPIPE
    const entry = this.fds.get(fd)
    if (entry?.kind !== 'file' || entry.file === null) return EBADF
    // preview1's WHENCE_* numbering is POSIX's 0/1/2, which seek speaks.
    const pos = entry.file.seek(Number(offset), whence)
    if (pos === null) return EINVAL
    this.storeU64(out, BigInt(pos))
    return OK
  }

  fd_tell(fd: number, out: number): number {
    if (fd === 0 || fd === 1 || fd === 2) return ESPIPE
    const entry = this.fds.get(fd)
    if (entry?.kind !== 'file') return EBADF
    this.storeU64(out, BigInt(entry.position()))
    return OK
  }

  // -- stat ---------------------------------------------------------------

  fd_fdstat_get(fd: number, buf: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined) return EBADF
    const filetype = entry.kind === 'dir' ? FT_DIR : entry.kind === 'file' ? FT_REG : FT_CHR
    this.store(buf, packFdstat(filetype))
    return OK
  }

  fd_filestat_get(fd: number, buf: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined) return EBADF
    let packed: Uint8Array
    if (entry.kind === 'file' && entry.file !== null) {
      // The core's row, its size the handle's, which counts what it wrote
      // and has not landed.
      const posix = posixStat(entry.file.fstat(), entry.file.inode, '/')
      packed = packFilestat(entry.file.unlinked() ? { ...posix, nlink: 0 } : posix, FT_REG)
    } else if (entry.kind === 'dir') {
      packed = packFilestat(posixStat(this.fs.stat(entry.path), entry.path, '/'), FT_DIR)
    } else {
      const stream: VFSStat = { size: 0, isDir: false, mode: CHAR_MODE }
      packed = packFilestat(posixStat(stream, `/dev/fd/${String(fd)}`, '/'), FT_CHR)
    }
    this.store(buf, packed)
    return OK
  }

  path_filestat_get(
    dirfd: number,
    flags: number,
    ptr: number,
    length: number,
    buf: number,
  ): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    // The follow bit is how a guest spells stat versus lstat, so it is read
    // rather than ignored.
    const follow = (flags & LOOKUP_SYMLINK_FOLLOW) !== 0 || path.endsWith('/')
    const st = follow ? this.fs.stat(path) : this.fs.lstat(path)
    if (path.endsWith('/') && !st.isDir) return ENOTDIR
    this.store(buf, packFilestat(posixStat(st, path, '/'), filetypeOf(st)))
    return OK
  }

  fd_filestat_set_size(fd: number, size: bigint): number {
    const file = this.writer(fd)
    if (file === null) return EBADF
    file.truncate(Number(size))
    return OK
  }

  // -- readdir ------------------------------------------------------------

  fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, used: number): number {
    const entry = this.fds.get(fd)
    if (entry?.kind !== 'dir') return EBADF
    entry.dirents ??= this.fs.readdir(entry.path)
    const out: Uint8Array[] = []
    let filled = 0
    for (let i = Number(cookie); i < entry.dirents.length && filled < bufLen; i++) {
      const dirent = entry.dirents[i]
      if (dirent === undefined) break
      const [name, filetype] = dirent
      const record = packDirent(i, ENC.encode(name), filetype).subarray(0, bufLen - filled)
      out.push(record)
      filled += record.byteLength
    }
    let at = buf
    for (const record of out) {
      this.store(at, record)
      at += record.byteLength
    }
    this.storeU32(used, filled)
    return OK
  }

  // -- fs mutation --------------------------------------------------------

  path_unlink_file(dirfd: number, ptr: number, length: number): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    this.fs.unlink(path)
    return OK
  }

  path_create_directory(dirfd: number, ptr: number, length: number): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    this.fs.mkdir(path)
    return OK
  }

  path_remove_directory(dirfd: number, ptr: number, length: number): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    this.fs.rmdir(path)
    return OK
  }

  path_rename(
    dirfd: number,
    ptr: number,
    length: number,
    dstDirfd: number,
    dstPtr: number,
    dstLength: number,
  ): number {
    const src = this.pathArg(dirfd, ptr, length)
    const dst = this.pathArg(dstDirfd, dstPtr, dstLength)
    if (src === null || dst === null) return EBADF
    this.fs.rename(src, dst)
    return OK
  }

  // -- stubs and no-ops ---------------------------------------------------

  fd_advise(): number {
    return OK
  }

  fd_datasync(fd: number): number {
    return this.fd_sync(fd)
  }

  fd_sync(fd: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined) return EBADF
    entry.file?.land()
    return OK
  }

  fd_fdstat_set_flags(): number {
    return OK
  }

  /** Store the stamps a utimensat-shaped call selects. */
  private setTimes(
    path: string,
    atim: bigint,
    mtim: bigint,
    fstFlags: number,
    nofollow: boolean,
  ): void {
    const now = Date.now()
    const atime = stamp(fstFlags, FST_ATIM, FST_ATIM_NOW, atim, now)
    const mtime = stamp(fstFlags, FST_MTIM, FST_MTIM_NOW, mtim, now)
    // No stamp selected is a no-op, not an error: utimensat(2) with two
    // UTIME_OMIT values does nothing and succeeds.
    if (atime === null && mtime === null) return
    this.fs.setattr(path, atime, mtime, nofollow)
  }

  fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, flags: number): number {
    const entry = this.fds.get(fd)
    if (entry === undefined || (entry.kind !== 'file' && entry.kind !== 'dir')) return EBADF
    // Writes any fd on the file still owes land first (the core sees to
    // it), or landing them at a close would stamp over the times set here.
    this.setTimes(entry.file === null ? entry.path : entry.file.path(), atim, mtim, flags, false)
    return OK
  }

  path_filestat_set_times(
    dirfd: number,
    flags: number,
    ptr: number,
    length: number,
    atim: bigint,
    mtim: bigint,
    fstFlags: number,
  ): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    this.setTimes(path, atim, mtim, fstFlags, (flags & LOOKUP_SYMLINK_FOLLOW) === 0)
    return OK
  }

  path_readlink(
    dirfd: number,
    ptr: number,
    length: number,
    buf: number,
    bufLen: number,
    used: number,
  ): number {
    const path = this.pathArg(dirfd, ptr, length)
    if (path === null) return EBADF
    const raw = ENC.encode(this.fs.readlink(path)).subarray(0, bufLen)
    this.store(buf, raw)
    // preview1 truncates rather than refusing a short buffer, and reports
    // what it wrote; a guest that wants the whole target retries with a
    // bigger one, which is what wasi-libc does.
    this.storeU32(used, raw.byteLength)
    return OK
  }

  path_link(): number {
    // A hard link is a second name for one inode, and nothing above a mount
    // holds that. Which refusal that is is decided once for every surface.
    return LINK_REFUSAL
  }

  path_symlink(
    oldPtr: number,
    oldLength: number,
    dirfd: number,
    newPtr: number,
    newLength: number,
  ): number {
    // The old pair is the target string, not a path to resolve: a link
    // stores what was typed.
    const target = DEC.decode(this.load(oldPtr, oldLength))
    const path = this.pathArg(dirfd, newPtr, newLength)
    if (path === null) return EBADF
    this.fs.symlink(path, target)
    return OK
  }
}

// The preview1 imports `wasiImports` serves; the rest a guest imports are
// absent, so a module that needs one fails to link rather than run wrong.
const CALLS = [
  'args_get',
  'args_sizes_get',
  'environ_get',
  'environ_sizes_get',
  'random_get',
  'sched_yield',
  'clock_time_get',
  'clock_res_get',
  'poll_oneoff',
  'fd_advise',
  'fd_close',
  'fd_datasync',
  'fd_fdstat_get',
  'fd_fdstat_set_flags',
  'fd_filestat_get',
  'fd_filestat_set_size',
  'fd_filestat_set_times',
  'fd_pread',
  'fd_prestat_get',
  'fd_prestat_dir_name',
  'fd_pwrite',
  'fd_read',
  'fd_readdir',
  'fd_renumber',
  'fd_seek',
  'fd_sync',
  'fd_tell',
  'fd_write',
  'path_create_directory',
  'path_filestat_get',
  'path_filestat_set_times',
  'path_link',
  'path_open',
  'path_readlink',
  'path_remove_directory',
  'path_rename',
  'path_symlink',
  'path_unlink_file',
] as const

/**
 * The guest's preview1 imports over one run's `WasiFs`, each mapping a
 * failure to a guest errno. Filesystem-shaped errors get their own errno;
 * anything else, a backend's upstream error on one record most often, is
 * EIO: a syscall has no other channel to say it failed. A `GuestExit`
 * passes through, so it ends `_start`. Mirrors Python's `install_wasi_fs`.
 *
 * @param wasi - the run's host-function table.
 */
export function wasiImports(wasi: WasiFs): WebAssembly.Imports {
  const calls: Record<string, (...args: never[]) => unknown> = {
    proc_exit: (code: number) => wasi.proc_exit(code),
  }
  for (const name of CALLS) {
    const method = wasi[name] as (...args: unknown[]) => number
    calls[name] = (...args: unknown[]) => {
      try {
        return method.apply(wasi, args)
      } catch (err) {
        if (err instanceof GuestExit) throw err
        return errnoFor(err)
      }
    }
  }
  return { wasi_snapshot_preview1: calls }
}

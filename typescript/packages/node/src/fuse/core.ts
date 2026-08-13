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

import { posix } from 'node:path'
import {
  type FileStat,
  DIR_MODE,
  FILE_MODE,
  FileTable,
  FileType,
  isMissingOp,
  mergeWrites,
  mtimeMs,
  type OpRecord,
  rstripSlash,
  type Ops,
  type Session,
  compareCodePoints,
} from '@struktoai/mirage-core'
import { errnoError } from './errors.ts'
import { isMacosMetadata } from './platform/macos.ts'

export interface FuseAttr {
  mtime: Date
  atime: Date
  ctime: Date
  nlink: number
  size: number
  mode: number
  uid: number
  gid: number
}

export interface Handle {
  path: string
  data?: Uint8Array
  writeBuf?: [number, Uint8Array][]
}

interface PrefetchEntry {
  data: Uint8Array
  expires: number
}

const PREFETCH_TTL_MS = 30_000

export interface MountCoreOptions {
  rootPrefix?: string
  /**
   * Bind every op to this session's mount grants. The kernel-tier
   * primitive: bind-mount the tree into a container and the narrowing
   * travels with it. Enforcement happens inside dispatch/Ops via the
   * session context, so binding at the op entry point is sufficient.
   */
  session?: Session
}

/**
 * Protocol-neutral mount logic shared by every kernel adapter.
 *
 * Everything here is expressed in POSIX terms (attribute records, ordinary
 * thrown errors) and imports nothing from `@zkochan/fuse-native`, so it is
 * reusable by a non-FUSE adapter and unit-testable without a kernel.
 *
 * The division of labour: this class decides *what* the filesystem
 * contains, an adapter decides *how* to say it to a particular kernel
 * interface. Adapters translate the errors thrown here into their own
 * error codes with `classifyErrno`. Mirrors Python's `MountCore`.
 *
 * Every op goes through `ws.fs`, which delegates to the dispatcher, so
 * a mount walks the same door as a shell line (mount modes, policies,
 * cache, invalidation) and every op it runs lands in `ws.records` for
 * `drainOps`. Reaching `ws.dispatch` from here instead would skip the
 * record; reaching a backend directly would skip the door.
 */
export class MountCore {
  readonly ops: Ops
  readonly session: Session | null
  private readonly now: Date
  private readonly root: string
  readonly handles = new FileTable<Handle>()
  // In-memory extended attributes, keyed by path. Backends have no POSIX
  // xattrs, so these are advisory and never persisted; see setxattr.
  readonly xattrs = new Map<string, Map<string, Buffer>>()
  readonly prefetchCache = new Map<string, PrefetchEntry>()
  private readonly prefetchInflight = new Map<string, Promise<Uint8Array | null>>()
  private readonly uid: number
  private readonly gid: number

  constructor(ops: Ops, options: MountCoreOptions = {}) {
    this.ops = ops
    this.now = new Date()
    this.root = options.rootPrefix !== undefined ? rstripSlash(options.rootPrefix) : ''
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 0
    this.gid = typeof process.getgid === 'function' ? process.getgid() : 0
    this.session = options.session ?? null
  }

  // ── helpers ──────────────────────────────────────────────────────

  resolve(path: string): string {
    if (this.root === '') return path
    return path === '/' ? this.root : this.root + path
  }

  dirStat(): FuseAttr {
    return {
      mtime: this.now,
      atime: this.now,
      ctime: this.now,
      nlink: 2,
      size: 0,
      mode: DIR_MODE,
      uid: this.uid,
      gid: this.gid,
    }
  }

  fileStat(size: number): FuseAttr {
    return {
      mtime: this.now,
      atime: this.now,
      ctime: this.now,
      nlink: 1,
      size,
      mode: FILE_MODE,
      uid: this.uid,
      gid: this.gid,
    }
  }

  /**
   * Fold merged stat attributes into an attr record. The workspace stat
   * already carries the namespace overlay (chmod bits, chown ids, touched
   * mtime), so honoring these fields here is what makes metadata ops
   * visible through a mount. String uid/gid (names) are skipped: the kernel
   * wants numeric ids and there is no user db to map against.
   */
  applyStatAttrs(entry: FuseAttr, s: FileStat): FuseAttr {
    if (s.mode !== null) {
      entry.mode = (entry.mode & ~0o7777) | (s.mode & 0o7777)
    }
    if (typeof s.uid === 'number') entry.uid = s.uid
    if (typeof s.gid === 'number') entry.gid = s.gid
    if (s.modified !== null) {
      // One translator per language: the naive-stamp-is-UTC rule lives
      // in core's stat view, never re-parsed here with a bare Date.
      // Null means the stamp did not parse; epoch zero is a real time
      // and lands.
      const ms = mtimeMs(s)
      if (ms !== null) {
        entry.mtime = new Date(ms)
        entry.ctime = new Date(ms)
      }
    }
    return entry
  }

  /**
   * The target to present for a namespace link at a mount path, or null
   * when not a link. Relative targets are stored verbatim and returned
   * as-is. Absolute targets name virtual paths, so they are rewritten
   * relative to the link's directory: returned raw, the kernel would
   * resolve them against the host root and escape the mountpoint.
   */
  linkTarget(path: string): string | null {
    const links = this.ops.links
    if (links === null) return null
    const target = links.readlink(this.resolve(path))
    if (target === null) return null
    if (!target.startsWith('/')) return target
    let virtualTarget = target
    if (this.root !== '') {
      if (target === this.root) {
        virtualTarget = '/'
      } else if (target.startsWith(this.root + '/')) {
        virtualTarget = target.slice(this.root.length)
      } else {
        // points outside the scoped root: unreachable through this
        // mount, keep the stored form (a dangling link is legal)
        return target
      }
    }
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    return posix.relative(parent, virtualTarget)
  }

  linkStat(target: string): FuseAttr {
    const entry = this.fileStat(new TextEncoder().encode(target).byteLength)
    entry.mode = 0o120777
    return entry
  }

  cachedSize(path: string): number | null {
    for (const ctx of this.handles.values()) {
      if (ctx.path === path && ctx.data !== undefined) return ctx.data.byteLength
    }
    const entry = this.prefetchCache.get(path)
    if (entry !== undefined && entry.expires > Date.now()) return entry.data.byteLength
    return null
  }

  cachedData(path: string): Uint8Array | null {
    for (const ctx of this.handles.values()) {
      if (ctx.path === path && ctx.data !== undefined) return ctx.data
    }
    const entry = this.prefetchCache.get(path)
    if (entry !== undefined && entry.expires > Date.now()) return entry.data
    if (entry !== undefined) this.prefetchCache.delete(path)
    return null
  }

  /**
   * Fetch bytes for a size-unknown file and cache them so the open → read →
   * fstat burst (and subsequent stats within the TTL) reuse the same fetch.
   * With getattr reporting 0 pre-open, this hydration is what lets fgetattr
   * answer with the real byte length after open (mirrors Python's
   * `prefetch_read`).
   */
  async prefetch(path: string): Promise<Uint8Array | null> {
    const cached = this.cachedData(path)
    if (cached !== null) return cached
    const inflight = this.prefetchInflight.get(path)
    if (inflight !== undefined) return inflight
    const promise = (async (): Promise<Uint8Array | null> => {
      try {
        const data = await this.ops.readFile(this.resolve(path))
        this.prefetchCache.set(path, { data, expires: Date.now() + PREFETCH_TTL_MS })
        return data
      } catch {
        return null
      } finally {
        this.prefetchInflight.delete(path)
      }
    })()
    this.prefetchInflight.set(path, promise)
    return promise
  }

  /** Drain and return accumulated op records (mirrors Python's drainOps). */
  drainOps(): OpRecord[] {
    const records = [...this.ops.records]
    this.ops.records.length = 0
    return records
  }

  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.ops.writeFile(this.resolve(path), data)
  }

  /**
   * Merge buffered writes over the raw base and persist the result.
   * The base is read raw so a flush never stores a rendered view back
   * into the mount.
   */
  private async applyWrites(path: string, writes: [number, Uint8Array][]): Promise<void> {
    let existing: Uint8Array = new Uint8Array(0)
    try {
      existing = await this.ops.readFile(this.resolve(path), { raw: true })
    } catch {
      // missing file: start from empty; the write creates it
    }
    await this.writeFile(path, mergeWrites(existing, writes))
  }

  // ── POSIX surface (throws; adapters classify) ────────────────────

  async getattr(path: string): Promise<FuseAttr> {
    if (path === '/') return this.dirStat()
    // macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
    // Reject early to avoid hitting the ops layer.
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (isMacosMetadata(name)) {
      throw errnoError('ENOENT', `no such file or directory: ${path}`)
    }
    // Link check must precede the workspace stat: the fs facade follows
    // namespace links, so stat on a link path reports the target.
    const target = this.linkTarget(path)
    if (target !== null) return this.linkStat(target)
    const s = await this.ops.stat(this.resolve(path))
    if (s.type === FileType.DIRECTORY) {
      return this.applyStatAttrs(this.dirStat(), s)
    }
    // Size-unknown API files stat as 0 before open (never a fake size):
    // the mount's direct_io makes the kernel read to EOF regardless, and
    // attrTimeout '0' routes the post-open fstat to fgetattr, which serves
    // the real hydrated size. Mirrors Python's core.py; see the CLAUDE.md
    // FUSE section.
    let size = s.size
    size ??= this.cachedSize(path) ?? 0
    return this.applyStatAttrs(this.fileStat(size), s)
  }

  /** Attributes through an open handle, or path-based when not hydrated. */
  async fgetattr(path: string, fd: number): Promise<FuseAttr> {
    // fstat(fd) after open: the open handler prefetched size-unknown files
    // into the handle, so answer with the real byte length instead of the
    // 0 that path-based getattr reported before open.
    const ctx = this.handles.get(fd)
    if (ctx?.data !== undefined) return this.fileStat(ctx.data.byteLength)
    return this.getattr(path)
  }

  async readdir(path: string): Promise<string[]> {
    // The workspace dispatcher merges namespace structure (child mounts
    // and symlinks) into readdir and answers structure-only directories
    // itself, so the core only normalizes entry shapes and drops macOS
    // metadata names.
    const names = new Set<string>()
    const entries = await this.ops.readdir(this.resolve(path))
    for (const e of entries) {
      const part = rstripSlash(e).split('/').pop() ?? ''
      if (part !== '' && !isMacosMetadata(part)) names.add(part)
    }
    return ['.', '..', ...[...names].sort(compareCodePoints)]
  }

  async read(path: string, fd: number, pos: number, len: number): Promise<Uint8Array> {
    const ctx = this.handles.get(fd)
    // Filetype-aware read: no `raw: true`, so an extension with a
    // registered renderer surfaces as rendered text. Mirage registers
    // none by default, so this reads raw bytes until a mount adds one.
    // Matches Python's `self._ops.read(path)`, which also dispatches.
    if (ctx !== undefined && ctx.data === undefined) {
      const cached = this.cachedData(path)
      ctx.data = cached ?? (await this.ops.readFile(this.resolve(path)))
    }
    const data = ctx?.data ?? this.cachedData(path) ?? (await this.ops.readFile(this.resolve(path)))
    return data.subarray(pos, pos + len)
  }

  /** Buffer a write on its handle, or apply it directly when there is none. */
  async write(path: string, fd: number, data: Uint8Array, pos: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx !== undefined) {
      ctx.writeBuf ??= []
      ctx.writeBuf.push([pos, data])
      return
    }
    await this.applyWrites(path, [[pos, data]])
  }

  async create(path: string): Promise<number> {
    // Route through the resource's `create` op so backends that distinguish
    // "create empty" from "write bytes" get the right code path. Falls back
    // to writeFile(empty) when the resource doesn't expose `create`.
    try {
      await this.ops.create(this.resolve(path))
    } catch (dispatchErr) {
      if (!isMissingOp(dispatchErr, 'create')) throw dispatchErr
      await this.writeFile(path, new Uint8Array(0))
    }
    return this.handles.add({ path })
  }

  async mkdir(path: string): Promise<void> {
    await this.ops.mkdir(this.resolve(path))
  }

  readlink(path: string): string {
    const target = this.linkTarget(path)
    if (target === null) throw errnoError('EINVAL', `not a symbolic link: ${path}`)
    return target
  }

  /**
   * Create namespace link `dest -> src` (ln -s src dest; libfuse passes
   * the pointee first). Relative sources are stored verbatim (resolved
   * at follow time, exactly like the shell `ln -s`); absolute sources
   * are mapped into virtual space so a scoped mount stores the path it
   * will later follow.
   */
  async symlink(src: string, dest: string): Promise<void> {
    // The write routes through the op door like every other FUSE op, so
    // session grants and admission policies refuse a scoped kernel
    // mount exactly like a scoped shell.
    if (this.ops.links === null) throw errnoError('EROFS', 'workspace has no namespace links')
    const stored = src.startsWith('/') ? this.resolve(src) : src
    await this.ops.symlink(this.resolve(dest), stored)
  }

  async unlink(path: string): Promise<void> {
    const links = this.ops.links
    if (links?.isLink(this.resolve(path)) === true) {
      await links.unlink(this.resolve(path))
      this.xattrs.delete(path)
      this.prefetchCache.delete(path)
      return
    }
    await this.ops.unlink(this.resolve(path))
    this.xattrs.delete(path)
  }

  async rename(src: string, dst: string): Promise<void> {
    // The facade is where a cross-mount pair is refused with EXDEV,
    // which is what makes `mv` between two backends fall back to
    // copy+unlink instead of addressing the destination against the
    // source's backend.
    await this.ops.rename(this.resolve(src), this.resolve(dst))
    const moved = this.xattrs.get(src)
    if (moved !== undefined) {
      this.xattrs.delete(src)
      this.xattrs.set(dst, moved)
    }
  }

  async rmdir(path: string): Promise<void> {
    // Detect non-empty directories up front so we can signal ENOTEMPTY
    // cleanly. Message-string sniffing alone is unreliable across backends;
    // check contents first.
    try {
      const entries = await this.ops.readdir(this.resolve(path))
      if (entries.length > 0) {
        throw errnoError('ENOTEMPTY', `directory not empty: ${path}`)
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOTEMPTY') throw err
      // readdir failure — fall through to rmdir and let it raise the real
      // error (e.g. ENOENT for missing path).
    }
    await this.ops.rmdir(this.resolve(path))
    this.xattrs.delete(path)
  }

  async truncate(path: string, size: number): Promise<void> {
    // Prefer the resource's dedicated `truncate` op (atomic on most
    // backends). Fall back to read/resize/write for resources that don't
    // expose one.
    try {
      await this.ops.truncate(this.resolve(path), size)
    } catch (dispatchErr) {
      if (!isMissingOp(dispatchErr, 'truncate')) throw dispatchErr
      const data = await this.ops
        .readFile(this.resolve(path), { raw: true })
        .catch(() => new Uint8Array(0))
      const out = new Uint8Array(size)
      out.set(data.subarray(0, Math.min(data.byteLength, size)), 0)
      await this.writeFile(path, out)
    }
  }

  statfs(): Record<string, number> {
    return {
      bsize: 4096,
      frsize: 4096,
      blocks: 1024 * 1024,
      bfree: 1024 * 1024,
      bavail: 1024 * 1024,
      files: 1_000_000,
      ffree: 1_000_000,
      favail: 1_000_000,
      namemax: 255,
    }
  }

  setxattr(path: string, name: string, value: Buffer): void {
    let attrs = this.xattrs.get(path)
    if (attrs === undefined) {
      attrs = new Map()
      this.xattrs.set(path, attrs)
    }
    attrs.set(name, Buffer.from(value))
  }

  getxattr(path: string, name: string): Buffer | undefined {
    return this.xattrs.get(path)?.get(name)
  }

  listxattr(path: string): string[] {
    const attrs = this.xattrs.get(path)
    return attrs ? [...attrs.keys()] : []
  }

  removexattr(path: string, name: string): void {
    this.xattrs.get(path)?.delete(name)
  }

  async open(path: string): Promise<number> {
    const s = await this.ops.stat(this.resolve(path))
    const ctx: Handle = { path }
    if (s.size === null && s.type !== FileType.DIRECTORY) {
      const data = await this.prefetch(path)
      if (data !== null) ctx.data = data
    }
    return this.handles.add(ctx)
  }

  async release(fd: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx?.writeBuf !== undefined && ctx.writeBuf.length > 0) {
      // The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH in
      // between (the kext always flushes on close), so a handle can still
      // hold buffered writes here. Dropping them would silently lose data
      // written through an fskit mount.
      await this.flush(ctx.path, fd)
    }
    this.handles.pop(fd)
  }

  async flush(path: string, fd: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx?.writeBuf === undefined || ctx.writeBuf.length === 0) return
    const writes = ctx.writeBuf
    ctx.writeBuf = []
    await this.applyWrites(path, writes)
  }
}

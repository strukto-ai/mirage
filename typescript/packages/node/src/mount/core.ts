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
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import type { Ops } from '@struktoai/mirage-core/ops/ops'
import { FileTable, mergeWrites } from '@struktoai/mirage-core/runtime/handles/index'
import { FileType } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { isMissingOp } from '@struktoai/mirage-core/utils/errors'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import { ENOENT, classifyErrno, errnoError } from './errors.ts'
import { PrefetchCache } from './prefetch.ts'
import { applyStatAttrs, dirStat, fileStat, linkStat } from './stat.ts'
import type { MountAttrs, MountEntry } from './types.ts'
import { isMacosMetadata } from './platform/macos.ts'

export interface Handle {
  path: string
  data?: Uint8Array
  writeBuf?: [number, Uint8Array][]
}

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
  private readonly prefetchCache = new PrefetchCache()
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

  /** This mount's base directory row, before any namespace overlay. */
  dirStat(): MountAttrs {
    return dirStat(this.uid, this.gid, this.now)
  }

  /** This mount's base row for a regular file of `size` bytes. */
  fileStat(size: number): MountAttrs {
    return fileStat(size, this.uid, this.gid, this.now)
  }

  /** See {@link applyStatAttrs}; kept as a method for the adapters. */
  applyStatAttrs(entry: MountAttrs, s: FileStat): MountAttrs {
    return applyStatAttrs(entry, s)
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

  /** The row a namespace link at `path` reports; see {@link linkStat}. */
  linkStat(target: string, virtual: string): MountAttrs {
    const row = this.ops.links?.linkStatAt(virtual) ?? null
    return linkStat(target, row, this.uid, this.gid, this.now)
  }

  cachedSize(path: string): number | null {
    for (const ctx of this.handles.values()) {
      if (ctx.path === path && ctx.data !== undefined) return ctx.data.byteLength
    }
    const data = this.prefetchCache.get(path)
    return data === null ? null : data.byteLength
  }

  cachedData(path: string): Uint8Array | null {
    for (const ctx of this.handles.values()) {
      if (ctx.path === path && ctx.data !== undefined) return ctx.data
    }
    return this.prefetchCache.get(path)
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
    return this.prefetchCache.claim(path, async () => {
      try {
        return await this.ops.readFile(this.resolve(path))
      } catch (err) {
        // Open stays permissive for a file that is not there; the read
        // after it surfaces the real error. Anything else propagates,
        // rather than a bare catch turning a policy denial into an
        // unhydrated file that then reads as empty.
        if (classifyErrno(err) !== ENOENT) throw err
        return null
      }
    })
  }

  /** Drain and return accumulated op records (mirrors Python's drainOps). */
  drainOps(): OpRecord[] {
    const records = [...this.ops.records]
    this.ops.records.length = 0
    return records
  }

  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.ops.writeFile(this.resolve(path), data)
    // Every write funnels through here, so this one call is what keeps a
    // size-unknown file from reading back its pre-write bytes for the
    // rest of the TTL. Python invalidates at the same points.
    this.prefetchCache.invalidate(path)
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
    } catch (err) {
      // Only a missing file, which the write then creates. A bare catch
      // read every transient backend, auth or policy failure as "empty",
      // and the whole-object write below then stored the pending ranges
      // alone -- destroying content nobody touched. Same bug the nfs
      // delegate's readBase had; python's twin catches FileNotFoundError
      // and nothing else.
      if (classifyErrno(err) !== ENOENT) throw err
    }
    await this.writeFile(path, mergeWrites(existing, writes))
  }

  // ── POSIX surface (throws; adapters classify) ────────────────────

  /**
   * Attributes for a path, with no name policy applied.
   *
   * Split from `getattr` because refusing a name and describing an
   * entry are two different questions, and only one protocol fuses
   * them. libfuse has no LOOKUP: its getattr *is* the lookup, so the
   * refusal belongs there. NFSv3 looks a name up once and then addresses
   * the entry by handle, so re-applying a name policy to a handle it
   * already minted makes a file the client just created vanish -- which
   * is what macOS `cp` hit, since it copies extended attributes through
   * an AppleDouble `._name` the filter matches.
   */
  async attrsFor(path: string): Promise<MountAttrs> {
    if (path === '/') return this.dirStat()
    // Link check must precede the workspace stat: the fs facade follows
    // namespace links, so stat on a link path reports the target.
    const target = this.linkTarget(path)
    if (target !== null) return this.linkStat(target, this.resolve(path))
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

  /**
   * Attributes for a path a caller reached by name.
   *
   * macOS Finder and Spotlight probe .DS_Store, ._*, .Spotlight-V100 and
   * friends on every listing; refusing here keeps the probe off the
   * backend entirely.
   */
  async getattr(path: string): Promise<MountAttrs> {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (isMacosMetadata(name)) {
      throw errnoError('ENOENT', `no such file or directory: ${path}`)
    }
    return this.attrsFor(path)
  }

  /** Attributes through an open handle, or path-based when not hydrated. */
  async fgetattr(path: string, fd: number): Promise<MountAttrs> {
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

  /**
   * The same listing as {@link readdir}, described per entry.
   *
   * A protocol that lists with attributes would otherwise stat every
   * name again, once per entry per listing, and would have to join each
   * child path itself -- which is how an adapter ends up disagreeing
   * with the core about what a name resolves to. `.` and `..` are
   * absent: they are the caller's to emit, and libfuse and NFSv3 emit
   * them differently.
   */
  async readdirEntries(path: string): Promise<MountEntry[]> {
    const entries: MountEntry[] = []
    for (const name of await this.readdir(path)) {
      if (name === '.' || name === '..') continue
      const child = posix.join(path, name)
      entries.push({ name, path: child, attrs: await this.attrsFor(child) })
    }
    return entries
  }

  async read(path: string, fd: number, pos: number, len: number): Promise<Uint8Array> {
    const ctx = this.handles.get(fd)
    // Filetype-aware read: no `raw: true`, so an extension with a
    // registered renderer surfaces as rendered text. Mirage registers
    // none by default, so this reads raw bytes until a mount adds one.
    // Matches Python's `self._ops.read(path)`, which also dispatches.
    if (ctx !== undefined && ctx.data === undefined) {
      ctx.data = this.cachedData(path) ?? (await this.fetchWhole(path))
    }
    const data = ctx?.data ?? this.cachedData(path) ?? (await this.fetchWhole(path))
    return data.subarray(pos, pos + len)
  }

  /**
   * Fetch a whole object and cache it.
   *
   * The fill site `read` needs, not only the one `prefetch` does on
   * open. NFSv3 has no OPEN, so its reads never reached that fill and
   * every 64 KiB READ refetched the entire file: 16 full fetches to
   * serve 1 MiB, and one backend request per 64 KiB on an API mount.
   * The bytes are already in hand, so this costs retention only.
   */
  private async fetchWhole(path: string): Promise<Uint8Array> {
    const data = await this.ops.readFile(this.resolve(path))
    this.prefetchCache.put(path, data)
    return data
  }

  /**
   * Replace a file's whole content.
   *
   * The write an adapter that buffers whole objects needs. It exists so
   * that adapter does not reach the facade directly: a store that
   * bypasses the core also bypasses the cache invalidation, and the
   * next read is served pre-write bytes for the rest of the TTL --
   * which for a flush means losing the batch the flush before it
   * stored.
   */
  async store(path: string, data: Uint8Array): Promise<void> {
    await this.writeFile(path, data)
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
    this.prefetchCache.invalidate(path)
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

  /**
   * Remove the entry at `path`, a link entry like any other.
   *
   * A link routes through the op door rather than straight to the node
   * table: `unlink` is a LINK_ENTRY_OPS member, so the door answers a
   * link path itself, gated by session grants and admission policies
   * and recorded on the ledger. Writing the table here instead let a
   * session-scoped kernel mount delete a link on a mount its profile
   * hides. Mirrors Python's MountCore.unlink.
   */
  async unlink(path: string): Promise<void> {
    await this.ops.unlink(this.resolve(path))
    this.xattrs.delete(path)
    this.prefetchCache.invalidate(path)
  }

  async rename(src: string, dst: string): Promise<void> {
    // The facade is where a cross-mount pair is refused with EXDEV,
    // which is what makes `mv` between two backends fall back to
    // copy+unlink instead of addressing the destination against the
    // source's backend.
    await this.ops.rename(this.resolve(src), this.resolve(dst))
    this.prefetchCache.invalidate(src, dst)
    const moved = this.xattrs.get(src)
    if (moved !== undefined) {
      this.xattrs.delete(src)
      this.xattrs.set(dst, moved)
    }
  }

  // No emptiness pre-check here, matching the python MountCore. Every
  // backend's rmdir op refuses a non-empty directory itself, so a listing
  // first was one extra round trip per call on an API-backed mount, and the
  // catch that wrapped it swallowed whatever readdir raised.
  async rmdir(path: string): Promise<void> {
    await this.ops.rmdir(this.resolve(path))
    this.xattrs.delete(path)
  }

  async truncate(path: string, size: number): Promise<void> {
    // Prefer the resource's dedicated `truncate` op (atomic on most
    // backends). Fall back to read/resize/write for resources that don't
    // expose one.
    this.prefetchCache.invalidate(path)
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
    // Store first, clear only on success. Clearing up front lost the
    // whole batch whenever the store failed -- and under fskit, where
    // RELEASE arrives with no FLUSH before it, that batch is the only
    // copy the file has. Python's twin has always been in this order;
    // the failure differential is what caught the divergence.
    await this.applyWrites(path, ctx.writeBuf)
    ctx.writeBuf = []
  }
}

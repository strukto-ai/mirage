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
  FileType,
  type OpRecord,
  PathSpec,
  runWithSession,
  type Session,
  type Workspace,
  rstripSlash,
} from '@struktoai/mirage-core'
import { isMacosMetadata } from './platform/macos.ts'

// FUSE errno values (negative for fuse-native callbacks; positive for errors thrown).
const ENOENT = -2
const EACCES = -13
const ENOTDIR = -20
const EEXIST = -17
const ENOTEMPTY = -66 // macOS; Linux is -39 — fuse-native normalizes.
const EIO = -5
const EINVAL = -22
const EROFS = -30

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

interface Handle {
  path: string
  data?: Uint8Array
  writeBuf?: [number, Uint8Array][]
}

interface PrefetchEntry {
  data: Uint8Array
  expires: number
}

const PREFETCH_TTL_MS = 30_000

type Cb<T> = (code: number, result?: T) => void

function classifyError(err: unknown): number {
  const code = (err as { code?: string }).code
  if (code === 'ENOTEMPTY') return ENOTEMPTY
  if (code === 'ENOTDIR') return ENOTDIR
  if (code === 'EACCES') return EACCES
  if (code === 'EEXIST') return EEXIST
  if (code === 'ENOENT') return ENOENT
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('not empty') || msg.includes('enotempty')) return ENOTEMPTY
  if (msg.includes('not a directory') || msg.includes('enotdir')) return ENOTDIR
  // A session capability rejection (MountNotAllowedError) is a permission
  // failure, mirroring Python's PermissionError -> EACCES.
  if (msg.includes('not allowed to access mount')) return EACCES
  if (msg.includes('permission') || msg.includes('eacces') || msg.includes('read-only'))
    return EACCES
  if (msg.includes('file exists') || msg.includes('eexist')) return EEXIST
  if (
    msg.includes('not found') ||
    msg.includes('no such') ||
    msg.includes('enoent') ||
    msg.includes('no mount')
  )
    return ENOENT
  return EIO
}

export interface MirageFSOptions {
  rootPrefix?: string
  /**
   * Bind every FUSE op to this session's mount grants. The kernel-tier
   * primitive: bind-mount the tree into a container and the narrowing
   * travels with it. Enforcement happens inside dispatch/Ops via the
   * session context, so binding at the op entry point is sufficient.
   */
  session?: Session
}

export class MirageFS {
  private readonly ws: Workspace
  private readonly now: Date
  private readonly root: string
  private readonly prefixes: string[]
  private readonly handles = new Map<number, Handle>()
  // In-memory extended attributes, keyed by FUSE path. Backends have no POSIX
  // xattrs, so these are advisory and never persisted; see setxattr.
  private readonly xattrs = new Map<string, Map<string, Buffer>>()
  private readonly prefetchCache = new Map<string, PrefetchEntry>()
  private readonly prefetchInflight = new Map<string, Promise<Uint8Array | null>>()
  private nextFh = 1
  private readonly uid: number
  private readonly gid: number
  private readonly session: Session | null

  constructor(ws: Workspace, options: MirageFSOptions = {}) {
    this.ws = ws
    this.now = new Date()
    this.root = options.rootPrefix !== undefined ? rstripSlash(options.rootPrefix) : ''
    // When scoped to a single mount, the FUSE root maps onto that mount and
    // there are no virtual intermediate directories to synthesize.
    this.prefixes = this.root === '' ? ws.mounts().map((m) => m.prefix) : []
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 0
    this.gid = typeof process.getgid === 'function' ? process.getgid() : 0
    this.session = options.session ?? null
  }

  // ── helpers ──────────────────────────────────────────────────────

  private resolve(path: string): string {
    if (this.root === '') return path
    return path === '/' ? this.root : this.root + path
  }

  private dirStat(): FuseAttr {
    return {
      mtime: this.now,
      atime: this.now,
      ctime: this.now,
      nlink: 2,
      size: 0,
      mode: 0o040755,
      uid: this.uid,
      gid: this.gid,
    }
  }

  private fileStat(size: number): FuseAttr {
    return {
      mtime: this.now,
      atime: this.now,
      ctime: this.now,
      nlink: 1,
      size,
      mode: 0o100644,
      uid: this.uid,
      gid: this.gid,
    }
  }

  /**
   * Fold merged stat attributes into a FUSE attr. The workspace stat
   * already carries the namespace overlay (chmod bits, chown ids, touched
   * mtime), so honoring these fields here is what makes metadata ops
   * visible over FUSE. String uid/gid (names) are skipped: FUSE wants
   * numeric ids and there is no user db to map against.
   */
  private applyStatAttrs(entry: FuseAttr, s: FileStat): FuseAttr {
    if (s.mode !== null) {
      entry.mode = (entry.mode & ~0o7777) | (s.mode & 0o7777)
    }
    if (typeof s.uid === 'number') entry.uid = s.uid
    if (typeof s.gid === 'number') entry.gid = s.gid
    if (s.modified !== null) {
      const ts = new Date(s.modified)
      if (!Number.isNaN(ts.getTime())) {
        entry.mtime = ts
        entry.ctime = ts
      }
    }
    return entry
  }

  /**
   * The target to present for a namespace link at a FUSE path, or null
   * when not a link. Relative targets are stored verbatim and returned
   * as-is. Absolute targets name virtual paths, so they are rewritten
   * relative to the link's directory: returned raw, the kernel would
   * resolve them against the host root and escape the mountpoint.
   */
  private linkTarget(path: string): string | null {
    const links = this.ws.fs.links
    if (links === null) return null
    const target = links.readlink(this.resolve(path))
    if (target === null) return null
    if (!target.startsWith('/')) return target
    let fuseTarget = target
    if (this.root !== '') {
      if (target === this.root) {
        fuseTarget = '/'
      } else if (target.startsWith(this.root + '/')) {
        fuseTarget = target.slice(this.root.length)
      } else {
        // points outside the scoped root: unreachable through this
        // mount, keep the stored form (a dangling link is legal)
        return target
      }
    }
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    return posix.relative(parent, fuseTarget)
  }

  private linkStat(target: string): FuseAttr {
    const entry = this.fileStat(new TextEncoder().encode(target).byteLength)
    entry.mode = 0o120777
    return entry
  }

  private isVirtualDir(path: string): boolean {
    const bare = rstripSlash(path)
    const normalized = bare + '/'
    for (const p of this.prefixes) {
      const pBare = rstripSlash(p)
      if (p.startsWith(normalized) || pBare === bare) return true
    }
    return false
  }

  private virtualChildren(path: string): string[] {
    const normalized = path === '/' ? '/' : rstripSlash(path) + '/'
    const children = new Set<string>()
    for (const p of this.prefixes) {
      if (p.startsWith(normalized) && p !== normalized) {
        const rest = p.slice(normalized.length)
        const child = rest.split('/')[0]
        if (child !== undefined && child !== '') children.add(child)
      }
    }
    return [...children].sort()
  }

  private cachedSize(path: string): number | null {
    for (const ctx of this.handles.values()) {
      if (ctx.path === path && ctx.data !== undefined) return ctx.data.byteLength
    }
    const entry = this.prefetchCache.get(path)
    if (entry !== undefined && entry.expires > Date.now()) return entry.data.byteLength
    return null
  }

  private cachedData(path: string): Uint8Array | null {
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
   * `_prefetch_read`).
   */
  private async prefetch(path: string): Promise<Uint8Array | null> {
    const cached = this.cachedData(path)
    if (cached !== null) return cached
    const inflight = this.prefetchInflight.get(path)
    if (inflight !== undefined) return inflight
    const promise = (async (): Promise<Uint8Array | null> => {
      try {
        const data = await this.ws.fs.readFile(this.resolve(path))
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

  /** Drain and return accumulated op records (mirrors Python's drain_ops). */
  drainOps(): OpRecord[] {
    const records = [...this.ws.records]
    this.ws.records.length = 0
    return records
  }

  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    // Keep FUSE writes on Workspace.dispatch rather than Workspace.fs.writeFile:
    // dispatch is where Mirage enforces mount modes, revision tracking, and
    // post-write invalidation. The lower-level fs helper is useful internally,
    // but using it from FUSE made READ-mode mounts reject create while still
    // allowing buffered overwrite on flush.
    await this.ws.dispatch('write', this.resolve(path), [data])
  }

  // ── FUSE op surface (mirrors mfusepy Operations) ─────────────────

  ops(): Record<string, unknown> {
    const table: Record<string, (...args: never[]) => void> = {
      readdir: this.readdir.bind(this),
      getattr: this.getattr.bind(this),
      fgetattr: this.fgetattr.bind(this),
      open: this.open.bind(this),
      read: this.read.bind(this),
      write: this.write.bind(this),
      create: this.create.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
      unlink: this.unlink.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      rename: this.rename.bind(this),
      release: this.release.bind(this),
      truncate: this.truncate.bind(this),
      flush: this.flush.bind(this),
      fsync: this.fsync.bind(this),
      utimens: this.utimens.bind(this),
      chmod: this.chmod.bind(this),
      chown: this.chown.bind(this),
      access: this.access.bind(this),
      setxattr: this.setxattr.bind(this),
      getxattr: this.getxattr.bind(this),
      listxattr: this.listxattr.bind(this),
      removexattr: this.removexattr.bind(this),
      statfs: this.statfs.bind(this),
    }
    const session = this.session
    if (session === null) return table
    // A session-bound tree enters the session context before every op,
    // mirroring Python's MirageFS._bind_session: the async work each
    // callback starts inherits the context, so dispatch/Ops enforce the
    // session's mount grants for kernel-originated I/O too.
    const bound: Record<string, unknown> = {}
    for (const [name, fn] of Object.entries(table)) {
      bound[name] = (...args: never[]) => {
        void runWithSession(session, () => {
          fn(...args)
          return Promise.resolve()
        })
      }
    }
    return bound
  }

  private getattr(path: string, cb: Cb<FuseAttr>): void {
    void (async () => {
      if (path === '/') {
        cb(0, this.dirStat())
        return
      }
      // macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
      // Reject early to avoid hitting the ops layer.
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (isMacosMetadata(name)) {
        cb(ENOENT)
        return
      }
      // Link check must precede the workspace stat: the fs facade follows
      // namespace links, so stat on a link path reports the target.
      const target = this.linkTarget(path)
      if (target !== null) {
        cb(0, this.linkStat(target))
        return
      }
      if (this.isVirtualDir(path)) {
        cb(0, this.dirStat())
        return
      }
      try {
        const s = await this.ws.fs.stat(this.resolve(path))
        if (s.type === FileType.DIRECTORY) {
          cb(0, this.applyStatAttrs(this.dirStat(), s))
          return
        }
        // Size-unknown API files stat as 0 before open (never a fake size):
        // the mount's direct_io makes the kernel read to EOF regardless, and
        // attrTimeout '0' routes the post-open fstat to fgetattr, which
        // serves the real hydrated size. Mirrors Python's fs.py; see the
        // CLAUDE.md FUSE section.
        let size = s.size
        size ??= this.cachedSize(path) ?? 0
        cb(0, this.applyStatAttrs(this.fileStat(size), s))
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private fgetattr(path: string, fd: number, cb: Cb<FuseAttr>): void {
    // fstat(fd) after open: the open handler prefetched size-unknown files
    // into the handle, so answer with the real byte length instead of the
    // 0 that path-based getattr reported before open.
    const ctx = this.handles.get(fd)
    if (ctx?.data !== undefined) {
      cb(0, this.fileStat(ctx.data.byteLength))
      return
    }
    this.getattr(path, cb)
  }

  private readdir(path: string, cb: Cb<string[]>): void {
    void (async () => {
      const names = new Set(this.virtualChildren(path))
      const links = this.ws.fs.links
      if (links !== null) {
        for (const linkName of links.linksUnder(this.resolve(path)).keys()) {
          if (linkName !== '' && !isMacosMetadata(linkName)) names.add(linkName)
        }
      }
      try {
        const entries = await this.ws.fs.readdir(this.resolve(path))
        for (const e of entries) {
          const part = rstripSlash(e).split('/').pop() ?? ''
          if (part !== '' && !isMacosMetadata(part)) names.add(part)
        }
      } catch {
        if (names.size === 0) {
          cb(ENOENT)
          return
        }
      }
      cb(0, ['.', '..', ...[...names].sort()])
    })()
  }

  private read(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (result: number) => void,
  ): void {
    void (async () => {
      const ctx = this.handles.get(fd)
      try {
        // Filetype-aware read: no `raw: true`, so parquet/feather/hdf5/etc.
        // get routed through their read ops and surface as rendered text —
        // matches Python's `self._ops.read(path)` which also goes through
        // filetype dispatch.
        if (ctx !== undefined && ctx.data === undefined) {
          const cached = this.cachedData(path)
          ctx.data = cached ?? (await this.ws.fs.readFile(this.resolve(path)))
        }
        const data =
          ctx?.data ?? this.cachedData(path) ?? (await this.ws.fs.readFile(this.resolve(path)))
        const slice = data.subarray(pos, pos + len)
        buf.set(slice, 0)
        cb(slice.byteLength)
      } catch {
        cb(0)
      }
    })()
  }

  private write(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (result: number) => void,
  ): void {
    const ctx = this.handles.get(fd)
    const data = new Uint8Array(buf.subarray(0, len))
    if (ctx !== undefined) {
      ctx.writeBuf ??= []
      ctx.writeBuf.push([pos, data])
      cb(len)
      return
    }
    void (async () => {
      try {
        let existing: Uint8Array = new Uint8Array(0)
        try {
          existing = await this.ws.fs.readFile(this.resolve(path), { raw: true })
        } catch {
          // file may not exist yet
        }
        let merged = existing
        if (pos > merged.byteLength) {
          // zero-pad from end-of-file up to the write offset (sparse write).
          const padded = new Uint8Array(pos + data.byteLength)
          padded.set(merged, 0)
          padded.set(data, pos)
          merged = padded
        } else {
          const size = Math.max(merged.byteLength, pos + data.byteLength)
          const out = new Uint8Array(size)
          out.set(merged.subarray(0, pos), 0)
          out.set(data, pos)
          if (pos + data.byteLength < merged.byteLength) {
            out.set(merged.subarray(pos + data.byteLength), pos + data.byteLength)
          }
          merged = out
        }
        await this.writeFile(path, merged)
        cb(len)
      } catch {
        cb(0)
      }
    })()
  }

  private create(path: string, _mode: number, cb: Cb<number>): void {
    void (async () => {
      try {
        // Route through the resource's `create` op so backends that distinguish
        // "create empty" from "write bytes" get the right code path. Falls back
        // to writeFile(empty) when the resource doesn't expose `create`.
        try {
          await this.ws.dispatch('create', this.resolve(path))
        } catch (dispatchErr) {
          const msg = (
            dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)
          ).toLowerCase()
          if (!msg.includes('no op')) throw dispatchErr
          await this.writeFile(path, new Uint8Array(0))
        }
        const fh = this.nextFh++
        this.handles.set(fh, { path })
        cb(0, fh)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private mkdir(path: string, _mode: number, cb: (code: number) => void): void {
    void (async () => {
      try {
        // Metadata ops route through dispatch (not ws.fs) so the file
        // cache and readdir index are invalidated like any other write.
        await this.ws.dispatch('mkdir', this.resolve(path))
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private readlink(path: string, cb: Cb<string>): void {
    const target = this.linkTarget(path)
    if (target === null) {
      cb(EINVAL)
      return
    }
    cb(0, target)
  }

  /**
   * Create namespace link `dest -> src` (ln -s src dest; libfuse passes
   * the pointee first). Relative sources are stored verbatim (resolved
   * at follow time, exactly like the shell `ln -s`); absolute sources
   * are mapped into virtual space so a scoped mount stores the path it
   * will later follow.
   */
  private symlink(src: string, dest: string, cb: (code: number) => void): void {
    void (async () => {
      const links = this.ws.fs.links
      if (links === null) {
        cb(EROFS)
        return
      }
      const stored = src.startsWith('/') ? this.resolve(src) : src
      try {
        await links.symlink(this.resolve(dest), stored, Date.now() / 1000)
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private unlink(path: string, cb: (code: number) => void): void {
    void (async () => {
      const links = this.ws.fs.links
      if (links?.isLink(this.resolve(path)) === true) {
        await links.unlink(this.resolve(path))
        this.xattrs.delete(path)
        this.prefetchCache.delete(path)
        cb(0)
        return
      }
      try {
        await this.ws.dispatch('unlink', this.resolve(path))
        this.xattrs.delete(path)
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private rename(src: string, dst: string, cb: (code: number) => void): void {
    void (async () => {
      try {
        await this.ws.dispatch('rename', this.resolve(src), [
          PathSpec.fromStrPath(this.resolve(dst)),
        ])
        const moved = this.xattrs.get(src)
        if (moved !== undefined) {
          this.xattrs.delete(src)
          this.xattrs.set(dst, moved)
        }
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private rmdir(path: string, cb: (code: number) => void): void {
    void (async () => {
      try {
        // Detect non-empty directories up front so we can map to ENOTEMPTY
        // cleanly. Message-string sniffing alone (classifyError) is unreliable
        // across backends; check contents first.
        try {
          const entries = await this.ws.fs.readdir(this.resolve(path))
          if (entries.length > 0) {
            cb(ENOTEMPTY)
            return
          }
        } catch {
          // readdir failure — fall through to rmdir and let it raise the real
          // error (e.g. ENOENT for missing path).
        }
        await this.ws.dispatch('rmdir', this.resolve(path))
        this.xattrs.delete(path)
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private truncate(path: string, size: number, cb: (code: number) => void): void {
    void (async () => {
      try {
        // Prefer the resource's dedicated `truncate` op (atomic on most
        // backends). Fall back to read/resize/write for resources that don't
        // expose one.
        try {
          await this.ws.dispatch('truncate', this.resolve(path), [size])
        } catch (dispatchErr) {
          const msg = (
            dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)
          ).toLowerCase()
          if (!msg.includes('no op')) throw dispatchErr
          const data = await this.ws.fs
            .readFile(this.resolve(path), { raw: true })
            .catch(() => new Uint8Array(0))
          const out = new Uint8Array(size)
          out.set(data.subarray(0, Math.min(data.byteLength, size)), 0)
          await this.writeFile(path, out)
        }
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private statfs(_path: string, cb: Cb<Record<string, number>>): void {
    cb(0, {
      bsize: 4096,
      frsize: 4096,
      blocks: 1024 * 1024,
      bfree: 1024 * 1024,
      bavail: 1024 * 1024,
      files: 1_000_000,
      ffree: 1_000_000,
      favail: 1_000_000,
      namemax: 255,
    })
  }

  // chmod / chown / utimens / access are no-ops for the filesystem but must
  // validate path existence — callers like `touch`/`chmod` on a missing file
  // should fail with ENOENT, not silently succeed.

  private chmod(path: string, _mode: number, cb: (code: number) => void): void {
    this.getattrValidate(path, cb)
  }

  private chown(path: string, _uid: number, _gid: number, cb: (code: number) => void): void {
    this.getattrValidate(path, cb)
  }

  private utimens(path: string, _atime: Date, _mtime: Date, cb: (code: number) => void): void {
    this.getattrValidate(path, cb)
  }

  private access(path: string, _amode: number, cb: (code: number) => void): void {
    this.getattrValidate(path, cb)
  }

  // Mirage backends (S3, etc.) have no POSIX extended attributes, so there is
  // nothing to persist xattrs to. We keep them in memory per mount so tools that
  // probe or set xattrs (sandbox runtimes, rsync -aX, tar --xattrs, cp -p, macOS
  // Finder writing com.apple.*) succeed instead of failing with ENOTSUP. The
  // values live only for the mount's lifetime and are never written to the
  // backend.
  private setxattr(
    path: string,
    name: string,
    value: Buffer,
    _position: number,
    _flags: number,
    cb: (code: number) => void,
  ): void {
    this.getattr(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      let attrs = this.xattrs.get(path)
      if (attrs === undefined) {
        attrs = new Map()
        this.xattrs.set(path, attrs)
      }
      attrs.set(name, Buffer.from(value))
      cb(0)
    })
  }

  private getxattr(
    path: string,
    name: string,
    _position: number,
    cb: (code: number, value?: Buffer) => void,
  ): void {
    this.getattr(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      // A missing value tells fuse-native to report ENOATTR/ENODATA.
      cb(0, this.xattrs.get(path)?.get(name))
    })
  }

  private listxattr(path: string, cb: (code: number, list?: string[]) => void): void {
    this.getattr(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      const attrs = this.xattrs.get(path)
      cb(0, attrs ? [...attrs.keys()] : [])
    })
  }

  private removexattr(path: string, name: string, cb: (code: number) => void): void {
    this.getattr(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      this.xattrs.get(path)?.delete(name)
      cb(0)
    })
  }

  private getattrValidate(path: string, cb: (code: number) => void): void {
    // getattr's callback returns 0 on success and a negative errno on failure
    // (FUSE convention). Pass the code straight through so missing paths
    // surface as ENOENT instead of silently succeeding.
    this.getattr(path, (code) => {
      cb(code)
    })
  }

  private open(path: string, _flags: number, cb: Cb<number>): void {
    void (async () => {
      try {
        const s = await this.ws.fs.stat(this.resolve(path))
        const ctx: Handle = { path }
        if (s.size === null && s.type !== FileType.DIRECTORY) {
          const data = await this.prefetch(path)
          if (data !== null) ctx.data = data
        }
        const fh = this.nextFh++
        this.handles.set(fh, ctx)
        cb(0, fh)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private release(_path: string, fd: number, cb: (code: number) => void): void {
    // Python does NOT flush on release — the kernel always issues flush first.
    // Auto-flushing here would conflict on error paths and hide real failures.
    this.handles.delete(fd)
    cb(0)
  }

  private flush(path: string, fd: number, cb: (code: number) => void): void {
    const ctx = this.handles.get(fd)
    if (ctx?.writeBuf === undefined || ctx.writeBuf.length === 0) {
      cb(0)
      return
    }
    const writes = ctx.writeBuf
    ctx.writeBuf = []
    void (async () => {
      try {
        let existing: Uint8Array = new Uint8Array(0)
        try {
          existing = await this.ws.fs.readFile(this.resolve(path), { raw: true })
        } catch {
          // ignore
        }
        let total = existing.byteLength
        for (const [off, chunk] of writes) {
          total = Math.max(total, off + chunk.byteLength)
        }
        const merged = new Uint8Array(total)
        merged.set(existing, 0)
        for (const [off, chunk] of writes) {
          merged.set(chunk, off)
        }
        await this.writeFile(path, merged)
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private fsync(path: string, _datasync: number, fd: number, cb: (code: number) => void): void {
    this.flush(path, fd, cb)
  }
}

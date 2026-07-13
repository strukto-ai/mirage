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

import { FileType, type OpRecord, type Workspace, rstripSlash } from '@struktoai/mirage-core'
import { isMacosMetadata } from './platform/macos.ts'

const ENV_AGENT_ID = 'MIRAGE_AGENT_ID'
const MIRAGE_DIR = '/.mirage'
const MIRAGE_WHOAMI = '/.mirage/whoami'

// FUSE errno values (negative for fuse-native callbacks; positive for errors thrown).
const ENOENT = -2
const EACCES = -13
const ENOTDIR = -20
const EEXIST = -17
const ENOTEMPTY = -66 // macOS; Linux is -39 — fuse-native normalizes.
const EIO = -5

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
  agentId?: string
  rootPrefix?: string
}

export class MirageFS {
  private readonly ws: Workspace
  readonly agentId: string
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

  constructor(ws: Workspace, options: MirageFSOptions = {}) {
    this.ws = ws
    this.agentId =
      options.agentId ??
      process.env[ENV_AGENT_ID] ??
      `agent-${Math.random().toString(36).slice(2, 10)}`
    this.now = new Date()
    this.root = options.rootPrefix !== undefined ? rstripSlash(options.rootPrefix) : ''
    // When scoped to a single mount, the FUSE root maps onto that mount and
    // there are no virtual intermediate directories to synthesize.
    this.prefixes = this.root === '' ? ws.mounts().map((m) => m.prefix) : []
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 0
    this.gid = typeof process.getgid === 'function' ? process.getgid() : 0
  }

  // ── helpers ──────────────────────────────────────────────────────

  private resolve(path: string): string {
    if (this.root === '') return path
    return path === '/' ? this.root : this.root + path
  }

  private whoamiContent(): Uint8Array {
    const lines = [`agent: ${this.agentId}`, 'cwd: /', `mounts: ${this.prefixes.join(', ')}`]
    return new TextEncoder().encode(lines.join('\n') + '\n')
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
    return {
      readdir: this.readdir.bind(this),
      getattr: this.getattr.bind(this),
      fgetattr: this.fgetattr.bind(this),
      open: this.open.bind(this),
      read: this.read.bind(this),
      write: this.write.bind(this),
      create: this.create.bind(this),
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
  }

  private getattr(path: string, cb: Cb<FuseAttr>): void {
    void (async () => {
      if (path === '/' || path === MIRAGE_DIR) {
        cb(0, this.dirStat())
        return
      }
      if (path === MIRAGE_WHOAMI) {
        cb(0, this.fileStat(this.whoamiContent().byteLength))
        return
      }
      // macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
      // Reject early to avoid hitting the ops layer.
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (isMacosMetadata(name)) {
        cb(ENOENT)
        return
      }
      if (this.isVirtualDir(path)) {
        cb(0, this.dirStat())
        return
      }
      try {
        const s = await this.ws.fs.stat(this.resolve(path))
        if (s.type === FileType.DIRECTORY) {
          cb(0, this.dirStat())
          return
        }
        // Size-unknown API files stat as 0 before open (never a fake size):
        // the mount's direct_io makes the kernel read to EOF regardless, and
        // attrTimeout '0' routes the post-open fstat to fgetattr, which
        // serves the real hydrated size. Mirrors Python's fs.py; see the
        // CLAUDE.md FUSE section.
        let size = s.size
        size ??= this.cachedSize(path) ?? 0
        cb(0, this.fileStat(size))
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
      // `/.mirage/` virtual dir — a single pseudo file.
      if (path === MIRAGE_DIR) {
        cb(0, ['.', '..', 'whoami'])
        return
      }
      const names = new Set(this.virtualChildren(path))
      if (path === '/') names.add('.mirage')
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
      if (path === MIRAGE_WHOAMI) {
        const data = this.whoamiContent()
        const slice = data.subarray(pos, pos + len)
        buf.set(slice, 0)
        cb(slice.byteLength)
        return
      }
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
        await this.ws.fs.mkdir(this.resolve(path))
        cb(0)
      } catch (err) {
        cb(classifyError(err))
      }
    })()
  }

  private unlink(path: string, cb: (code: number) => void): void {
    void (async () => {
      try {
        await this.ws.fs.unlink(this.resolve(path))
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
        await this.ws.fs.rename(this.resolve(src), this.resolve(dst))
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
        await this.ws.fs.rmdir(this.resolve(path))
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
      if (path === MIRAGE_WHOAMI) {
        const fh = this.nextFh++
        this.handles.set(fh, { path })
        cb(0, fh)
        return
      }
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

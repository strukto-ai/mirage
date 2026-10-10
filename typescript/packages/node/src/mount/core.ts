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

import { constants as fsConstants } from 'node:fs'
import { posix } from 'node:path'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import {
  ChunkedHandle,
  FileTable,
  overlaid,
  writeRuns,
} from '@struktoai/mirage-core/runtime/handles/index'
import { READ_CHUNK } from '@struktoai/mirage-core/runtime/handles/constants'
import { classify } from '@struktoai/mirage-core/errors/index'
import { FileStat, FileType, LIVE_KEY } from '@struktoai/mirage-core/types'
import type { SetAttrFields } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import {
  DIR_MODE,
  DIR_SIZE,
  FILE_MODE,
  atimeMs,
  contentSize,
  deviceRdev,
  isDir,
  isLink,
  mtimeMs,
  posixMode,
} from '@struktoai/mirage-core/utils/stat_view'
import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { skippedAtDispatch } from '@struktoai/mirage-core/policy/match/rule'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { isMacosMetadata } from './platform/macos.ts'
import type { MountAttrs, Handle } from './types.ts'

export interface MountCoreOptions {
  rootPrefix?: string
  /**
   * Bind every op to this session's mount grants. The kernel-tier
   * primitive: bind-mount the tree into a container and the narrowing
   * travels with it. Enforcement happens inside dispatch/Files via the
   * session context, so binding at the op entry point is sufficient.
   */
  session?: SessionState
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
 * Every op goes through `ws.vfs`, which delegates to the dispatcher, so
 * a mount walks the same dispatcher as a shell line (mount modes, policies,
 * cache, invalidation) and every op it runs lands on the `ws.vfs.records`
 * ledger. Reaching `ws.dispatch` from here instead would skip the record;
 * reaching a backend directly would skip the dispatcher.
 */
export class MountCore {
  readonly files: Files
  readonly session: SessionState | null
  private readonly now: Date
  private readonly root: string
  readonly handles = new FileTable<Handle>()
  // One hydration read per file identity at a time: opens of the same
  // size-unknown file while one is out share it.
  private readonly hydrations = new Map<string, Promise<Uint8Array | undefined>>()
  // Bumped whenever the file changes underneath a hydration in flight, so a
  // read that started before a truncate or write cannot hand a handle the
  // bytes it fetched as the file's current content. An entry exists only
  // while that file's hydration is out.
  private readonly hydrationGen = new Map<string, number>()
  // One chain per file identity that persists and truncations join in
  // order, so a truncate cannot slip in between a flush detaching its
  // buffer and that buffer landing, which would let the flush restore the
  // old body over a truncation that already succeeded.
  private readonly pending = new Map<string, Promise<void>>()
  // One chain per file identity that its removals (an unlink, a rename
  // onto it) join, which an open of the file waits out: see `removing`.
  private readonly removals = new Map<string, Promise<void>>()
  private readonly uid: number
  private readonly gid: number

  constructor(files: Files, options: MountCoreOptions = {}) {
    this.files = files
    this.now = new Date()
    this.root = options.rootPrefix !== undefined ? rstripSlash(options.rootPrefix) : ''
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 0
    this.gid = typeof process.getgid === 'function' ? process.getgid() : 0
    this.session = options.session ?? null
    const skipped = this.session === null ? [] : skippedAtDispatch(this.session.commands)
    if (this.session !== null && skipped.length > 0) {
      // This entry point sees ops, never a line, so the profile's command-level
      // rules have nothing here to judge.
      console.warn(
        `session ${this.session.sessionId}: an entry point that sees only ops (a kernel mount, ` +
          `SFTP, codex-exec's file calls) cannot apply ${skipped.join('; ')}; path rules, ` +
          'hides and modes still hold',
      )
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  /**
   * Run one op under the bound session's mount grants and profile, as the
   * Python MountCore binds each op: dispatch reads the session from
   * context, so binding at the op entry point is what scopes a kernel or
   * SFTP mount to it. Unbound, an op runs as whatever session is current.
   */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    return this.session === null ? fn() : runWithSession(this.session, fn)
  }

  resolve(path: string): string {
    if (this.root === '') return path
    return path === '/' ? this.root : this.root + path
  }

  dirStat(): MountAttrs {
    return {
      mtime: this.now,
      atime: this.now,
      ctime: this.now,
      nlink: 2,
      size: DIR_SIZE,
      mode: DIR_MODE,
      uid: this.uid,
      gid: this.gid,
      rdev: 0,
    }
  }

  /**
   * The attrs for one stat row, the way a guest's stat reads it. The row
   * carries the namespace overlay (chmod bits, chown ids, a touched mtime),
   * so what a metadata op stored is what the mount shows, and a device
   * keeps its type and numbers. String uid/gid (names) fall back to the
   * mounting user: the kernel wants numbers and there is no user db to map
   * against. A missing stamp falls back to the mount's start time; epoch
   * zero is a real time and lands. `size` replaces the row's, from an open
   * handle or a link's shown target. Mirrors Python's `MountCore.attrs`.
   */
  attrs(s: FileStat, size: number | null = null): MountAttrs {
    const mtime = mtimeMs(s)
    const when = mtime === null ? this.now : new Date(mtime)
    const atime = atimeMs(s)
    return {
      mtime: when,
      atime: atime === null ? when : new Date(atime),
      ctime: when,
      nlink: isDir(s) ? 2 : 1,
      size: size ?? contentSize(s),
      mode: posixMode(s),
      uid: typeof s.uid === 'number' ? s.uid : this.uid,
      gid: typeof s.gid === 'number' ? s.gid : this.gid,
      rdev: deviceRdev(s),
    }
  }

  /**
   * The target to present for a link at a mount path. Relative targets are
   * stored verbatim and returned as-is. Absolute targets name virtual
   * paths, so they are rewritten relative to the link's directory: returned
   * raw, the kernel would resolve them against the host root and escape
   * the mountpoint.
   */
  shownTarget(path: string, target: string): string {
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

  /**
   * The length of the bytes an open handle on the file holds. A size-unknown
   * file is read whole when it opens, so while a handle is open its length
   * answers a stat by path too (`ls -l` beside a `cat`). Once every handle
   * is released, the dispatcher answers from the workspace cache instead.
   * Mirrors Python's `held_size`.
   */
  heldSize(path: string): number | null {
    const key = this.identity(path)
    for (const ctx of this.handles.values()) {
      if (ctx.key === key && ctx.data !== undefined) return ctx.data.byteLength
    }
    return null
  }

  /**
   * Read a size-unknown file whole for the handle opening it, through the
   * dispatcher, so a caching mount keeps the bytes for the next open and for
   * a stat once this one closes. Undefined when the read fails: open() stays
   * permissive and the read() that follows surfaces the error. Mirrors
   * Python's `_hydrate`.
   */
  private hydrate(path: string): Promise<Uint8Array | undefined> {
    const key = this.identity(path)
    const inflight = this.hydrations.get(key)
    if (inflight !== undefined) return inflight
    const promise = (async (): Promise<Uint8Array | undefined> => {
      try {
        for (;;) {
          const gen = this.hydrationGen.get(key) ?? 0
          const data = await this.op(() => this.files.read(this.resolve(path)))
          // The file changed while this read was out: what came back is
          // stale, so read again rather than hand it over.
          if ((this.hydrationGen.get(key) ?? 0) !== gen) continue
          return data
        }
      } catch (err) {
        console.debug(`fuse: hydration read of ${path} failed, deferring to read(): ${String(err)}`)
        return undefined
      } finally {
        this.hydrations.delete(key)
        this.hydrationGen.delete(key)
      }
    })()
    this.hydrations.set(key, promise)
    return promise
  }

  /**
   * Run one mutation of a file after every mutation already queued for
   * it, and let the next one wait for it. Serialization is per identity,
   * so a flush through a link and a truncate through its target queue
   * behind each other, and a flush still landing cannot be overtaken by a
   * truncate that would then be undone when the flush completes.
   */
  private mutate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.queue(this.pending, key, fn)
  }

  /**
   * Run `fn`, which removes or replaces the file at `path`, with opens of
   * that file held back until it is done, as the kernel orders an open
   * and an unlink of one name. `hold` reads the rest for the handles open
   * before; an open that slipped in while that read was out would get a
   * chunked handle onto bytes about to go. A chain of its own rather than
   * `pending`, which a rename holds for its source: holding the target's
   * there too would let two renames that cross wait on each other.
   */
  private removing(path: string, fn: () => Promise<void>): Promise<void> {
    return this.queue(this.removals, this.identity(path), fn)
  }

  /**
   * Run `fn` after every call already queued under `key` in `queues`, and
   * let the next one wait for it, whether it resolves or throws.
   */
  private queue<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }

  /**
   * Land write runs on the mount, one pwrite each, in order. A pwrite keeps
   * every stored byte the handle did not write, so nothing is read through
   * the dispatcher first: a session that may write a file and not read it writes
   * through FUSE, as through a write-only descriptor. The runs that landed
   * leave `runs` in one step, so after a failure `runs` holds only what did
   * not land and a retry never replays a run over bytes another writer has
   * since put there. A run that fails still invalidates what the core holds,
   * since the runs before it have landed.
   */
  private async applyWrites(path: string, runs: [number, Uint8Array][]): Promise<void> {
    const target = this.resolve(path)
    let landed = 0
    try {
      for (const [offset, data] of runs) {
        await this.op(() => this.files.pwrite(target, data, offset))
        landed += 1
      }
    } finally {
      runs.splice(0, landed)
      await this.changed(path)
    }
  }

  // ── POSIX surface (throws; adapters classify) ────────────────────

  /**
   * POSIX attributes for a path. One stat through the dispatcher answers: a
   * link the session cannot see is absent, as it is to the shell, and a
   * visible one reports its own row with its target read through the
   * dispatcher too. `follow` reports a trailing link's target rather than
   * the link (stat rather than lstat).
   */
  async getattr(path: string, follow = false, ctx: Handle | null = null): Promise<MountAttrs> {
    let size = ctx?.data?.byteLength ?? null
    if (path === '/') return this.rootAttrs()
    // macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
    // Reject early to avoid hitting the ops layer.
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (isMacosMetadata(name)) {
      throw enoent(path)
    }
    const virtual = this.resolve(path)
    let s: FileStat
    try {
      s = await this.op(() => this.files.stat(virtual, undefined, { nofollow: !follow }))
    } catch (err) {
      // An open descriptor keeps the bytes it had after an unlink.
      if (size === null || classify(err) !== 'ENOENT') throw err
      return this.attrs(new FileStat({ name, type: FileType.FILE }), size)
    }
    if (isLink(s)) {
      const target = await this.op(() => this.files.readlink(virtual))
      return this.attrs(s, new TextEncoder().encode(this.shownTarget(path, target)).byteLength)
    }
    if (isDir(s)) return this.attrs(s)
    // A size-unknown file the cache has not seen stats as 0 (never a fake
    // size): the mount's direct_io makes the kernel read to EOF regardless,
    // and attrTimeout '0' routes the post-open fstat to fgetattr, which
    // serves the real hydrated size. Mirrors Python's core.py; see the
    // CLAUDE.md FUSE section.
    if (size === null && s.size === null) size = this.heldSize(path)
    if (ctx?.writeBuf !== undefined && ctx.writeBuf.length > 0) {
      let end = size ?? contentSize(s)
      for (const [offset, data] of ctx.writeBuf) end = Math.max(end, offset + data.byteLength)
      size = end
    }
    return this.attrs(s, size)
  }

  /**
   * Attributes through an open handle: the path's row, with the size the
   * handle holds, what it wrote and has not flushed included.
   */
  async fgetattr(path: string, fd: number): Promise<MountAttrs> {
    // fstat(fd) after open: the open handler hydrated size-unknown files
    // into the handle, so answer with the real byte length instead of the
    // 0 that path-based getattr reported before open.
    const ctx = this.handles.get(fd) ?? null
    // A flush still landing has taken the handle's buffer: wait for it, so
    // the size counts what it wrote.
    if (ctx !== null) await this.pending.get(ctx.key)
    // The handle is open on the file a link led to, so its stat is the
    // target's.
    return this.getattr(ctx?.path ?? path, ctx !== null, ctx)
  }

  /**
   * The mount root's attrs: its own row through the dispatcher, so a chmod
   * made on it shows, or a plain directory when nothing answers for it (a
   * workspace with no mount at `/`). Mirrors Python's `root_attrs`.
   */
  async rootAttrs(): Promise<MountAttrs> {
    let s: FileStat
    try {
      s = await this.op(() => this.files.stat(this.resolve('/')))
    } catch (err) {
      if (classify(err) !== 'ENOENT') throw err
      console.debug(`fuse: the mount root has no row of its own: ${String(err)}`)
      return this.dirStat()
    }
    return this.attrs(s)
  }

  async readdir(path: string): Promise<string[]> {
    // The workspace dispatcher merges namespace structure (child mounts
    // and symlinks) into readdir and answers structure-only directories
    // itself, so the core only normalizes entry shapes and drops macOS
    // metadata names.
    const names = new Set<string>()
    const entries = await this.op(() => this.files.readdir(this.resolve(path)))
    for (const e of entries) {
      const part = rstripSlash(e).split('/').pop() ?? ''
      if (part !== '' && !isMacosMetadata(part)) names.add(part)
    }
    return ['.', '..', ...[...names].sort(compareCodePoints)]
  }

  async read(path: string, fd: number, pos: number, len: number): Promise<Uint8Array> {
    // Filetype-aware read: no `raw: true`, so an extension with a
    // registered renderer surfaces as rendered text. Mirage registers
    // none by default, so this reads raw bytes until a mount adds one.
    // Matches Python's MountCore.read, which also dispatches.
    const ctx = this.handles.get(fd)
    // A flush still landing has taken the handle's buffer and not yet
    // refreshed its bytes: wait for it, so the read sees what was written.
    if (ctx !== undefined) await this.pending.get(ctx.key)
    if (ctx === undefined) {
      // Whole, as a handle's first read is: the read that fills the cache
      // and records the version a conditional write sends.
      const data = await this.op(() => this.files.read(this.resolve(path)))
      return data.subarray(pos, pos + len)
    }
    let stored: Uint8Array
    if (ctx.live === true) {
      stored = await this.op(() =>
        this.files.read(this.resolve(ctx.path), { offset: pos, size: len }),
      )
    } else if (ctx.chunked !== undefined && ctx.data === undefined) {
      stored = await ctx.chunked.pread(pos, len)
    } else {
      ctx.data ??= await this.op(() => this.files.read(this.resolve(ctx.path)))
      stored = ctx.data.subarray(pos, pos + len)
    }
    if (ctx.writeBuf === undefined || ctx.writeBuf.length === 0) return stored
    return overlaid(stored, pos, len, ctx.writeBuf)
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

  /**
   * Create an empty file and return a fresh handle. `mode` is what the
   * creator asked for, umask applied; null takes the mount's default.
   */
  async create(path: string, mode: number | null = null): Promise<number> {
    const key = this.identity(path)
    await this.mutate(key, async () => {
      await this.op(() => this.files.create(this.resolve(path)))
      await this.keepMode(path, mode, FILE_MODE)
      await this.changed(path)
    })
    return this.handles.add({ path, key })
  }

  /** Create a directory, keeping the mode it was asked for. */
  async mkdir(path: string, mode: number | null = null): Promise<void> {
    await this.op(() => this.files.mkdir(this.resolve(path)))
    await this.keepMode(path, mode, DIR_MODE)
  }

  /**
   * Store the mode a create asked for, when it is not the one the mount
   * reports anyway, so `open(O_CREAT, 0600)` and `mkdir -m` read back as
   * asked without a write per ordinary create. Mirrors Python's
   * `_keep_mode`.
   */
  private async keepMode(path: string, mode: number | null, fallback: number): Promise<void> {
    if (mode !== null && (mode & 0o7777) !== (fallback & 0o7777)) await this.setattr(path, mode)
  }

  /** The target of a namespace link, read through the dispatcher; EINVAL when not a link. */
  async readlink(path: string): Promise<string> {
    const target = await this.op(() => this.files.readlink(this.resolve(path)))
    return this.shownTarget(path, target)
  }

  /**
   * Create namespace link `dest -> src` (ln -s src dest; libfuse passes
   * the pointee first). Relative sources are stored verbatim (resolved
   * at follow time, exactly like the shell `ln -s`); absolute sources
   * are mapped into virtual space so a scoped mount stores the path it
   * will later follow.
   */
  async symlink(src: string, dest: string): Promise<void> {
    // The write routes through the dispatcher like every other FUSE op, so
    // session grants and admission policies refuse a scoped kernel
    // mount exactly like a scoped shell.
    const stored = src.startsWith('/') ? this.resolve(src) : src
    await this.op(() => this.files.symlink(this.resolve(dest), stored))
  }

  /**
   * Remove the entry at `path`, a link entry like any other.
   *
   * A link routes through the dispatcher rather than straight to the node
   * table: `unlink` is a LINK_ENTRY_OPS member, so the dispatcher answers a
   * link path itself, gated by session grants and admission policies
   * and recorded on the ledger. Writing the table here instead let a
   * session-scoped kernel mount delete a link on a mount its profile
   * hides. Mirrors Python's MountCore.unlink.
   */
  async unlink(path: string): Promise<void> {
    await this.mutate(this.identity(path), async () => {
      await this.removing(path, async () => {
        await this.hold(path)
        await this.op(() => this.files.unlink(this.resolve(path)))
      })
      await this.changed(path, false)
    })
  }

  /**
   * The one function every mutation of a file's bytes goes through. The
   * open handles on a file are matched by its identity (the mount path with
   * namespace links followed), and this is the only place their bytes are
   * refreshed, so a new mutating op cannot forget one of them and a link
   * alias cannot slip past. A hydration still in flight is outdated so it
   * re-reads instead of handing over what it fetched, and hydrated handles
   * on the file are refreshed in one read through the dispatcher, so fstat
   * and read through any of them, including the handle that wrote, see the
   * new bytes. A removal or rename passes `rehydrate = false`: POSIX keeps
   * an open descriptor on the bytes it had. A refresh that fails is logged
   * and leaves the handles unhydrated rather than failing the committed
   * mutation. Mirrors Python's `_changed`.
   */
  private async changed(path: string, rehydrate = true): Promise<void> {
    const key = this.identity(path)
    if (this.hydrations.has(key)) {
      this.hydrationGen.set(key, (this.hydrationGen.get(key) ?? 0) + 1)
    }
    if (!rehydrate) return
    for (const ctx of this.handles.values()) {
      if (ctx.key === key) ctx.chunked?.drop()
    }
    const hydrated = [...this.handles.values()].filter(
      (ctx) => ctx.key === key && ctx.data !== undefined,
    )
    if (hydrated.length === 0) return
    let data: Uint8Array
    try {
      data = await this.op(() => this.files.read(this.resolve(path)))
    } catch (err) {
      // The mutation has already landed, so a refresh that fails must not
      // report it as failed: an O_TRUNC open would fail after the old
      // bytes were erased, and settled writes would be retried over
      // content that already holds them. Drop the hydrated bytes instead,
      // so the next read through those handles fetches and surfaces any
      // error itself.
      console.warn(`fuse: refresh of ${path} after a change failed: ${String(err)}`)
      for (const ctx of hydrated) delete ctx.data
      return
    }
    for (const ctx of hydrated) ctx.data = data
  }

  async rename(src: string, dst: string): Promise<void> {
    // The facade is where a cross-mount pair is refused with EXDEV,
    // which is what makes `mv` between two backends fall back to
    // copy+unlink instead of addressing the destination against the
    // source's backend.
    await this.mutate(this.identity(src), async () => {
      const source = this.resolve(src)
      const target = this.resolve(dst)
      await this.removing(dst, async () => {
        await this.hold(dst)
        await this.op(() => this.files.rename(source, target))
      })
      for (const ctx of this.handles.values()) {
        if (ctx.key === source || ctx.key.startsWith(`${source}/`)) {
          ctx.key = target + ctx.key.slice(source.length)
          ctx.path = ctx.key.slice(this.root.length)
        }
      }
      await this.changed(src, false)
      await this.changed(dst, false)
    })
  }

  // No emptiness pre-check here, matching the python MountCore. Every
  // backend's rmdir op refuses a non-empty directory itself, so a listing
  // first was one extra round trip per call on an API-backed mount, and the
  // catch that wrapped it swallowed whatever readdir raised.
  async rmdir(path: string): Promise<void> {
    await this.op(() => this.files.rmdir(this.resolve(path)))
  }

  /**
   * Where a mount path really points: the mount-resolved path with every
   * namespace link followed, so two handles opened through a link and
   * its target are recognised as the same file.
   */
  identity(path: string): string {
    const virtual = this.resolve(path)
    const links = this.files.links
    return links === null ? virtual : links.follow(virtual)
  }

  /**
   * Persist a handle's buffered writes. The buffer is detached before the
   * await so a write arriving meanwhile is not lost to the clear, and the
   * runs that did not land are restored ahead of those later writes when
   * persistence fails, so the acknowledged bytes stay for the handle's own
   * flush to retry.
   */
  private settle(ctx: Handle): Promise<void> {
    if (ctx.writeBuf === undefined || ctx.writeBuf.length === 0) return Promise.resolve()
    return this.mutate(ctx.key, () => this.persistBuffered(ctx))
  }

  private async persistBuffered(ctx: Handle): Promise<void> {
    if (ctx.writeBuf === undefined || ctx.writeBuf.length === 0) return
    const runs = writeRuns(ctx.writeBuf)
    ctx.writeBuf = []
    try {
      await this.applyWrites(ctx.path, runs)
    } catch (err) {
      ctx.writeBuf = [...runs, ...ctx.writeBuf]
      throw err
    }
  }

  async truncate(path: string, size: number): Promise<void> {
    // A write the kernel already acknowledged on another handle precedes
    // this truncation in POSIX order, so it is flushed first rather than
    // left queued to land over the shortened file at that handle's
    // release. Handles are matched by identity, not by the path they
    // were opened through, so a link alias is settled too. Mirrors
    // Python's MountCore.truncate.
    const key = this.identity(path)
    await this.mutate(key, async () => {
      for (const ctx of this.handles.values()) {
        if (ctx.key === key) await this.persistBuffered(ctx)
      }
      await this.op(() => this.files.truncate(this.resolve(path), size))
      await this.changed(path)
    })
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

  /**
   * Store metadata through the dispatcher. The backend keeps what it can and
   * the namespace overlay the rest, so a chmod, chown or `touch -d` through
   * the mount is what `stat` in a shell reads back, on a backend with no
   * permission bits or settable times of its own too. A null field is left
   * as it is. Mirrors Python's `MountCore.setattr`.
   */
  async setattr(
    path: string,
    mode: number | null,
    uid: number | null = null,
    gid: number | null = null,
    atime: Date | null = null,
    mtime: Date | null = null,
  ): Promise<void> {
    // The kernel has already resolved any link the call follows, so the
    // path names the entry to change, a link itself for `chown -h`.
    const fields: SetAttrFields = { nofollow: true }
    if (mode !== null) fields.mode = mode & 0o7777
    if (uid !== null) fields.uid = uid
    if (gid !== null) fields.gid = gid
    if (atime !== null) fields.atime = atime.toISOString()
    if (mtime !== null) fields.mtime = mtime.toISOString()
    const store = (): Promise<unknown> =>
      this.op(() => this.files.setattr(this.resolve(path), fields))
    if (atime === null && mtime === null) {
      await store()
      return
    }
    const key = this.identity(path)
    await this.mutate(key, async () => {
      // Writes the kernel acknowledged before the times were set precede
      // them in POSIX order; landed later, they would stamp over them (cp -p
      // sets the times on the file it still holds open). Mirrors Python.
      for (const ctx of this.handles.values()) {
        if (ctx.key === key) await this.persistBuffered(ctx)
      }
      await store()
    })
  }

  /**
   * Store an extended attribute through the dispatcher, which keeps
   * it on the path's namespace node: it outlives the mount, moves with a
   * rename, and is the attribute every other surface (the shell's
   * getfattr, a guest's os.getxattr) reads. Tools that set xattrs as a
   * matter of course (rsync -aX, tar --xattrs, cp -p, Finder writing
   * com.apple.*) succeed on a backend with no attribute slot of its own.
   * Mirrors the python MountCore.
   */
  async setxattr(
    path: string,
    name: string,
    value: Uint8Array,
    opts: { create?: boolean; replace?: boolean } = {},
  ): Promise<void> {
    await this.op(() => this.files.setxattr(this.resolve(path), name, Uint8Array.from(value), opts))
  }

  /** One attribute, the backend's own facts included; ENODATA when unset. */
  async getxattr(path: string, name: string): Promise<Uint8Array> {
    return this.op(() => this.files.getxattr(this.resolve(path), name))
  }

  async listxattr(path: string): Promise<string[]> {
    return this.op(() => this.files.listxattr(this.resolve(path)))
  }

  async removexattr(path: string, name: string): Promise<void> {
    await this.op(() => this.files.removexattr(this.resolve(path), name))
  }

  async open(path: string, flags = 0): Promise<number> {
    await this.removals.get(this.identity(path))
    const s = await this.op(() => this.files.stat(this.resolve(path)))
    const ctx: Handle = { path, key: this.identity(path), live: s.extra[LIVE_KEY] === true }
    if (s.type === FileType.DIRECTORY) return this.handles.add(ctx)
    if ((flags & fsConstants.O_TRUNC) !== 0) {
      // libfuse 3 negotiates FUSE_CAP_ATOMIC_O_TRUNC by default, so the
      // kernel sends no SETATTR ahead of an O_TRUNC open: the flag on the
      // open is the whole truncation. libfuse 2 (what fuse-native and
      // macFUSE speak) strips the flag and truncates through setattr
      // first, so this branch is what keeps a shorter overwrite from
      // holding the old tail once the kernel stops doing that for us
      // (#1032). Mirrors Python's MountCore.open.
      await this.truncate(path, 0)
    }
    if (ctx.live === true) return this.handles.add(ctx)
    if (s.size === null) {
      // Hydrate through the rendered read path, after an O_TRUNC too: an
      // extension whose renderer gives an empty file a body is honored
      // rather than shadowed by literal raw emptiness.
      const data = await this.hydrate(path)
      if (data !== undefined) ctx.data = data
    } else if (s.size > READ_CHUNK && (flags & fsConstants.O_TRUNC) === 0) {
      // A file larger than a chunk is read a chunk at a time: the kernel
      // asks in small pieces, and fetching the whole file on the first one
      // moved all of it to answer a `head`. Mirrors Python's MountCore.open.
      // The fetch reads the handle's path as it is then: a rename moves it.
      ctx.chunked = new ChunkedHandle(path, s.size, (offset, size) =>
        this.op(() => this.files.read(this.resolve(ctx.path), { offset, size })),
      )
    }
    return this.handles.add(ctx)
  }

  /**
   * Read the rest of the chunked handles on `path` before it goes. POSIX
   * keeps an open descriptor on the bytes it had, and a chunked handle
   * holds one chunk of them, so an unlink or a rename onto the file would
   * leave the rest unreadable. One read serves every such handle; it runs
   * under `removing`, so no handle opens on the file meanwhile. A read
   * that fails (a policy may allow the removal and refuse the read) leaves
   * them chunked rather than refusing a mutation the caller is allowed.
   * Mirrors Python's `MountCore._hold`.
   */
  private async hold(path: string): Promise<void> {
    const key = this.identity(path)
    const held = [...this.handles.values()].filter(
      (ctx) => ctx.key === key && ctx.chunked !== undefined,
    )
    if (held.length === 0) return
    const virtual = this.resolve(path)
    let data: Uint8Array
    try {
      const own = await this.op(() => this.files.stat(virtual, undefined, { nofollow: true }))
      // Removing a link entry takes the link, never its target's bytes.
      if (isLink(own)) return
      data = await this.op(() => this.files.read(virtual))
    } catch (err) {
      console.warn(`fuse: holding ${path} before it goes failed: ${String(err)}`)
      return
    }
    for (const ctx of held) {
      ctx.data = data
      delete ctx.chunked
    }
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

  async flush(_path: string, fd: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx !== undefined) await this.settle(ctx)
  }
}

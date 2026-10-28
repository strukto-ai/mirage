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

import { type Files, readerOf } from '../workspace/files.ts'
import {
  ChunkedHandle,
  FileTable,
  READ,
  overlaid,
  runGroups,
  runStream,
  windowWrites,
  writeRuns,
  type OpenMode,
} from '../runtime/handles/index.ts'
import { ByteSlice, ByteSpool, MEMORY_LIMIT } from '../io/spool.ts'
import { materialize } from '../io/types.ts'
import { READ_CHUNK } from '../runtime/handles/constants.ts'
import { ConcurrencyLimiter } from '../concurrency/limiter.ts'
import { FSTAT_ROW_SECONDS, LISTING_CONCURRENCY } from './constants.ts'
import { classify } from '../errors/index.ts'
import { FileStat, FileType, LIVE_KEY, PathSpec } from '../types.ts'
import type { SetAttrFields } from '../types.ts'
import { parent, posixNormpath } from '../utils/path.ts'
import { rstripSlash } from '../utils/slash.ts'
import { compareCodePoints } from '../utils/sort.ts'
import {
  DIR_MODE,
  DIR_SIZE,
  atimeMs,
  contentSize,
  deviceRdev,
  isDir,
  isLink,
  mtimeMs,
  posixMode,
} from '../utils/stat_view.ts'
import { callsAs, currentCaller, runWithSession } from '../context/session_context.ts'
import { skippedAtDispatch } from '../policy/match/rule.ts'
import type { SessionState } from '../workspace/session/session.ts'
import {
  ebadf,
  eexist,
  einval,
  eisdir,
  enoent,
  enotdir,
  isMissingOp,
  isMissingPath,
} from '../errors/fs.ts'
import { concat, findBytes } from '../utils/bytes.ts'
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
  /**
   * Who owns what the mount shows when a row names its owner by name (the
   * kernel wants numbers): the mounting user, which a kernel adapter reads
   * off its process. A guest owns nothing, so it defaults to 0.
   */
  owner?: { uid: number; gid: number }
}

// An entry a listing's stat no longer finds went between the two.
const VANISHED: ReadonlySet<string | null> = new Set(['ENOENT', 'ENOTDIR'])

// One cap for the listings that run at once, as Python keeps one per loop.
const STATS = new ConcurrencyLimiter(LISTING_CONCURRENCY)

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
  // The write runs `folded` grew, whose buffers have room past them.
  private static readonly grown = new WeakSet<Uint8Array>()
  // Per file identity and view (stored or rendered): the hydration read out
  // (opens share it) and a generation a change under it bumps. Per identity:
  // the chain of mutations, the chain of removals, and the opens out that a
  // removal waits for.
  private readonly hydrations = new Map<string, Promise<Uint8Array | undefined>>()
  private readonly hydrationGen = new Map<string, number>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly removals = new Map<string, Promise<void>>()
  private readonly opening = new Map<string, Set<Promise<void>>>()
  private readonly uid: number
  private readonly gid: number
  // The mounts that refused an append, which land one as a write.
  private readonly noAppend = new Set<string>()
  // Names the files whose name went, one per removal.
  private removed = 0

  constructor(files: Files, options: MountCoreOptions = {}) {
    this.files = files
    this.now = new Date()
    this.root = options.rootPrefix !== undefined ? rstripSlash(options.rootPrefix) : ''
    this.uid = options.owner?.uid ?? 0
    this.gid = options.owner?.gid ?? 0
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

  /** Judge retained metadata through the stat policy boundary. */
  private async statCached(path: string, row: FileStat): Promise<FileStat> {
    const [result] = await this.op(() =>
      this.files.dispatch('stat', PathSpec.fromStrPath(this.resolve(path), undefined, '/'), [], {
        retained: row,
      }),
    )
    return result as FileStat
  }

  /** Judge retained bytes through the same read boundary as a fetch. */
  private async readCached(path: string, data: Uint8Array): Promise<Uint8Array> {
    const [result] = await this.op(() =>
      this.files.dispatch('read', PathSpec.fromStrPath(this.resolve(path), undefined, '/'), [], {
        retained: data,
      }),
    )
    return result as Uint8Array
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
    const from = (slash <= 0 ? '' : posixNormpath(path.slice(0, slash))).split('/').filter(Boolean)
    const to = posixNormpath(virtualTarget).split('/').filter(Boolean)
    let shared = 0
    while (shared < from.length && from[shared] === to[shared]) shared++
    // A target that is the link's own directory is `.`, as Python's relpath
    // names it.
    return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/') || '.'
  }

  /**
   * The length of the bytes an open handle on the file holds. A size-unknown
   * file is read whole when it opens, so while a handle is open its length
   * answers a stat by path too (`ls -l` beside a `cat`). Once every handle
   * is released, the dispatcher answers from the workspace cache instead.
   * Mirrors Python's `held_size`.
   */
  heldSize(path: string): number | null {
    for (const ctx of this.openOn(this.identity(path))) {
      if (ctx.data !== undefined) return ctx.data.byteLength
    }
    return null
  }

  /**
   * Read a size-unknown file whole for the handle opening it, through the
   * dispatcher, so a caching mount keeps the bytes for the next open and for
   * a stat once this one closes. Undefined when the read fails: open() stays
   * permissive and the read() that follows surfaces the error. Opens of one
   * view of one file while a read is out share it; `raw` is the stored
   * bytes, for a handle that writes, rather than the rendering. Mirrors
   * Python's `_hydrate`.
   */
  private hydrate(path: string, raw: boolean): Promise<Uint8Array | undefined> {
    const key = MountCore.view(this.identity(path), raw)
    const inflight = this.hydrations.get(key)
    if (inflight !== undefined) return inflight
    const promise = (async (): Promise<Uint8Array | undefined> => {
      try {
        for (;;) {
          const gen = this.hydrationGen.get(key) ?? 0
          const data = await this.op(() =>
            this.files.read(this.resolve(path), MountCore.stored(raw)),
          )
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
   * Run `fn` holding the chain of every key, taken in sorted order so two
   * callers that hold the same pair never wait on each other. Mirrors
   * Python's `_queue_all`.
   */
  private queueAll<T>(
    queues: Map<string, Promise<void>>,
    keys: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const [first = '', ...rest] = [...new Set(keys)].sort(compareCodePoints)
    if (rest.length === 0) return this.queue(queues, first, fn)
    return this.queue(queues, first, () => this.queueAll(queues, rest, fn))
  }

  /**
   * Run `fn`, which removes, replaces or moves the files at `paths`, after
   * the opens of those names already out, with later ones held back until
   * it is done, as the kernel orders an open and an unlink or a rename of
   * one name. `hold` reads the rest for the handles open before; an open
   * that slipped in while that read was out would get a chunked handle onto
   * bytes about to go. Chains of their own, taken before any `pending` one,
   * rather than `pending` itself: an open they wait for may be truncating
   * there.
   */
  private removing(paths: string[], fn: () => Promise<void>): Promise<void> {
    const keys = paths.map((path) => this.identity(path, false))
    return this.queueAll(this.removals, keys, async () => {
      await Promise.all(keys.flatMap((key) => [...(this.opening.get(key) ?? [])]))
      await fn()
    })
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
   * through FUSE, as through a write-only descriptor. An appending handle's
   * runs land as appends instead, at the end the file has then, so what
   * another writer appended meanwhile stays before them, as O_APPEND keeps
   * it. The runs that landed leave `runs` in one step, so after a failure
   * `runs` holds only what did not land and a retry never replays a run over
   * bytes another writer has since put there. A run that fails still
   * invalidates what the core holds, since the runs before it have landed.
   */
  private async applyWrites(
    path: string,
    runs: [number, Uint8Array][],
    append = false,
  ): Promise<void> {
    const target = this.resolve(path)
    let landed = 0
    try {
      for (const [offset, data] of runs) {
        if (append) await this.appendTo(target, data)
        else await this.op(() => this.files.pwrite(target, data, offset))
        landed += 1
      }
    } finally {
      runs.splice(0, landed)
      await this.changed(path)
    }
  }

  /**
   * Extend a file by `data` at the end it has now. A mount with no append
   * (S3) takes a write of the whole file, read fresh from the backend
   * rather than from a copy, so a write another action made since stays; a
   * mount that declined once is remembered. Mirrors Python's `_append`.
   */
  private async appendTo(
    target: string,
    data: Uint8Array | [number, Uint8Array | ByteSlice][],
  ): Promise<void> {
    const mount = this.files.mountOf(target) ?? target
    if (!this.noAppend.has(mount)) {
      try {
        await this.op(() =>
          this.files.append(target, data instanceof Uint8Array ? data : runStream(data)),
        )
        return
      } catch (err) {
        if (!isMissingOp(err, 'append')) throw err
        this.noAppend.add(mount)
      }
    }
    const bytes = data instanceof Uint8Array ? data : await materialize(runStream(data))
    let base: Uint8Array = new Uint8Array()
    try {
      const [stored] = await this.op(() =>
        this.files.dispatch('read', PathSpec.fromStrPath(target, undefined, '/'), [], {
          filetype: null,
          direct: true,
        }),
      )
      base = stored as Uint8Array
    } catch (err) {
      if (!isMissingPath(err)) throw err
    }
    await this.op(() => this.files.write(target, concat([base, bytes])))
  }

  /** The read options for one view: the stored bytes, else the rendering. */
  private static stored(raw: boolean): { raw: true } | undefined {
    return raw ? { raw } : undefined
  }

  /** The key one view of a file's hydration goes by. */
  private static view(key: string, raw: boolean): string {
    return `${raw ? 'stored' : 'rendered'}:${key}`
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
    if (path === '/') return this.rootAttrs()
    // macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
    // Reject early to avoid hitting the ops layer.
    if (isMacosMetadata(path.slice(path.lastIndexOf('/') + 1))) throw enoent(path)
    const s = await this.row(path, follow, ctx)
    if (isLink(s)) {
      const target = await this.op(() => this.files.readlink(this.resolve(path)))
      return this.attrs(s, new TextEncoder().encode(this.shownTarget(path, target)).byteLength)
    }
    return this.attrs(s)
  }

  /**
   * The row a stat of `path` answers, the size an open handle holds and what
   * it wrote and has not landed counted. Mirrors Python's `_row`.
   */
  private async row(
    path: string,
    follow: boolean,
    ctx: Handle | null,
    reuse = false,
  ): Promise<FileStat> {
    let size = ctx?.data?.byteLength ?? null
    let s: FileStat
    let retained = false
    if (ctx?.detached !== undefined) {
      // Its name is gone: it stats by the row its file had then.
      retained = true
      s = ctx.detached
    } else if (
      reuse &&
      ctx?.row !== undefined &&
      performance.now() - (ctx.rowAt ?? 0) < FSTAT_ROW_SECONDS * 1000
    ) {
      // Judged as a stat now, as a held row is, without a fetch.
      retained = true
      s = ctx.row
    } else {
      const restats = ctx?.restats ?? 0
      try {
        s = await this.op(() =>
          this.files.stat(this.resolve(path), undefined, { nofollow: !follow }),
        )
        if (ctx !== null && (ctx.restats ?? 0) === restats) {
          ctx.row = s
          ctx.rowAt = performance.now()
        }
      } catch (err) {
        if (size === null || classify(err) !== 'ENOENT') throw err
        // A hide is not an unlink: held metadata still meets the walk.
        retained = true
        s = new FileStat({ name: path.slice(path.lastIndexOf('/') + 1), type: FileType.FILE })
      }
    }
    if (isLink(s)) return s
    if (isDir(s)) return retained ? this.statCached(path, s) : s
    // A size-unknown file stats as 0 rather than be fetched on every ls -l;
    // direct_io keeps its reads whole regardless.
    if (size === null && s.size === null) size = this.heldSize(path)
    const writes = this.writesOn(ctx === null ? this.identity(path, follow) : ctx.key, ctx)
    if (writes.length > 0) {
      let end = size ?? contentSize(s)
      for (const [offset, data] of writes) end = Math.max(end, offset + data.byteLength)
      size = end
    }
    if (size !== null && size !== s.size) s = s.with({ size })
    // A row the stat above fetched was judged there; a held one is judged
    // here, with the size the handle answers.
    return retained ? this.statCached(path, s) : s
  }

  /**
   * Attributes through an open handle: the path's row, with the size the
   * handle holds, what it wrote and has not flushed included.
   */
  async fgetattr(path: string, fd: number): Promise<MountAttrs> {
    const ctx = this.handles.get(fd) ?? null
    if (ctx !== null) await this.settled(ctx)
    return this.getattr(ctx?.path ?? path, ctx !== null, ctx)
  }

  /**
   * The row a stat of `path` answers, what the handles open on it wrote and
   * have not landed counted, as a guest projects it into its own record.
   * Mirrors Python's `stat`.
   */
  async stat(path: string, follow = true): Promise<FileStat> {
    return this.row(path, follow, null)
  }

  /**
   * The row an open handle stats by: its file's, with the size it holds and
   * what it wrote and has not landed counted, judged as a stat of its path.
   * A guest projects this into its own record. Mirrors Python's `fstat`.
   */
  async fstat(fd: number): Promise<FileStat> {
    const ctx = this.openHandle(fd)
    await this.settled(ctx)
    return this.row(ctx.path, true, ctx, true)
  }

  /** The handle `fd` names; EBADF for any other number. */
  private openHandle(fd: number): Handle {
    const ctx = this.handles.get(fd)
    if (ctx === undefined) throw ebadf(String(fd))
    return ctx
  }

  /**
   * Where the file a handle holds ends: its bytes, else the length its open
   * saw, and past them what it wrote.
   */
  private static end(ctx: Handle): number {
    let end = ctx.data?.byteLength ?? ctx.chunked?.size ?? ctx.size ?? 0
    for (const [offset, data] of ctx.writeBuf ?? []) end = Math.max(end, offset + data.byteLength)
    return end
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
      s = await this.statCached('/', new FileStat({ name: '/', type: FileType.DIRECTORY }))
    }
    return this.attrs(s)
  }

  async readdir(path: string): Promise<string[]> {
    const names = new Set<string>()
    const entries = await this.op(() => this.files.readdir(this.resolve(path)))
    for (const e of entries) {
      const part = rstripSlash(e).split('/').pop() ?? ''
      if (part !== '' && !isMacosMetadata(part)) names.add(part)
    }
    return ['.', '..', ...[...names].sort(compareCodePoints)]
  }

  /**
   * A directory's entries with their attributes, in one pass. The entries
   * are stat'd together rather than one after another, with at most
   * `LISTING_CONCURRENCY` stats out at once across every listing. A stat
   * that fails ends the listing, and the ones not yet sent are not. An
   * entry that vanishes between the listing and its stat is left out, as
   * `ls` leaves out a file deleted mid-listing. `names` are the entries to
   * stat, in the order they are answered; null takes `readdir`'s, `.` and
   * `..` first. Mirrors Python's `listing`.
   */
  async listing(
    path: string,
    names: readonly string[] | null = null,
    follow = false,
  ): Promise<[string, MountAttrs][]> {
    const listed = names ?? (await this.readdir(path))
    const rows: ([string, MountAttrs] | null)[] = new Array<null>(listed.length).fill(null)
    const todo = listed.entries()
    const refused: { error?: unknown; failed: boolean } = { failed: false }
    const worker = async (): Promise<void> => {
      for (const [index, name] of todo) {
        const child =
          name === '.' ? path : name === '..' ? parent(path) : posixNormpath(`${path}/${name}`)
        const release = await STATS.acquire()
        try {
          // A listing that failed stats nothing more, a worker that was
          // waiting for a slot included.
          if (refused.failed) return
          rows[index] = [name, await this.getattr(child, follow)]
        } catch (err) {
          if (!VANISHED.has(classify(err))) {
            if (!refused.failed) Object.assign(refused, { error: err, failed: true })
            return
          }
          console.debug(`${child} vanished while listing: ${String(err)}`)
        } finally {
          release()
        }
      }
    }
    // Every worker settles before the listing answers, so none sends a stat
    // after it; the first refusal is the answer.
    await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, listed.length) }, worker))
    if (refused.failed) throw refused.error
    return rows.filter((row) => row !== null)
  }

  async read(path: string, fd: number, pos: number, len: number): Promise<Uint8Array> {
    const ctx = this.handles.get(fd)
    if (ctx === undefined) {
      // Whole, as a handle's first read is: the read that fills the cache
      // and records the version a conditional write sends.
      const data = await this.op(() => this.files.read(this.resolve(path)))
      const writes = this.writesOn(this.identity(path), null)
      if (writes.length > 0) {
        const laid = await windowWrites(writes, pos, len)
        return this.readCached(path, overlaid(data.subarray(pos), pos, len, laid))
      }
      return data.subarray(pos, pos + len)
    }
    if (!ctx.mode.readable) throw ebadf(ctx.path)
    if (ctx.lost !== undefined && ctx.data === undefined) throw ctx.lost
    await this.settled(ctx)
    // A handle that writes reads the stored bytes its writes land on; one
    // that only reads sees the rendering.
    const raw = ctx.mode.writable
    let stored: Uint8Array
    let retained = false
    if (ctx.live === true) {
      stored = await this.op(() =>
        this.files.read(this.resolve(ctx.path), {
          offset: pos,
          size: len,
          ...MountCore.stored(raw),
        }),
      )
    } else if (ctx.chunked !== undefined && ctx.data === undefined) {
      // A fetch joins what it brings onto bytes kept at `pos`, so any kept
      // byte there makes the answer held.
      retained = ctx.chunked.holds(pos, len) || ctx.chunked.peek(pos, 1).byteLength > 0
      stored = await ctx.chunked.pread(pos, len)
    } else {
      let held = ctx.data
      if (held === undefined) {
        // A change landing while this read is out keeps it from holding
        // what it fetched.
        const generation = ctx.generation ?? 0
        held = await this.op(() => this.files.read(this.resolve(ctx.path), MountCore.stored(raw)))
        if ((ctx.generation ?? 0) === generation) ctx.data = held
      } else {
        retained = true
      }
      stored = held.subarray(pos, pos + len)
    }
    const writes = this.writesOn(ctx.key, ctx)
    const data =
      writes.length > 0 ? overlaid(stored, pos, len, await windowWrites(writes, pos, len)) : stored
    return retained || writes.length > 0 ? this.readCached(ctx.path, data) : data
  }

  /**
   * What a read of the file `key` names sees that has not landed: every
   * handle's writes on it, as write(2) is seen by every reader at once.
   * `supersede` keeps them apart, so they lay over the stored bytes in any
   * order; an appending handle's are its own, since they land at the end the
   * file has then, and the reader's own go last. Mirrors Python's
   * `_writes_on`.
   */
  private writesOn(key: string, ctx: Handle | null): [number, Uint8Array | ByteSlice][] {
    const out: [number, Uint8Array | ByteSlice][] = []
    for (const other of this.openOn(key)) {
      if (other !== ctx && !other.mode.append)
        for (const item of other.writeBuf ?? []) out.push(item)
    }
    if (ctx !== null) for (const item of ctx.writeBuf ?? []) out.push(item)
    return out
  }

  /**
   * Buffer a write on its handle, or apply it directly when there is none.
   * An appending handle writes at the end it holds, whatever `pos` says;
   * EBADF through a handle opened only to read.
   */
  async write(path: string, fd: number, data: Uint8Array, pos: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx !== undefined) {
      if (!ctx.mode.writable) throw ebadf(ctx.path)
      const at = ctx.mode.append ? MountCore.end(ctx) : pos
      this.supersede(ctx.key, at, data.byteLength, ctx)
      await MountCore.buffer(ctx, at, data)
      return
    }
    const key = this.identity(path)
    this.supersede(key, pos, data.byteLength, undefined)
    await this.mutate(key, () => this.applyWrites(path, [[pos, data]]))
  }

  /**
   * Keep a write on its handle, a copy: one that starts inside the last run
   * or right at its end folds into it, so a stream of writes stays one run;
   * any other starts a run of its own, laid over the earlier ones in order,
   * and every 64 of those fold together while none waits in the spool. Past
   * `MEMORY_LIMIT` held in memory, the handle's runs move to its spool, and
   * a stream goes on at the spool's end. Mirrors Python's `_buffer`.
   */
  private static async buffer(ctx: Handle, pos: number, data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return
    ctx.writeBuf ??= []
    const last = ctx.writeBuf.at(-1)
    if (last !== undefined) {
      const [start, run] = last
      const end = start + run.byteLength
      if (run instanceof Uint8Array && start <= pos && pos <= end) {
        last[1] = MountCore.folded(run, pos - start, data)
        await MountCore.spill(ctx)
        return
      }
      if (
        run instanceof ByteSlice &&
        pos === end &&
        run.source === ctx.spool &&
        run.offset + run.size === ctx.spooled
      ) {
        last[1] = new ByteSlice(run.source, run.offset, run.size + data.byteLength)
        ctx.spooled += data.byteLength
        await run.source.append(data)
        return
      }
    }
    ctx.writeBuf.push([pos, new Uint8Array(data)])
    if (ctx.writeBuf.length >= 64) {
      const held = MountCore.held(ctx.writeBuf)
      if (held.length === ctx.writeBuf.length) ctx.writeBuf = writeRuns(held)
    }
    await MountCore.spill(ctx)
  }

  /** The buffered writes held in memory, in arrival order. */
  private static held(writes: [number, Uint8Array | ByteSlice][]): [number, Uint8Array][] {
    return writes.filter((write): write is [number, Uint8Array] => write[1] instanceof Uint8Array)
  }

  /**
   * Move a handle's runs held in memory to its spool once they hold more
   * than `MEMORY_LIMIT`. Each takes its place in the spool before the spool
   * has its bytes, in one append, so a write or a read meanwhile finds the
   * run where it will be. Mirrors Python's `_spill`.
   */
  private static async spill(ctx: Handle): Promise<void> {
    const writes = ctx.writeBuf ?? []
    const held: Uint8Array[] = []
    let size = 0
    for (const [, run] of writes) {
      if (run instanceof Uint8Array) {
        held.push(run)
        size += run.byteLength
      }
    }
    if (size <= MEMORY_LIMIT) return
    if (ctx.spool === undefined) {
      ctx.spool = new ByteSpool()
      ctx.spooled = 0
    }
    const spool = ctx.spool
    for (const write of writes) {
      const run = write[1]
      if (!(run instanceof Uint8Array)) continue
      write[1] = new ByteSlice(spool, ctx.spooled ?? 0, run.byteLength)
      ctx.spooled = (ctx.spooled ?? 0) + run.byteLength
    }
    await spool.append(concat(held))
  }

  /**
   * `run` with `data` laid at `at`, inside it or right at its end: in place
   * when the run is one this grew and its buffer has the room, else in a
   * buffer twice as long, so a stream copies what it holds only as often as
   * its length doubles, as Python's bytearray grows.
   */
  private static folded(run: Uint8Array, at: number, data: Uint8Array): Uint8Array {
    const length = Math.max(run.byteLength, at + data.byteLength)
    let out: Uint8Array
    if (MountCore.grown.has(run) && run.byteOffset + length <= run.buffer.byteLength) {
      out = new Uint8Array(run.buffer, run.byteOffset, length)
      MountCore.grown.delete(run)
    } else {
      out = new Uint8Array(Math.max(length, 2 * run.byteLength)).subarray(0, length)
      out.set(run)
    }
    out.set(data, at)
    MountCore.grown.add(out)
    return out
  }

  /**
   * Cut a new write's range out of what the file's other handles hold:
   * their bytes there are older, and the new write replaces them. No two
   * handles on a file then hold the same bytes, so whichever flush, release
   * or sync lands first, the file ends as its writes were made. Nothing
   * lands here, so a write never waits on one.
   */
  private supersede(key: string, pos: number, size: number, ctx: Handle | undefined): void {
    // Its bytes land at the end the file has then, not here.
    if (ctx?.mode.append === true) return
    const end = pos + size
    for (const other of this.openOn(key)) {
      if (other === ctx || other.mode.append || other.writeBuf === undefined) continue
      const kept: [number, Uint8Array | ByteSlice][] = []
      for (const [at, run] of other.writeBuf) {
        if (at >= end || at + run.byteLength <= pos) {
          kept.push([at, run])
          continue
        }
        if (at < pos) kept.push([at, run.subarray(0, pos - at)])
        if (at + run.byteLength > end) kept.push([end, run.subarray(end - at)])
      }
      other.writeBuf = kept
    }
  }

  /**
   * Create an empty file and return a fresh handle. `mode` is what the
   * creator asked for, umask applied; null takes the mount's default.
   */
  async create(path: string, mode: number | null = null): Promise<number> {
    const key = this.identity(path)
    await this.make(path, mode)
    return this.handles.add({ path, key, mode: { ...READ, writable: true, create: true } })
  }

  /** Create an empty file in the file's turn. */
  private async make(path: string, mode: number | null): Promise<void> {
    await this.mutate(this.identity(path), async () => {
      await this.op(() => this.files.create(this.resolve(path)))
      await this.keepMode(path, mode)
      await this.changed(path)
    })
  }

  /** Create a directory, keeping the mode it was asked for. */
  async mkdir(path: string, mode: number | null = null): Promise<void> {
    await this.op(() => this.files.mkdir(this.resolve(path)))
    await this.keepMode(path, mode)
  }

  /**
   * Store the mode a create asked for, when it is not the one the backend
   * made the entry with (a disk mount applies the daemon's umask), so
   * `open(O_CREAT, 0600)` and `mkdir -m` read back as asked without a
   * write per ordinary create. Mirrors Python's `_keep_mode`.
   */
  private async keepMode(path: string, mode: number | null): Promise<void> {
    if (mode === null) return
    try {
      const made = await this.op(() => this.files.stat(this.resolve(path)))
      if ((posixMode(made) & 0o7777) !== (mode & 0o7777)) await this.setattr(path, mode)
    } catch (err) {
      // The entry exists: a policy that refuses the stat or the chmod leaves
      // the mode it was made with rather than failing a create that landed.
      console.debug(`mount: keeping the mode of ${path} failed: ${String(err)}`)
    }
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
    const key = this.identity(path, false)
    await this.removing([path], () =>
      this.mutate(key, async () => {
        const named = this.named(path)
        const row = await this.hold(path, named)
        await this.op(() => this.files.unlink(this.resolve(path)))
        this.detach(named, row)
        await this.changed(path, false)
      }),
    )
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
   * an open descriptor on the bytes it had, and the name, not what it
   * points at, is what changed. A refresh that fails is logged
   * and leaves the handles unhydrated rather than failing the committed
   * mutation. Mirrors Python's `_changed`.
   */
  private async changed(path: string, rehydrate = true): Promise<void> {
    const key = this.identity(path, rehydrate)
    this.restatKey(key)
    for (const view of [MountCore.view(key, true), MountCore.view(key, false)]) {
      if (this.hydrations.has(view)) {
        this.hydrationGen.set(view, (this.hydrationGen.get(view) ?? 0) + 1)
      }
    }
    if (!rehydrate) return
    const handles = this.openOn(key)
    for (const ctx of handles) {
      ctx.generation = (ctx.generation ?? 0) + 1
      ctx.chunked?.drop()
    }
    for (const raw of [true, false]) {
      const hydrated = handles.filter((ctx) => ctx.data !== undefined && ctx.mode.writable === raw)
      if (hydrated.length === 0) continue
      let data: Uint8Array
      try {
        data = await this.op(() => this.files.read(this.resolve(path), MountCore.stored(raw)))
      } catch (err) {
        // The mutation landed, so a refresh that fails must not fail it; the
        // next read through these handles fetches and reports.
        console.warn(`fuse: refresh of ${path} after a change failed: ${String(err)}`)
        for (const ctx of hydrated) delete ctx.data
        continue
      }
      for (const ctx of hydrated) ctx.data = data
    }
    // An appending handle holding no bytes writes at the length its open
    // saw; the file has another one now.
    const sized = handles.filter((ctx) => ctx.mode.append && ctx.data === undefined)
    if (sized.length === 0) return
    try {
      const s = await this.op(() => this.files.stat(this.resolve(path)))
      for (const ctx of sized) {
        ctx.size = contentSize(s)
        if (ctx.chunked !== undefined) ctx.chunked.size = contentSize(s)
      }
    } catch (err) {
      console.warn(`fuse: the length of ${path} after a change failed: ${String(err)}`)
    }
  }

  /**
   * Resize the file an open handle is on: through its name, or, on a file
   * whose name went, the bytes its handles hold. EBADF through a handle
   * opened only to read, EINVAL for a negative length. Mirrors Python's
   * `ftruncate`.
   */
  async ftruncate(fd: number, length: number): Promise<void> {
    const ctx = this.openHandle(fd)
    if (!ctx.mode.writable) throw ebadf(ctx.path)
    if (length < 0) throw einval(ctx.path)
    if (ctx.detached === undefined) {
      await this.truncate(ctx.path, length)
      return
    }
    if (ctx.writeBuf !== undefined && ctx.writeBuf.length > 0)
      await this.landHeld(ctx, ctx.detached)
    const held = ctx.data ?? new Uint8Array()
    const data = new Uint8Array(length)
    data.set(held.subarray(0, length))
    const landed = ctx.detached.with({ size: length })
    for (const other of this.openOn(ctx.key)) {
      if (other !== ctx && other.data !== held) continue
      other.data = data
      other.detached = landed
      other.writeBuf = (other.writeBuf ?? [])
        .filter(([at]) => at < length)
        .map(([at, run]) => [at, run.subarray(0, length - at)])
    }
  }

  async rename(src: string, dst: string): Promise<void> {
    // The facade is where a cross-mount pair is refused with EXDEV,
    // which is what makes `mv` between two backends fall back to
    // copy+unlink instead of addressing the destination against the
    // source's backend.
    const source = this.resolve(src)
    const target = this.resolve(dst)
    const moved = this.identity(src, false)
    await this.removing([src, dst], () =>
      this.queueAll(this.pending, [moved, this.identity(dst, false)], async () => {
        const replaced = this.named(dst).filter((ctx) => ctx.key !== moved)
        const row = await this.hold(dst, replaced)
        // Both ends as the links above them lead in this turn, right before
        // the move: a link the move takes along no longer leads there after.
        const start = this.identity(src, false)
        const landing = this.identity(dst, false)
        await this.op(() => this.files.rename(source, target))
        this.detach(replaced, row)
        for (const ctx of this.handles.values()) {
          if (ctx.detached !== undefined) continue
          if (ctx.key === start || ctx.key.startsWith(`${start}/`)) {
            const rest = ctx.key.slice(start.length)
            ctx.key = landing + rest
            ctx.path = this.mountPath(ctx.key, dst + rest)
          }
        }
        await this.changed(src, false)
        await this.changed(dst, false)
      }),
    )
  }

  // No emptiness pre-check: every backend's rmdir refuses a non-empty
  // directory itself.
  async rmdir(path: string): Promise<void> {
    await this.op(() => this.files.rmdir(this.resolve(path)))
  }

  /**
   * The mount path the file `key` names, or `spelled` where it lies outside
   * the mount's root.
   */
  private mountPath(key: string, spelled: string): string {
    return key.startsWith(`${this.root}/`) ? key.slice(this.root.length) : spelled
  }

  /**
   * Where a mount path really points: the mount-resolved path with every
   * namespace link followed, so two handles opened through a link and
   * its target are recognised as the same file.
   */
  identity(path: string, follow = true): string {
    const virtual = this.resolve(path)
    const reader = readerOf(this.files)
    // An op on the entry itself (unlink, rename, lsetattr) names the link,
    // which may loop: only the links above it are followed.
    const resolved = (): string =>
      follow ? posixNormpath(reader.follow(virtual)) : reader.followParent(virtual)
    // Judged as the bound session judges every op (`op`): outside it the
    // facade's session is the default one, whose profile may hide a link
    // this session's handles were opened through.
    if (this.session === null) return resolved()
    return callsAs({ ...currentCaller(), session: this.session }, resolved)()
  }

  /**
   * Persist a handle's buffered writes. The buffer is detached before the
   * await so a write arriving meanwhile is not lost to the clear, and the
   * runs that did not land are restored ahead of those later writes when
   * persistence fails, so the acknowledged bytes stay for the handle's own
   * flush to retry.
   */
  private async settle(ctx: Handle): Promise<void> {
    // Queued with nothing buffered too: a flush still landing has taken the
    // buffer, and this one waits for it and retries what it puts back,
    // rather than reporting the file settled.
    for (;;) {
      const key = ctx.key
      const landed = await this.mutate(key, async () => {
        // A rename that moved the handle while this waited put its file in
        // another queue: it lands from that one instead.
        if (ctx.key !== key) return false
        await this.persistBuffered(ctx)
        return true
      })
      if (landed) return
    }
  }

  /** The handles open on the entry at `path` itself. */
  private named(path: string): Handle[] {
    return this.openOn(this.identity(path, false))
  }

  /**
   * The handles open on the file `key` names. The handles left on a file
   * whose name went share a key of their own (`detach`), so no path names
   * them.
   */
  private openOn(key: string): Handle[] {
    return [...this.handles.values()].filter((ctx) => ctx.key === key)
  }

  /**
   * Leave the handles open on a name that went on the file it had: they
   * stat by its row from then on, and share a key no path gives, so a write
   * through one reaches the others and nothing that opens the name later.
   */
  private detach(named: Handle[], row: FileStat): void {
    this.removed += 1
    const key = `\0${String(this.removed)}`
    for (const ctx of named) {
      ctx.detached = row
      ctx.key = key
    }
  }

  /**
   * Land a handle's writes on a file whose name went: on the bytes it holds,
   * which every handle open on that file reads, as writes to an unlinked
   * file stay with it. A handle reading a rendering the stored bytes differ
   * from keeps its own. Mirrors Python's `_land_held`.
   */
  private async landHeld(ctx: Handle, row: FileStat): Promise<void> {
    const held = ctx.data ?? new Uint8Array()
    const end = MountCore.end(ctx)
    const data = overlaid(held, 0, end, await windowWrites(ctx.writeBuf ?? [], 0, end))
    ctx.writeBuf = []
    await MountCore.freeSpool(ctx)
    const landed = row.with({ size: data.byteLength })
    for (const other of this.openOn(ctx.key)) {
      if (other !== ctx && other.data !== held) continue
      other.data = data
      other.detached = landed
    }
  }

  /**
   * Land what every handle open on `path` wrote, in the file's turn, as a
   * change of its times by path must come after; `follow` says the change
   * follows a link at `path`. Mirrors Python's `land`.
   */
  async land(path: string, follow = true): Promise<void> {
    const key = this.identity(path, follow)
    await this.mutate(key, () => this.landBuffered(key))
  }

  /**
   * Have the handles open on `path` stat it afresh, after a change by path
   * made past the core (a runtime's setattr or whole-file write), so their
   * next fstat agrees with stat; `follow` says the change followed a link
   * at `path`. Mirrors Python's `restat`.
   */
  restat(path: string, follow = true): void {
    this.restatKey(this.identity(path, follow))
  }

  /**
   * Drop the stat rows the handles open on `key` keep, and outdate a stat
   * of theirs still out. Mirrors Python's `_restat`.
   */
  private restatKey(key: string): void {
    for (const ctx of this.openOn(key)) {
      delete ctx.row
      ctx.restats = (ctx.restats ?? 0) + 1
    }
  }

  /** Land the buffered writes of every handle open on `key`. */
  private async landBuffered(key: string): Promise<void> {
    for (const ctx of this.openOn(key)) await this.persistBuffered(ctx)
  }

  private async persistBuffered(ctx: Handle): Promise<void> {
    if (ctx.writeBuf === undefined || ctx.writeBuf.length === 0) return
    if (ctx.detached !== undefined) {
      await this.landHeld(ctx, ctx.detached)
      return
    }
    const held = MountCore.held(ctx.writeBuf)
    if (held.length < ctx.writeBuf.length) {
      const groups = runGroups(ctx.writeBuf)
      ctx.writeBuf = []
      try {
        await this.landSpooled(ctx, groups)
      } catch (err) {
        ctx.writeBuf = [...groups.flat(), ...ctx.writeBuf]
        throw err
      }
      await MountCore.freeSpool(ctx)
      return
    }
    const runs = writeRuns(held)
    ctx.writeBuf = []
    try {
      await this.applyWrites(ctx.path, runs, ctx.mode.append)
    } catch (err) {
      ctx.writeBuf = [...runs, ...ctx.writeBuf]
      throw err
    }
  }

  /**
   * Land a buffer whose writes wait in its spool, each group of writes
   * `writeRuns` would fold into one run as a stream, in order. A group from
   * the file's start that reaches its stored end leaves nothing of what is
   * stored, so it lands as a write of the whole file, which a store with no
   * pwrite (S3) takes in parts rather than reading the file back first; any
   * other lands as one pwrite of its bytes, and an appending handle's as
   * appends. The groups that landed leave `groups`, as `applyWrites` drops
   * its runs. Mirrors Python's `_land_spooled`.
   */
  private async landSpooled(
    ctx: Handle,
    groups: [number, Uint8Array | ByteSlice][][],
  ): Promise<void> {
    const target = this.resolve(ctx.path)
    let landed = 0
    try {
      for (const group of groups) {
        const start = group[0]?.[0] ?? 0
        let end = start
        for (const [at, run] of group) end = Math.max(end, at + run.byteLength)
        if (ctx.mode.append) await this.appendTo(target, group)
        else if (start === 0 && (await this.endsBy(ctx.path, end)))
          await this.op(() => this.files.write(target, runStream(group)))
        else {
          const data = await materialize(runStream(group))
          await this.op(() => this.files.pwrite(target, data, start))
        }
        landed += 1
      }
    } finally {
      groups.splice(0, landed)
      await this.changed(ctx.path)
    }
  }

  /** Whether the stored file at `path` is missing or ends at or before `end`. Mirrors Python's `_ends_by`. */
  private async endsBy(path: string, end: number): Promise<boolean> {
    const row = await this.rowOrNull(path)
    return row === null || (row.size !== null && row.size <= end)
  }

  /** Close a handle's spool once none of its writes wait there. Mirrors Python's `_free_spool`. */
  private static async freeSpool(ctx: Handle): Promise<void> {
    const spool = ctx.spool
    if (spool === undefined || (ctx.writeBuf ?? []).some(([, run]) => run instanceof ByteSlice))
      return
    delete ctx.spool
    await spool.close()
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
      await this.landBuffered(key)
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
    follow = false,
  ): Promise<void> {
    // The kernel has already resolved any link the call follows, so a
    // kernel mount names the entry to change, a link itself for `chown -h`;
    // SFTP's setstat asks to follow one.
    const fields: SetAttrFields = { nofollow: !follow }
    if (mode !== null) fields.mode = mode & 0o7777
    if (uid !== null) fields.uid = uid
    if (gid !== null) fields.gid = gid
    if (atime !== null) fields.atime = atime.toISOString()
    if (mtime !== null) fields.mtime = mtime.toISOString()
    const key = this.identity(path, follow)
    const timed = atime !== null || mtime !== null
    const run = async (): Promise<void> => {
      // cp -p sets times on a file it still holds open: its buffered
      // writes land first, or they would stamp over them.
      if (timed) await this.landBuffered(key)
      await this.op(() => this.files.setattr(this.resolve(path), fields))
      this.restatKey(key)
    }
    await (timed ? this.mutate(key, run) : run())
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

  /**
   * Open a path, the open's effect landing before any byte moves. One rule
   * for every entry point, however it spells the open (open(2) flags, SFTP
   * pflags, an fopen mode, preview1 oflags): an exclusive create refuses
   * what exists, a dangling link or a listed directory included; a
   * directory refuses a mode that would write it; a missing path is created
   * when the mode creates and refused when it does not; a truncating mode
   * empties what exists, which CPython's `open('w')` leaves behind even when
   * nothing is written; and a mode that writes is admitted against the
   * file's write rules before its first write. A file an API mount cannot
   * size is then read whole. `perm` is the mode bits a create gives the
   * file, umask applied; null takes the mount's default. Mirrors Python's
   * `MountCore.open`.
   */
  async open(path: string, mode: OpenMode = READ, perm: number | null = null): Promise<number> {
    for (
      let removal = this.removalOf(path);
      removal !== undefined;
      removal = this.removalOf(path)
    ) {
      await removal
    }
    const keys = new Set([this.identity(path, false), this.identity(path)])
    const opened = this.openPath(path, mode, perm)
    const out = opened.then(
      () => undefined,
      () => undefined,
    )
    for (const key of keys) this.opening.set(key, (this.opening.get(key) ?? new Set()).add(out))
    try {
      return await opened
    } finally {
      for (const key of keys) {
        const opening = this.opening.get(key)
        opening?.delete(out)
        if (opening?.size === 0) this.opening.delete(key)
      }
    }
  }

  /** The open itself, which a removal of its name waits for. */
  private async openPath(path: string, mode: OpenMode, perm: number | null): Promise<number> {
    if (path.endsWith('/') && path !== '/') {
      const leaf = await this.rowOrNull(rstripSlash(path))
      if (leaf !== null && !isDir(leaf)) throw enotdir(path)
      if (leaf === null && mode.create) throw eisdir(path)
    }
    // An exclusive create follows no link (O_CREAT|O_EXCL), so a dangling
    // one is a name that is there. A path with no row may still be a
    // directory the mount lists, and a create there would put a file at a
    // directory's name.
    const s = await this.rowOrNull(path, mode.exclusive)
    const listed = s !== null ? isDir(s) : await this.listed(path)
    if (mode.exclusive && (s !== null || listed)) throw eexist(path)
    const key = this.identity(path)
    if (listed) {
      if (mode.writable || mode.create || mode.directory !== true) throw eisdir(path)
      return this.handles.add({ path, key, mode })
    }
    // The handle reads and writes the file the open reached, not the one a
    // link at `path` names later.
    const at = this.mountPath(key, path)
    const emptied = s === null || mode.truncate
    if (s === null) {
      if (!mode.create) throw enoent(path)
      await this.make(path, perm)
    } else if (mode.truncate) {
      await this.empty(path)
    } else if (mode.writable) {
      await this.op(() =>
        this.files.dispatch('write', PathSpec.fromStrPath(this.resolve(path), undefined, '/'), [], {
          admit_only: true,
        }),
      )
    }
    const ctx: Handle = {
      path: at,
      key,
      mode,
      live: s?.extra[LIVE_KEY] === true,
      size: s === null || mode.truncate ? 0 : contentSize(s),
    }
    if (ctx.live === true || s === null) return this.handles.add(ctx)
    if (!emptied) {
      ctx.row = s
      ctx.rowAt = performance.now()
    }
    if (s.size === null) {
      // Hydrate through the rendered read path, after an O_TRUNC too: an
      // extension whose renderer gives an empty file a body is honored
      // rather than shadowed by literal raw emptiness.
      const data = await this.hydrate(at, mode.writable)
      if (data !== undefined) ctx.data = data
    } else if (s.size > READ_CHUNK && !emptied) {
      // Read a chunk at a time, at the handle's path then (a rename moves
      // it): a `head` must not move the file.
      ctx.chunked = new ChunkedHandle(at, s.size, (offset, size) =>
        this.op(() =>
          this.files.read(this.resolve(ctx.path), {
            offset,
            size,
            ...MountCore.stored(mode.writable),
          }),
        ),
      )
    }
    return this.handles.add(ctx)
  }

  /** The path's row, or null when the mount says it is not there. */
  private async rowOrNull(path: string, nofollow = false): Promise<FileStat | null> {
    try {
      return await this.op(() => this.files.stat(this.resolve(path), undefined, { nofollow }))
    } catch (err) {
      if (classify(err) !== 'ENOENT') throw err
      return null
    }
  }

  /**
   * Whether a path with no row is a directory the mount only implies (the
   * root above a nested mount), which it lists.
   */
  private async listed(path: string): Promise<boolean> {
    try {
      await this.op(() => this.files.readdir(this.resolve(path)))
    } catch (err) {
      const code = classify(err)
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw err
    }
    return true
  }

  /**
   * Empty a file an open truncates. A mount with no truncate (hf buckets,
   * databricks volumes) still empties it through an empty create, which is
   * the effect the open asked for.
   */
  private async empty(path: string): Promise<void> {
    try {
      // libfuse 3 sends no SETATTR ahead of an O_TRUNC open (atomic
      // O_TRUNC), so the flag is the whole truncation.
      await this.truncate(path, 0)
    } catch (err) {
      if (classify(err) !== 'ENOTSUP') throw err
      await this.make(path, null)
    }
  }

  /**
   * A removal of `path` still running. One is keyed by the name it takes, so
   * an open through a link meets the link's removal and then its target's.
   */
  private removalOf(path: string): Promise<void> | undefined {
    return this.removals.get(this.identity(path, false)) ?? this.removals.get(this.identity(path))
  }

  /**
   * Keep what the handles open on `path` need once it goes, and return the
   * row they stat by from then on. POSIX keeps an open descriptor on the
   * file it had, so an unlink or a rename onto it must not leave a handle
   * reading or stat'ing the file at that name next. A handle holding no
   * bytes yet (never read, or chunked and holding one chunk) gets them all
   * from one read every such handle shares; it runs under `removing` and
   * the file's `pending` chain, so no handle opens on the file and no write
   * lands on it meanwhile. The handles are matched by the
   * entry itself, so removing a link holds nothing: it takes the link,
   * never its target's bytes. A stat or a read that fails (a policy may
   * allow the removal and refuse either) leaves a bare row or the handles
   * as they are, each on its own, rather than refusing a mutation the
   * caller is allowed. Mirrors Python's `MountCore._hold`.
   */
  private async hold(path: string, named: Handle[]): Promise<FileStat> {
    const bare = new FileStat({ name: path.slice(path.lastIndexOf('/') + 1), type: FileType.FILE })
    if (named.length === 0) return bare
    const virtual = this.resolve(path)
    let row = bare
    try {
      row = await this.op(() => this.files.stat(virtual))
    } catch (err) {
      console.warn(`fuse: the row of ${path} before it goes failed: ${String(err)}`)
    }
    for (const raw of [true, false]) {
      const lacking = named.filter(
        (ctx) => ctx.data === undefined && ctx.live !== true && ctx.mode.writable === raw,
      )
      if (lacking.length === 0) continue
      let data: Uint8Array
      try {
        data = await this.op(() => this.files.read(virtual, MountCore.stored(raw)))
      } catch (err) {
        console.warn(`fuse: holding ${path} before it goes failed: ${String(err)}`)
        for (const ctx of lacking) ctx.lost = err instanceof Error ? err : new Error(String(err))
        continue
      }
      for (const ctx of lacking) {
        ctx.data = data
        delete ctx.chunked
      }
    }
    const copies: Uint8Array[] = []
    for (const ctx of named) {
      if (ctx.data === undefined) continue
      const held = ctx.data
      const same = copies.find(
        (copy) => copy.byteLength === held.byteLength && findBytes(copy, held) === 0,
      )
      if (same === undefined) copies.push(held)
      else ctx.data = same
    }
    return row
  }

  /**
   * Wait for a flush or truncation of the handle's file still landing, into
   * the queue a rename moved the handle to. Mirrors Python's `_settled`.
   */
  private async settled(ctx: Handle): Promise<void> {
    let key: string | null = null
    while (key !== ctx.key) {
      key = ctx.key
      await this.pending.get(key)
    }
  }

  /**
   * Land a handle's buffered writes and let it go. The handle goes even
   * when the landing fails, as close(2) releases its descriptor: no
   * adapter retries a release, so a kept handle would never close. The
   * failure still reaches the caller.
   */
  async release(fd: number): Promise<void> {
    const ctx = this.handles.get(fd)
    try {
      // The FSKit shim sends RELEASE with no FLUSH before it.
      if (ctx !== undefined) await this.flush(ctx.path, fd)
    } finally {
      this.handles.pop(fd)
      if (ctx?.spool !== undefined) await ctx.spool.close()
    }
  }

  async flush(_path: string, fd: number): Promise<void> {
    const ctx = this.handles.get(fd)
    if (ctx !== undefined) await this.settle(ctx)
  }

  /**
   * Land what every open handle holds, as sync(2) does, for a client whose
   * close(2) returns before it releases the handle (sshfs). A landing that
   * fails is logged, and its bytes stay on the handle for its own flush to
   * retry and report.
   */
  async sync(): Promise<void> {
    for (const ctx of [...this.handles.values()]) {
      try {
        await this.settle(ctx)
      } catch (err) {
        console.warn(`fuse: landing ${ctx.path} failed: ${String(err)}`)
      }
    }
  }
}

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

import { type ByteSource, IOResult, OpReport } from '../io/types.ts'
import { closeQuietly, ensureStream } from '../io/stream.ts'
import type { OpRecord } from '../observe/record.ts'
import { finishRecord, record, type RecordingState, startOp } from '../observe/context.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import type { FileStat, SetAttrFields, Visibility } from '../types.ts'
import { FileType, PathSpec } from '../types.ts'
import { isEnotdir, isMissingPath } from '../errors/fs.ts'
import {
  type Caller,
  type CallerDispatchFn,
  callsAs,
  currentCaller,
  getCurrentSession,
  runWithCaller,
  sessionVisibility,
} from '../context/session_context.ts'
import { leadsHidden, pathVisible } from '../utils/hidden.ts'
import { norm, posixNormpath } from '../utils/path.ts'
import { normDir, ownerPrefix, rstripSlash } from '../utils/slash.ts'
import { namespaceNames } from '../view/namespace_view.ts'
import type { MountRow } from './types.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type {
  FollowOperands,
  MountView,
  NamespaceLinks,
  OpKwargs,
  SessionAccess,
  SessionBind,
} from '../view/types.ts'

/** Receives each record with the id of the session the op ran as. */
export type OpSink = (rec: OpRecord, sessionId: string) => Promise<void>

export type OwnerOf = (path: string) => MountRow | null

/** What a derived facade carries over and a constructor may set. */
export interface FilesOptions {
  bind?: SessionBind | null
  // What every op says of its caller over the async context's: the call
  // an op-level answer covers, a dry run's trace, a deciding policy's mark.
  caller?: Partial<Caller> | null
  // The dispatcher bound to the session a bind put in place; the plain
  // dispatch serves an op that kept the caller's ambient session.
  dispatchAs?: ((owner: SessionAccess) => CallerDispatchFn) | null
  sessionId?: string | null
  records?: OpRecord[]
  // The prefixes of the mounts the session a call through a facade of this
  // session id runs as is told of, read live; its hides are applied over them.
  prefixes?: ((sessionId: string | null) => readonly string[]) | null
  // What the session a call would run as sees, given this facade's own; the
  // bound session's when unset.
  visibility?: ((sessionId: string | null) => Visibility | null) | null
  // The line's operand resolution a command's globs give their matches.
  follow?: FollowOperands | null
  // Record each op on the ledger; false where the dispatcher does the accounting.
  ledger?: boolean
  // The mount whose command scope a command's files run in, null across
  // mounts; unset where nothing said one (`servedBy`).
  served?: Caller['mount']
}

/**
 * What a session's files hold of the namespace, hides aside.
 *
 * The link table and the mount table as the workspace keeps them, hidden
 * entries included, so it is never a handler's: a handler asks `Files`
 * (`mountOf`, `submounts`), which apply the session's hides, and the command
 * helpers read `FilesView`, which applies them. The code that
 * walks the namespace beside the dispatcher reads it: the mount core and the
 * file tool mapping a path the way the dispatcher does, the runtime's
 * descriptors. Mirrors Python's `FilesNamespace`.
 */
export interface FilesNamespace {
  /** The workspace link table, unfiltered by any session's hides. */
  readonly links: NamespaceLinks | null
  /** The line's operand resolution a command's globs give their matches. */
  readonly follow: FollowOperands | null
  /** The visibility of the session an op would run as. */
  vis(): Visibility | null
  /** The prefixes of the mounts that session is told of at all, hides aside. */
  prefixes(): readonly string[]
  /** The mount serving a path, by longest prefix. */
  readonly ownerOf: OwnerOf
}

/**
 * What a session's files show of the namespace, the session's hides applied.
 *
 * The link and mount tables are read here, beside the dispatcher that answers
 * from them, and filtered by the rule it refuses a call by (`visible`), so
 * the command helpers that walk the namespace (`linksOf`, `mountsOf`, globs,
 * `find -L`, `cp -L`, `du`) read no table and filter no hide of their own: a
 * hidden link, or one that leads where the session cannot see, has no row and
 * no target; a hidden mount is a boundary a walk stops at but is never named.
 * Mirrors Python's `FilesView`.
 */
export interface FilesView {
  /** Whether a link table stands behind the files. */
  readonly linked: boolean
  /** The link standing at a path, its own row; null where none stands or the
   * session cannot see it. */
  linkAt(path: string): FileStat | null
  /** The links under a directory the session sees, with their rows. */
  linksBelow(directory: string): [string, FileStat][]
  /** Where a path the session sees leads, every link followed; a hidden one
   * is left as typed. Throws CycleError where a link loop stands in the walk. */
  resolve(path: string): string
  /** Where the mount boundaries are, for a walk through the dispatcher
   * (`crossing`) or one bound to a mount. */
  mounts(crossing: boolean): MountView
  /** The names a directory holds only as namespace structure: the mounts
   * below it and its links, by their first segment under it. */
  owed(directory: string): string[]
  /** The visibility of the session an op would run as. */
  vis(): Visibility | null
  /** Whether the session sees a path: it is not hidden, and no link on it
   * leads where the session cannot see. The rule the dispatcher refuses a
   * call by, for what a helper holds in data of its own (a link's target,
   * git's index) and the rows the command boundary filters. */
  visible(path: string | PathSpec): boolean
  /** The line's operand resolution a command's globs give their matches. */
  readonly follow: FollowOperands | null
}

// TypeScript has no package-private: the class assigns these from its static
// block, where its private members are in reach, and `namespaceOf`, `viewOf`
// and `withCaller` are the doors through them.
let namespaceOfFiles: (files: Files) => FilesNamespace
let viewOfFiles: (files: Files) => FilesView
let callerFilesOf: (files: Files, changes: Partial<Caller>) => Files

// The op's byte count for recording: the result first, else the input
// (write payloads travel as the first positional argument). Mirrors
// Python's Files._payload_bytes.
function payloadBytes(result: unknown, args: readonly unknown[]): number {
  if (result instanceof Uint8Array) return result.byteLength
  for (const arg of args) {
    if (arg instanceof Uint8Array) return arg.byteLength
  }
  return 0
}

/**
 * A streamed answer, recorded once it ends: the dispatcher stamps the report with
 * the bytes the stream carried when it ends, so the record waits for that
 * rather than counting none. The caller runs it to its empty first step,
 * inside the `try`, so a stream closed before its first pull is still closed
 * and recorded. Mirrors Python's `_recorded`.
 */
async function* recorded(
  stream: AsyncIterable<Uint8Array>,
  record: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    yield new Uint8Array()
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) return
      yield next.value
    }
  } finally {
    await iterator.return?.()
    await record()
  }
}

/**
 * The typed file API: `ws.vfs`, `session.vfs` and a command's, CLI leaf's or
 * runtime's `ctx.vfs`.
 *
 * Every op delegates to the workspace dispatcher, so `ws.vfs` walks the
 * same pipeline as a shell command: link follow, session grants,
 * admission policies, cache read-through, namespace structure, and
 * post-write invalidation all fire once, at that one dispatcher. The facade
 * keeps only what is its own: the typed surface and the op ledger it
 * records on — the ledger lives here, not on the workspace, which is what
 * lets `MountCore` take one `Files` instead of reaching through a whole
 * `Workspace`. The ledger is read on `ws.vfs`, a `WorkspaceFiles`. Mirrors
 * Python's `Files`.
 *
 * The facade runs as one session, `sessionId`, through `bind`: every
 * op is judged under that session's profile (hides, mount modes,
 * grants) exactly as a shell line in it would be, so an agent whose
 * file tool reads through `ws.vfs` is confined the way its shell is.
 * null names the workspace's default session as it is when the op
 * runs, since a snapshot load can rename it. A session already bound
 * when the op arrives (a command's own runtime, a kernel mount serving
 * one session) is kept, so the facade never widens the caller's view,
 * and the record names the session that judged the op. `Session`
 * derives a facade for another session over the same ledger.
 *
 * Every op also takes a trailing `sessionId` for the one-call case,
 * the way `Workspace.shell` does. One rule decides between them: a
 * shell line *sets* the session, an op *inherits* it. So the argument
 * is the session to run as when no line is already running, and the
 * line's session wins when one is, which is what keeps a handler
 * reaching the dispatcher from widening the view it was given.
 */
export class Files {
  static {
    namespaceOfFiles = (files) => files.namespace()
    viewOfFiles = (files) => files.view()
    callerFilesOf = (files, changes) => files.forCaller(changes)
  }

  private readonly dispatchFn: CallerDispatchFn
  private readonly sink: OpSink | null
  private readonly links: NamespaceLinks | null
  private readonly ownerOf: OwnerOf
  private readonly bind: SessionBind | null
  private readonly dispatchAs: ((owner: SessionAccess) => CallerDispatchFn) | null
  private readonly caller: Partial<Caller> | null
  private readonly prefixesOf: (sessionId: string | null) => readonly string[]
  private readonly visibilityOf: ((sessionId: string | null) => Visibility | null) | null
  /** The session this facade runs as; null for the workspace's default. */
  readonly sessionId: string | null
  /** The op ledger this facade records on; `WorkspaceFiles.records` reads it. */
  protected readonly recorded: OpRecord[]
  private readonly follow: FollowOperands | null
  private readonly ledger: boolean
  /**
   * The mount whose command scope these files run in, null for a run across
   * mounts; undefined where nothing said one, which the async context
   * answers instead (`servedBy`).
   *
   * @internal
   */
  readonly served: Caller['mount'] | undefined

  constructor(
    dispatch: CallerDispatchFn,
    sink: OpSink | null = null,
    links: NamespaceLinks | null = null,
    ownerOf: OwnerOf = () => null,
    options: FilesOptions = {},
  ) {
    this.dispatchFn = dispatch
    this.sink = sink
    this.links = links
    this.ownerOf = ownerOf
    this.bind = options.bind ?? null
    this.dispatchAs = options.dispatchAs ?? null
    this.caller = options.caller ?? null
    this.sessionId = options.sessionId ?? null
    this.recorded = options.records ?? []
    this.prefixesOf = options.prefixes ?? (() => [])
    this.visibilityOf = options.visibility ?? null
    this.follow = options.follow ?? null
    this.ledger = options.ledger ?? true
    this.served = options.served
  }

  private options(): FilesOptions {
    return {
      bind: this.bind,
      dispatchAs: this.dispatchAs,
      sessionId: this.sessionId,
      records: this.recorded,
      prefixes: this.prefixesOf,
      visibility: this.visibilityOf,
    }
  }

  /**
   * The same facade run as another session, over the same ledger, so
   * the workspace-wide account stays one list.
   *
   * @internal The mechanism behind `Session.vfs`, not an entry point of
   * its own: a host binds a session with `ws.session(id)` (creating it
   * when the id is new) or `new Session(ws, id)` (adopting one
   * that exists), so there is one way to say it rather than two.
   * TypeScript has no package-private, so this stays reachable; it is
   * not part of the supported surface. Python spells it
   * `Files._for_session`.
   */
  forSession(sessionId: string): Files {
    return new Files(this.dispatchFn, this.sink, this.links, this.ownerOf, {
      ...this.options(),
      sessionId,
    })
  }

  /**
   * The same facade with `changes` said of every op's caller: a file
   * tool's call, the unit an op-level answer covers, so an approval one op
   * is answered by is claimed for the call's other ops and a call running
   * at the same time is never taken for this one; a dry run's trace; or a
   * policy method's deciding mark. Said on each op, not bound in the async
   * context, which without task isolation another task would read. Reached
   * through `withCaller`.
   */
  private forCaller(changes: Partial<Caller>): Files {
    return new Files(this.dispatchFn, this.sink, this.links, this.ownerOf, {
      ...this.options(),
      caller: { ...this.caller, ...changes },
    })
  }

  /**
   * The same files said to run in `mount`'s command scope, null for a run
   * across mounts: what `mountRoot` and `crossesMounts` read, tied to the
   * command's run, where an async context without task isolation answers
   * whichever task bound last. The ops are unchanged.
   *
   * @internal Said by a mount for each command it runs, and by a run across
   * mounts; Python's task context carries the caller instead.
   */
  servedBy(mount: Caller['mount']): Files {
    return new Files(this.dispatchFn, this.sink, this.links, this.ownerOf, {
      ...this.options(),
      caller: this.caller,
      follow: this.follow,
      ledger: this.ledger,
      served: mount,
    })
  }

  /**
   * The same files over another dispatcher, keeping no ledger.
   *
   * @internal Behind `captureBinding`; Python spells it `Files._over`.
   * @param dispatch the dispatcher the calls go to.
   */
  over(dispatch: CallerDispatchFn): Files {
    return new Files(dispatch, null, this.links, this.ownerOf, {
      sessionId: this.sessionId,
      prefixes: this.prefixesOf,
      visibility: this.visibilityOf,
      follow: this.follow,
      ledger: false,
    })
  }

  /**
   * The prefixes of the mounts the session an op would run as is told of at
   * all, hides aside: a session's own documents mount is one only it is told
   * of. Mirrors Python's `Files._served`.
   */
  private prefixes(): readonly string[] {
    return this.prefixesOf(this.sessionId)
  }

  /**
   * The visibility of the session an op would run as: the bound one, else
   * this facade's own. Mirrors Python's `Files._vis`.
   */
  private vis(): Visibility | null {
    return this.visibilityOf === null ? sessionVisibility() : this.visibilityOf(this.sessionId)
  }

  /** What `viewOf` hands the command helpers that walk the namespace. */
  private view(): FilesView {
    const table = this.links
    return {
      linked: table !== null,
      linkAt: (path) => (table !== null && this.isVisible(path) ? table.linkStatAt(path) : null),
      linksBelow: (directory) =>
        table === null
          ? []
          : table.linkStatsBelow(directory).filter(([path]) => this.isVisible(path)),
      resolve: (path) =>
        table !== null && pathVisible(this.vis(), path) ? posixNormpath(table.follow(path)) : path,
      mounts: (crossing) =>
        mountView(
          () => this.prefixes(),
          () => this.vis(),
          this.ownerOf,
          crossing,
        ),
      owed: (directory) => namespaceNames(this.vis(), this.prefixes(), table, directory),
      vis: () => this.vis(),
      visible: (path) => this.isVisible(path),
      follow: this.follow,
    }
  }

  /** What `namespaceOf` hands the code that walks the namespace. */
  private namespace(): FilesNamespace {
    return {
      links: this.links,
      follow: this.follow,
      vis: () => this.vis(),
      prefixes: () => this.prefixes(),
      ownerOf: this.ownerOf,
    }
  }

  /**
   * Whether the session sees `path`: it is not hidden, and no link on it leads
   * where the session cannot see. The rule the dispatcher refuses a call by.
   * Not a handler's: a handler hands its output over as rows
   * (`IOResult.rows`), which the command boundary filters by this rule; the
   * command helpers read it as `FilesView.visible`. Mirrors Python's
   * `Files._is_visible`.
   */
  private isVisible(path: string | PathSpec): boolean {
    const virtual = PathSpec.fromStrPath(path, undefined, '/').virtual
    const vis = this.vis()
    if (!pathVisible(vis, virtual)) return false
    if (vis === null || this.links === null) return true
    return !leadsHidden(vis, virtual, this.links.symlinkTargets())
  }

  /**
   * The mount prefix serving `path`, without a trailing slash: the one
   * `RuntimeFiles.mountOf` gives a guest, where a walk up a tree stops, as git
   * stops looking for `.git` at a filesystem boundary. null for a path the
   * session cannot see. A path a show carve-out opens inside a hidden mount
   * names that mount, whose root the path itself runs through. Mirrors
   * Python's `Files.mount_of`.
   */
  mountOf(path: string | PathSpec): string | null {
    const virtual = PathSpec.fromStrPath(path, undefined, '/').virtual
    if (!pathVisible(this.vis(), virtual)) return null
    const owner = ownerPrefix(this.prefixes(), virtual)
    return owner === null ? null : norm(owner)
  }

  /** Whether `path` is the root of a mount the session sees. Mirrors Python's
   * `Files.is_mount`. */
  isMount(path: string | PathSpec): boolean {
    const virtual = norm(PathSpec.fromStrPath(path, undefined, '/').virtual)
    const vis = this.vis()
    return this.prefixes().some((prefix) => norm(prefix) === virtual && pathVisible(vis, virtual))
  }

  /**
   * The mount roots strictly under `path`, sorted, without a trailing slash,
   * as `findmnt --submounts` lists them.
   *
   * A mount the session hides still stands where it is: whatever removes or
   * renames the folder holding it would take it along. It is reported by the
   * nearest folder above it the session sees, `path` itself when nothing
   * between is visible, so a caller refuses that folder without learning the
   * mount's name. Mirrors Python's `Files.submounts`.
   */
  submounts(path: string | PathSpec): string[] {
    const virtual = norm(PathSpec.fromStrPath(path, undefined, '/').virtual)
    const vis = this.vis()
    if (!pathVisible(vis, virtual)) return []
    const below = normDir(virtual)
    const found = new Set<string>()
    for (const prefix of this.prefixes()) {
      let root = norm(prefix)
      if (root === virtual || !normDir(root).startsWith(below)) continue
      while (root !== virtual && !pathVisible(vis, root)) {
        root = root.slice(0, root.lastIndexOf('/')) || '/'
      }
      found.add(root)
    }
    return [...found].sort(compareCodePoints)
  }

  /**
   * `Workspace.dispatch` as this facade runs it: as its session, and
   * recorded on the ledger. The dispatcher `RuntimeFiles` drives for node's
   * patched `fs` (`patchNodeFs`), a facade caller like FUSE, and a
   * handler's for any op its typed methods do not spell; bound, so a handler
   * can hand it on. The IOResult is empty unless this facade keeps no
   * ledger. Mirrors Python's `Files.dispatch`.
   */
  readonly dispatch = async (
    name: string,
    path: string | PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
    report?: OpReport,
  ): Promise<[unknown, IOResult]> => {
    if (!this.ledger)
      return this.dispatchFn(name, PathSpec.fromStrPath(path, undefined, '/'), args, kwargs, report)
    return [await this.through(name, path, args, kwargs), new IOResult()]
  }

  /**
   * Run one op through the workspace dispatcher and record it.
   *
   * The dispatcher owns the whole pipeline (follow, grants, gates, cache,
   * structure, invalidation). On a line this workspace runs, the op records
   * where the line records, so its records are the line's; anywhere else
   * (outside a line, or on another workspace's) it records into its own
   * recording, handed to this ledger and the sink once the op ends, a
   * stream's once it closes. What records it is what records a line's
   * calls: the backend and the dispatcher, with the tokens they read. An op
   * nothing below recorded (a stat, a listing, a warm cache hit, a
   * synthetic namespace answer) is recorded here, on the path the
   * dispatcher's report says it ran on, its links followed. Mirrors
   * Python's Files._call.
   */
  private async through(
    op: string,
    path: string | PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (!this.ledger) return (await this.dispatch(op, path, args, kwargs))[0]
    const timer = startOp()
    const report = new OpReport()
    const spelled = typeof path === 'string' ? path : path.virtual
    const outer = currentCaller()
    // Without task isolation (a browser) a backend's record lands in
    // whichever call bound last, so a call cannot tell its own records from
    // an overlapping call's: there it records the op itself, from the
    // dispatcher's report, straight onto the ledger.
    const isolated = asyncContextIsolatesTasks
    // Only a line this workspace runs is joined: another workspace's line
    // would take this workspace's records.
    const own: RecordingState | null =
      !isolated || outer.recording?.ledger === this.recorded
        ? null
        : { records: [], mountId: null, ledger: null }
    // The op's own list gathers every record made below it; a command the
    // op runs in on that line (a handler reaching `ws.vfs`) is charged them
    // once the op ends.
    const mine: OpRecord[] = []
    const enclosing = isolated && own === null ? (outer.commandSink?.[0] ?? null) : null
    const caller: Caller = isolated
      ? { ...outer, ...(own === null ? {} : { recording: own }), commandSink: [mine, mine] }
      : outer
    // The record names the session the op ran as: noted inside the
    // bind, since the facade's own id may be null (the default) and a
    // session bound by the caller is kept over it.
    let seen: string | null = null
    const run = (bound: SessionAccess | null = null): Promise<[unknown, IOResult]> => {
      seen = bound?.sessionId ?? getCurrentSession()?.sessionId ?? null
      // Resolved against the root: the dots simplified away for the op,
      // the typed spelling kept for the walk that proves them.
      const typed = PathSpec.fromStrPath(path, undefined, '/')
      const dispatch =
        bound === null || this.dispatchAs === null ? this.dispatchFn : this.dispatchAs(bound)
      const explicit = this.caller === null ? undefined : { ...currentCaller(), ...this.caller }
      return dispatch(op, typed, args, kwargs, report, explicit)
    }
    // `fallback` false hands over what was recorded below and makes no
    // record of its own: an admission check wrote nothing, and a write
    // record without a fingerprint would drop the path's snapshot pin.
    const settle = async (answer: unknown, fallback = true): Promise<void> => {
      const ran = report.path ?? spelled
      const owner = this.ownerOf(ran)
      const source = owner === null ? null : (report.source ?? owner.kind)
      const bytes = report.bytes ?? payloadBytes(answer, args)
      if (!isolated) {
        if (!fallback || !report.completed || source === null) return
        const rec = finishRecord(op, ran, source, bytes, timer)
        this.recorded.push(rec)
        if (this.sink !== null) await this.sink(rec, this.sessionFor(seen))
        return
      }
      if (fallback && mine.length === 0 && report.completed && source !== null) {
        callsAs(caller, record)(op, ran, source, bytes, timer)
      }
      enclosing?.push(...mine)
      if (own === null || own.records.length === 0) return
      const records = own.records.splice(0)
      this.recorded.push(...records)
      if (this.sink === null) return
      const session = this.sessionFor(seen)
      for (const rec of records) await this.sink(rec, session)
    }
    let result: unknown
    try {
      const bound = sessionId ?? this.sessionId
      const go = (): Promise<[unknown, IOResult]> =>
        this.bind === null ? run() : this.bind(bound, run)
      const [value] = await (isolated ? runWithCaller(caller, go) : go())
      result = value
    } catch (err) {
      // Anything thrown after the op ran (a postVfs deny, a hard
      // output cap, a bookkeeping failure) suppresses the result, not
      // the effect, so observation must reflect the op before the
      // error propagates. The dispatcher stamps the report at the moment of
      // completion, so even a foreign error the dispatcher never defined
      // leaves the transfer on the books.
      await settle(null)
      throw err
    } finally {
      // A write owns its source even when it never reaches the dispatcher
      // (an unknown session refused at the bind).
      if (op === 'write' || op === 'append')
        await closeQuietly((args[0] ?? kwargs.data ?? null) as ByteSource | null)
    }
    if (op === 'write' && kwargs.admit_only === true) {
      await settle(undefined, false)
      return result
    }
    if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
      const stream = recorded(result as AsyncIterable<Uint8Array>, () => settle(null))
      await stream.next()
      return stream
    }
    await settle(result)
    return result
  }

  /** The session id a record carries: the one the op ran as, else this
   * facade's own, else the unbound entry point's empty id. */
  private sessionFor(seen: string | null): string {
    return seen ?? this.sessionId ?? ''
  }

  // `raw` skips the filetype cascade: an explicit null filetype stops
  // the dispatcher from stamping the path's extension, so a rendered read op
  // (gdoc/gsheet/gslide) is bypassed and the stored bytes come back.
  // `offset`/`size` ride the same kwargs the generic read op already reads,
  // so a backend with a native range fetches one window instead of the whole
  // object. Python spells this `read(path, offset, size, raw)`.
  async read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null } = {},
    sessionId?: string,
  ): Promise<Uint8Array> {
    const kwargs: OpKwargs = options.raw === true ? { filetype: null } : {}
    const offset = options.offset ?? 0
    const size = options.size ?? null
    if (offset !== 0 || size !== null) {
      return (await this.through(
        'read',
        path,
        [],
        { ...kwargs, offset, size },
        sessionId,
      )) as Uint8Array
    }
    return (await this.through('read', path, [], kwargs, sessionId)) as Uint8Array
  }

  /**
   * Read file content as the caller pulls it. The first chunk is read before
   * this returns, so a missing file fails here rather than at the first pull.
   * A cold read fills the cache as it is pulled, and the read is recorded once
   * the stream ends. A read the dispatcher answers whole (a warm copy, a rendering,
   * a backend with no stream) arrives as one chunk. Python spells this
   * `read_stream(path, raw)`.
   */
  async readStream(
    path: string | PathSpec,
    options: { raw?: boolean } = {},
    sessionId?: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    const kwargs: OpKwargs =
      options.raw === true ? { filetype: null, stream: true } : { stream: true }
    return ensureStream((await this.through('read', path, [], kwargs, sessionId)) as ByteSource)
  }

  async write(
    path: string | PathSpec,
    data: ByteSource | string,
    sessionId?: string,
  ): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.through('write', path, [bytes], {}, sessionId)
  }

  /**
   * Append bytes or an async byte source through the dispatcher. A native
   * appendStream consumes incrementally; other mounts collect once before
   * their existing append or read-and-rewrite fallback.
   */
  async append(path: string | PathSpec, data: ByteSource, sessionId?: string): Promise<void> {
    await this.through('append', path, [data], {}, sessionId)
  }

  /**
   * Write bytes at an offset, keeping the rest of the file (the python
   * facade's `pwrite`). pwrite(2): the bytes outside the window stay, a gap
   * past the end reads back as zeros, and a missing file is created. It is
   * one write at the dispatcher, so a session that may write the file and not
   * read it can still do it.
   */
  async pwrite(
    path: string | PathSpec,
    data: Uint8Array,
    offset: number,
    sessionId?: string,
  ): Promise<void> {
    await this.through('pwrite', path, [data, offset], {}, sessionId)
  }

  async readdir(path: string | PathSpec, sessionId?: string): Promise<string[]> {
    return ((await this.through('readdir', path, [], {}, sessionId)) as string[] | null) ?? []
  }

  /**
   * One path's row. `nofollow` reports a trailing symlink itself rather
   * than its target (lstat), so a dangling link is a name that is there.
   * `fresh` asks the backend past the mount's listing index and reconciles
   * the index and file cache with its answer.
   */
  async stat(
    path: string | PathSpec,
    sessionId?: string,
    opts: { nofollow?: boolean; fresh?: boolean } = {},
  ): Promise<FileStat> {
    const kwargs = {
      ...(opts.nofollow === true ? { nofollow: true } : {}),
      ...(opts.fresh === true ? { fresh: true } : {}),
    }
    return (await this.through('stat', path, [], kwargs, sessionId)) as FileStat
  }

  // The three probes below answer "is this path there?", so only a path that
  // does not resolve may read back as false: absent, outside every mount, or
  // under a plain file (ENOTDIR). An auth failure, a timeout, or a backend
  // bug is not an answer to that question: swallowing it would let a caller
  // act on a false "missing" (overwrite, recreate, skip). Mirrors Python's
  // `(FileNotFoundError, NotADirectoryError, NoMountError)` swallow set.
  async exists(path: string | PathSpec, sessionId?: string): Promise<boolean> {
    try {
      await this.stat(path, sessionId)
      return true
    } catch (err) {
      if (isMissingPath(err) || isEnotdir(err)) return false
      throw err
    }
  }

  async isDir(path: string | PathSpec, sessionId?: string): Promise<boolean> {
    try {
      const s = await this.stat(path, sessionId)
      return s.type === FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err) || isEnotdir(err)) return false
      throw err
    }
  }

  async isFile(path: string | PathSpec, sessionId?: string): Promise<boolean> {
    try {
      const s = await this.stat(path, sessionId)
      return s.type !== FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err) || isEnotdir(err)) return false
      throw err
    }
  }

  async mkdir(path: string | PathSpec, sessionId?: string): Promise<void> {
    await this.through('mkdir', path, [], {}, sessionId)
  }

  async create(path: string | PathSpec, sessionId?: string): Promise<void> {
    await this.through('create', path, [], {}, sessionId)
  }

  /**
   * Create a namespace symlink at `path`.
   *
   * Routed through the dispatcher like every write: session grants and
   * admission policies fire on the link's turf, and the write lands on
   * the ledger. The target is stored verbatim as typed. Throws EEXIST
   * when something is already at `path` (a file, a directory, another
   * link, a mount root): symlink(2) never overwrites, and the dispatcher is
   * the layer that can see both planes to tell. Throws ENOENT when the
   * directory `path` would sit in is absent, and ENOTDIR when a
   * non-directory stands there or above it. Mirrors Python's
   * Files.symlink.
   */
  async symlink(path: string | PathSpec, target: string, sessionId?: string): Promise<void> {
    await this.through('symlink', path, [], { target }, sessionId)
  }

  /** The stored target of the link at `path`; EINVAL when not a link. */
  async readlink(path: string | PathSpec, sessionId?: string): Promise<string> {
    return (await this.through('readlink', path, [], {}, sessionId)) as string
  }

  /**
   * Write metadata fields, natively where the backend can hold them.
   *
   * Every field is passed, unset ones as undefined, because the dispatcher
   * reads the whole set and stores in the namespace overlay whatever
   * the backend cannot keep. A mount with no setattr op therefore still
   * answers: a chmod on an s3 or dropbox mount lands in the name plane
   * and stat reports it back. Stored, not enforced; the mount mode is
   * the access control. Returns what the backend could not keep.
   * Mirrors Python's Files.setattr.
   */
  async setattr(
    path: string | PathSpec,
    attrs: SetAttrFields = {},
    sessionId?: string,
  ): Promise<Record<string, number | string>> {
    const { nofollow = false, ...fields } = attrs
    return (await this.through('setattr', path, [], { ...fields, nofollow }, sessionId)) as Record<
      string,
      number | string
    >
  }

  /**
   * One extended attribute's value. The node table answers with what a
   * caller set. `nofollow` reads a link entry's own
   * attributes. Throws ENODATA when the path has no such attribute.
   * Mirrors Python's Files.getxattr.
   */
  async getxattr(
    path: string | PathSpec,
    name: string,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<Uint8Array> {
    const kwargs = { name, nofollow: opts.nofollow === true }
    return (await this.through('getxattr', path, [], kwargs, sessionId)) as Uint8Array
  }

  /** Every extended attribute name a path carries, sorted. */
  async listxattr(
    path: string | PathSpec,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<string[]> {
    const kwargs = { nofollow: opts.nofollow === true }
    return (await this.through('listxattr', path, [], kwargs, sessionId)) as string[]
  }

  /**
   * Store an extended attribute on a path's namespace node, so it works
   * on every backend and moves with a rename. `create` refuses with
   * EEXIST when it is set (XATTR_CREATE) and `replace` with ENODATA when
   * it is not (XATTR_REPLACE).
   * Mirrors Python's Files.setxattr.
   */
  async setxattr(
    path: string | PathSpec,
    name: string,
    value: Uint8Array,
    opts: { create?: boolean; replace?: boolean; nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<void> {
    const kwargs = {
      name,
      value,
      create: opts.create === true,
      replace: opts.replace === true,
      nofollow: opts.nofollow === true,
    }
    await this.through('setxattr', path, [], kwargs, sessionId)
  }

  /** Drop an extended attribute; ENODATA when it is not set. */
  async removexattr(
    path: string | PathSpec,
    name: string,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<void> {
    await this.through(
      'removexattr',
      path,
      [],
      { name, nofollow: opts.nofollow === true },
      sessionId,
    )
  }

  async truncate(path: string | PathSpec, length: number, sessionId?: string): Promise<void> {
    await this.through('truncate', path, [length], {}, sessionId)
  }

  async unlink(path: string | PathSpec, sessionId?: string): Promise<void> {
    await this.through('unlink', path, [], {}, sessionId)
  }

  async rmdir(path: string | PathSpec, sessionId?: string): Promise<void> {
    await this.through('rmdir', path, [], {}, sessionId)
  }

  /**
   * Rename a file or directory within one mount.
   *
   * Both ends must resolve to the same mount: a mount is a filesystem
   * boundary, and the dispatcher answers EXDEV across two (ENOENT when a
   * parent directory is missing), which a kernel-facing whole-workspace FUSE
   * mount needs so `mv` between two backends falls back to its copy+unlink
   * path. Mirrors Python's Files.rename.
   */
  async rename(src: string | PathSpec, dst: string | PathSpec, sessionId?: string): Promise<void> {
    await this.through('rename', src, [PathSpec.fromStrPath(dst, undefined, '/')], {}, sessionId)
  }

  async listFiles(path: string | PathSpec, sessionId?: string): Promise<string[]> {
    const entries = await this.readdir(path, sessionId)
    const files: string[] = []
    for (const fullPath of entries) {
      if (await this.isFile(fullPath, sessionId)) {
        files.push(fullPath.slice(fullPath.lastIndexOf('/') + 1))
      }
    }
    return files
  }
}

/**
 * `ws.vfs`: the files the host holds, with what only the host asks of them.
 *
 * The op ledger every ledgered facade appends to (`records`, with the
 * network/cache split derived from it). The `Files` a handler, a CLI leaf, a
 * runtime or `session.vfs` gets is a facade of its own, on which the ledger
 * would report only that facade, so it is a plain `Files`. Mirrors Python's
 * `WorkspaceFiles`, which also keeps the mount table in step and answers the
 * mount questions FUSE and the runtime's `open()` interception ask; here the
 * workspace's registry answers those.
 */
export class WorkspaceFiles extends Files {
  /**
   * The op ledger: every facade op lands here, and the executor appends each
   * shell line's ops too, so this is the one workspace-wide account (Python's
   * `WorkspaceFiles.records`).
   */
  get records(): OpRecord[] {
    return this.recorded
  }

  /** Total bytes transferred over the network. */
  get networkBytes(): number {
    let total = 0
    for (const r of this.recorded) if (!r.isCache) total += r.bytes
    return total
  }

  /** Total bytes served from cache. */
  get cacheBytes(): number {
    let total = 0
    for (const r of this.recorded) if (r.isCache) total += r.bytes
    return total
  }
}

/**
 * The namespace a session's files hold, for the code that walks it beside the
 * dispatcher; never a handler's (`FilesNamespace`). Mirrors Python's
 * `namespace_of`.
 */
export function namespaceOf(files: Files): FilesNamespace {
  return namespaceOfFiles(files)
}

/**
 * The namespace a session's files show, its hides applied, for the command
 * helpers that walk it (`FilesView`). Mirrors Python's `view_of`.
 */
export function viewOf(files: Files): FilesView {
  return viewOfFiles(files)
}

/**
 * Where the mount boundaries are, as the session the files run as sees them.
 *
 * Every mount below a path, hidden or not, is a boundary a backend's own walk
 * stops at: a mount the session cannot see still shadows the parent backend's
 * keys under its prefix. Only the visible ones are ever named. A walk through
 * the dispatcher (`crossing`) descends into each mount itself, so it has no
 * boundary to stop at: no mount below a path, and no mount root; and it takes
 * no mount's shortcut, so no mount answers a function for it, caps its globs
 * or narrows its search. Mirrors Python's `_mount_view`.
 */
function mountView(
  prefixes: () => readonly string[],
  vis: () => Visibility | null,
  ownerOf: OwnerOf,
  crossing: boolean,
): MountView {
  const below = (path: string): string[] => {
    if (crossing) return []
    const base = normDir(path)
    return [...prefixes()]
      .filter((prefix) => prefix !== base && prefix.startsWith(base))
      .sort(compareCodePoints)
      .map((prefix) => rstripSlash(prefix) || '/')
  }
  return {
    descendants: below,
    visibleDescendants: (path: string) => {
      const seen = vis()
      return below(path).filter((root) => pathVisible(seen, root))
    },
    isRoot: (path: string) => !crossing && prefixes().includes(normDir(path)),
    rootOf: (path: string) => ownerPrefix(prefixes(), path) ?? '/',
    maxDuEntries: (path: string) => ownerOf(path)?.maxDuEntries ?? null,
    answers: (path: string, name: string) =>
      !crossing && (ownerOf(path)?.calls?.has(name) ?? false),
    maxGlobMatches: (path: string) => (crossing ? null : (ownerOf(path)?.maxGlobMatches ?? null)),
    searchable: (path: string) => (crossing ? null : (ownerOf(path)?.searchable ?? null)),
  }
}

/**
 * The same files with `changes` said of every op's caller: a file tool's call,
 * a dry run's trace or a policy method's deciding mark. Never a handler's: the
 * dispatcher trusts the caller, so one that dropped its rule gate would read
 * past a path rule scoped to its command. Python's task context carries the
 * caller instead.
 */
export function withCaller(files: Files, changes: Partial<Caller>): Files {
  return callerFilesOf(files, changes)
}

// What a method reads files through: added to the method contexts here, where
// `Files` lives, so the policy and routing types import no workspace
// module. Read only: a write is refused and no method runs again for a read.
declare module '../policy/types.ts' {
  interface CommandContext {
    vfs?: Files
  }
  interface VfsContext {
    vfs?: Files
  }
  interface SessionContext {
    vfs?: Files
  }
  interface RouteContext {
    vfs?: Files
  }
}

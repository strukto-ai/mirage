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
import type { OpRecord, RecordingState } from '../observe/record.ts'
import { finishRecord, OpTimer, record } from '../observe/context.ts'
import { SystemClock, type Clock } from '../utils/clock.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import type { FileStat, SetAttrFields } from '../types.ts'
import { FileType, type MountMode, PathSpec } from '../types.ts'
import { isEnotdir, isMissingPath } from '../errors/fs.ts'
import {
  type Caller,
  type CallerDispatchFn,
  callsAs,
  currentCaller,
  effectivePathMode,
  getCurrentSession,
  runWithCaller,
  sessionVisibility,
} from '../context/session_context.ts'
import type { FollowOperands, OpKwargs, SessionAccess, SessionBind } from '../view/types.ts'
import { NamespaceReader } from './dispatcher/reader.ts'

/** Receives each record with the id of the session the op ran as. */
export type OpSink = (rec: OpRecord, sessionId: string) => Promise<void>

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
  // The line's operand resolution a command's globs give their matches.
  follow?: FollowOperands | null
  // Record each op on the ledger; false where the dispatcher does the accounting.
  ledger?: boolean
  // The mount whose command scope a command's files run in, null across
  // mounts; unset where nothing said one (`servedBy`).
  served?: Caller['mount']
  // The workspace clock a ledgered op is timed and stamped on; unset is the
  // system clock.
  clock?: Clock
}

// TypeScript has no package-private: the class assigns these from its static
// block, where its private members are in reach, and `readerOf`, `operandsOf`,
// `pathMode` and `withCaller` are the doors through them.
let readerOfFiles: (files: Files) => NamespaceReader
let pathModeOfFiles: (files: Files, path: string, follow: boolean) => Promise<MountMode | null>
let operandsOfFiles: (files: Files) => FollowOperands | null
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
    readerOfFiles = (files) => files.reader()
    pathModeOfFiles = (files, path, follow) => {
      const mode = (bound: SessionAccess | null): Promise<MountMode | null> => {
        const reader = files.reader()
        const virtual = follow ? reader.follow(path) : reader.followParent(path)
        const owner = reader.owner(virtual)
        if (owner === null) return Promise.resolve(null)
        return Promise.resolve(
          effectivePathMode(virtual, owner.prefix, owner.mode, bound ?? undefined),
        )
      }
      return files.bind === null ? mode(null) : files.bind(files.sessionId, mode)
    }
    operandsOfFiles = (files) => files.follow
    callerFilesOf = (files, changes) => files.forCaller(changes)
  }

  private readonly dispatchFn: CallerDispatchFn
  private readonly namespace: ((sessionId: string | null) => NamespaceReader) | null
  private readonly sink: OpSink | null
  private readonly bind: SessionBind | null
  private readonly dispatchAs: ((owner: SessionAccess) => CallerDispatchFn) | null
  private readonly caller: Partial<Caller> | null
  /** The session this facade runs as; null for the workspace's default. */
  readonly sessionId: string | null
  /** The op ledger this facade records on; `WorkspaceFiles.records` reads it. */
  protected readonly recorded: OpRecord[]
  private readonly follow: FollowOperands | null
  private readonly ledger: boolean
  private readonly clock: Clock
  /**
   * The mount whose command scope these files run in, null for a run across
   * mounts; undefined where nothing said one, which the async context
   * answers instead (`servedBy`).
   *
   * @internal
   */
  readonly served: Caller['mount'] | undefined

  /**
   * @param dispatch the workspace dispatcher every op goes to.
   * @param namespace the reader of the namespace for the session an op runs
   *   as (`Namespace.readers`); null for files outside a workspace, which see
   *   no link and no mount under the bound session's hides.
   * @param sink receives each record with the session it ran as.
   * @param options what a derived facade carries over.
   */
  constructor(
    dispatch: CallerDispatchFn,
    namespace: ((sessionId: string | null) => NamespaceReader) | null = null,
    sink: OpSink | null = null,
    options: FilesOptions = {},
  ) {
    this.dispatchFn = dispatch
    this.namespace = namespace
    this.sink = sink
    this.bind = options.bind ?? null
    this.dispatchAs = options.dispatchAs ?? null
    this.caller = options.caller ?? null
    this.sessionId = options.sessionId ?? null
    this.recorded = options.records ?? []
    this.follow = options.follow ?? null
    this.ledger = options.ledger ?? true
    this.served = options.served
    this.clock = options.clock ?? new SystemClock()
  }

  private options(): FilesOptions {
    return {
      bind: this.bind,
      dispatchAs: this.dispatchAs,
      sessionId: this.sessionId,
      records: this.recorded,
      clock: this.clock,
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
    return new Files(this.dispatchFn, this.namespace, this.sink, {
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
    return new Files(this.dispatchFn, this.namespace, this.sink, {
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
    return new Files(this.dispatchFn, this.namespace, this.sink, {
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
    return new Files(dispatch, this.namespace, null, {
      sessionId: this.sessionId,
      follow: this.follow,
      ledger: false,
    })
  }

  /**
   * The namespace as the session an op would run as sees it: the workspace's,
   * else, for files outside one, no link and no mount under the bound
   * session's hides. Mirrors Python's `Files._reader`.
   */
  private reader(): NamespaceReader {
    if (this.namespace === null) {
      return new NamespaceReader(
        null,
        () => [],
        this.sessionId,
        () => sessionVisibility(),
      )
    }
    return this.namespace(this.sessionId)
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
    return this.reader().mountOf(path)
  }

  /** Whether `path` is the root of a mount the session sees. Mirrors Python's
   * `Files.is_mount`. */
  isMount(path: string | PathSpec): boolean {
    return this.reader().isMount(path)
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
    return this.reader().submounts(path)
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
    const timer = new OpTimer(this.clock)
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
        : { records: [], mountId: null, ledger: null, clock: this.clock }
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
      const owner = this.reader().owner(ran)
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
      for (const item of records) this.recorded.push(item)
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
    if ((op === 'write' && kwargs.admit_only === true) || 'retained' in kwargs) {
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

  /**
   * Read file content, whole or as the caller pulls it. `raw` skips the
   * filetype cascade: an explicit null filetype stops the dispatcher from
   * stamping the path's extension, so a rendered read op
   * (gdoc/gsheet/gslide) is bypassed and the stored bytes come back.
   * `offset`/`size` ride the same kwargs the generic read op already reads,
   * so a backend with a native range fetches one window instead of the
   * whole object. `stream` answers with an async iterable: its first chunk
   * is read before this returns, so a missing file fails here rather than at
   * the first pull, a cold read fills the cache as it is pulled, and the read
   * is recorded once the stream ends. A read the dispatcher answers whole (a
   * window, a warm copy, a rendering, a backend answering bytes) arrives as
   * one chunk. Python spells this `read(path, offset, size, raw, stream=)`.
   */
  async read(
    path: string | PathSpec,
    options?: { raw?: boolean; offset?: number; size?: number | null; stream?: false },
    sessionId?: string,
  ): Promise<Uint8Array>
  async read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null; stream: true },
    sessionId?: string,
  ): Promise<AsyncIterable<Uint8Array>>
  async read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null; stream: boolean },
    sessionId?: string,
  ): Promise<Uint8Array | AsyncIterable<Uint8Array>>
  async read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null; stream?: boolean } = {},
    sessionId?: string,
  ): Promise<Uint8Array | AsyncIterable<Uint8Array>> {
    const kwargs: OpKwargs = options.raw === true ? { filetype: null } : {}
    const offset = options.offset ?? 0
    const size = options.size ?? null
    if (offset !== 0 || size !== null) Object.assign(kwargs, { offset, size })
    if (options.stream !== true) {
      return (await this.through('read', path, [], kwargs, sessionId)) as Uint8Array
    }
    return ensureStream(
      (await this.through('read', path, [], { ...kwargs, stream: true }, sessionId)) as ByteSource,
    )
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
   * Append bytes or an async byte source through the dispatcher: a VFS's
   * `append` takes either, and one with no `append` is read and rewritten.
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
 * `WorkspaceFiles`, which also answers the mount questions FUSE and the
 * runtime's `open()` interception ask; here the workspace's registry answers
 * those.
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
 * The namespace as the session a command's files run as sees it, for the
 * helpers that walk it (`NamespaceReader`); outside a workspace, no link and
 * no mount.
 *
 * The dispatcher's reader, never one of the facade's own: the link and mount
 * tables are the namespace's, and the reader filters every answer by the rule
 * the dispatcher refuses a call by. Mirrors Python's `reader_of`.
 */
export function readerOf(files: Files): NamespaceReader {
  return readerOfFiles(files)
}

/**
 * The mode a write at `path` meets, for the session `files` runs as
 * (`effectivePathMode`): asked under the binding its ops run under, so a
 * default session's profile counts, at the path a link leads to, where the
 * write lands, unless `follow` is off. Null where no mount owns it. Mirrors
 * Python's `path_mode`.
 */
export function pathMode(files: Files, path: string, follow = true): Promise<MountMode | null> {
  return pathModeOfFiles(files, path, follow)
}

/**
 * The line's operand resolution a command's globs give their matches, which a
 * command's files carry; null outside a line. Mirrors Python's `operands_of`.
 */
export function operandsOf(files: Files): FollowOperands | null {
  return operandsOfFiles(files)
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

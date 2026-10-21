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

import { closeQuietly } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'

import type { OpKwargs, SessionAccess } from '../../view/types.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { keepVersions } from '../../cache/file/io.ts'
import { drainBudget, type FileCache } from '../../cache/file/mixin.ts'
import { type KeyHold, KeyLock } from '../../cache/lock.ts'
import type { CacheManager } from '../../cache/manager.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import {
  dispatchStat,
  dotRefusal,
  hiddenWalk,
  readHitADir,
  walkSpelling,
} from '../../commands/builtin/utils/paths.ts'
import { getExtension } from '../../utils/filetype.ts'
import { IOResult, type OpReport, PipeStream } from '../../io/types.ts'
import {
  eacces,
  eexist,
  einval,
  enoent,
  eisdir,
  enotdir,
  enotempty,
  enotsup,
  erofs,
  isEnoent,
  isEnotdir,
  isMissError,
  isMissingOp,
  eloop,
  exdev,
  walkDeclined,
  noMount,
  noXattr,
  walkRefusal,
} from '../../errors/fs.ts'
import { CommandTimeoutError, type FsError } from '../../errors/types.ts'
import { Policies, PolicyDenied } from '../../policy/index.ts'
import type { Decisions } from '../../policy/decisions.ts'
import { Boundary } from '../../policy/boundary.ts'
import { METADATA_OPS } from '../../policy/constants.ts'
import { PolicyError } from '../../policy/errors.ts'
import { mountKey, underPath } from '../../utils/key_prefix.ts'
import { normDir, ownerPrefix, rstripSlash } from '../../utils/slash.ts'
import { CycleError, endsAtDot, norm, parent, posixNormpath } from '../../utils/path.ts'
import type { Visibility } from '../../types.ts'
import type { DryRun, EntryGate, VfsExplanation } from '../../policy/types.ts'
import {
  activeRecords,
  commandRecords,
  type LostPaths,
  lostPaths,
  record,
  recordIndex,
  runWithMountContext,
  runWithRecording,
  startOp,
} from '../../observe/context.ts'
import { wrapStream } from '../mount/mount.ts'
import type { OpRecord } from '../../observe/record.ts'
import { RETRACT_FINGERPRINT_OPS, WRITE_FINGERPRINT_OPS } from '../../observe/record.ts'
import { mergeReaddir, namespaceListing, namespaceStat } from '../../view/namespace_view.ts'
import { ebusy, isMissingPath } from '../../errors/fs.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { declared } from '../../vfs/call.ts'
import { WRITE_EFFECTS } from '../../vfs/constants.ts'
import { Effect, Target, type VfsCall } from '../../vfs/types.ts'
import {
  type CacheFacts,
  type CapacityResult,
  CapacityState,
  DEFAULT_READ_TTL,
  FileChangeKind,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  type SearchQuery,
  VFSName,
  WritePolicy,
} from '../../types.ts'
import { LentPayload, memoryAnswered, primed, served } from './stream.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountEntry } from '../mount/mount.ts'
import { mergeOverlayStat } from '../mount/namespace/overlay.ts'
import { Reconciler } from '../reconcile.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { ident } from '../../utils/stat_view.ts'
import {
  CALLS,
  COPY_OPS,
  DESTINATION_OPS,
  DIRECTORY_OPEN_OPS,
  DISPATCH_READ_OPS,
  DISPATCH_WRITE_OPS,
  ENTRY_CREATE_OPS,
  FILE_CREATE_OPS,
  HIDDEN_CREATE_OPS,
  LINK_ENTRY_OPS,
  NAMESPACE_TABLE_OPS,
  HIDE_FILTERED_OPS,
  NATIVE_WALK_OPS,
  NO_FOLLOW_OPS,
  POLICY_WRITE_OPS,
  READ_AHEAD_BYTES,
  READ_STAND_IN_OPS,
  SERIAL_WRITE_OPS,
  SETATTR_KEYS,
  STAMP_WRITE_OPS,
  XATTR_OPS,
} from './constants.ts'
import {
  type Caller,
  type CallerDispatchFn,
  effectivePathMode,
  explaining,
  getCurrentSession,
  hiddenRefusal,
  lineRunning,
  runWithCaller,
  sessionVisibility,
  sessionAccess,
} from '../../context/session_context.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { hiddenUnder, leadsHidden, moveReveals, pathVisible } from '../../utils/hidden.ts'
import { removeRemnants, visibleBelow, type RemnantChannel } from '../../utils/remnants.ts'
import { encodeText } from '../../shell/bytes.ts'

/**
 * Whether a completed write op was an append of no bytes. That is an open for
 * appending (`true >> f`): it may create the file, but it leaves an existing
 * one's times as they were. Mirrors Python's `_appends_nothing`.
 */
function appendsNothing(name: string, args: readonly unknown[]): boolean {
  const data = args[0]
  return name === 'append' && data instanceof Uint8Array && data.byteLength === 0
}

/**
 * Drop listing entries the bound session hides.
 *
 * Entry shapes vary by backend (bare names, trailing-slash names, full
 * paths), so each is keyed by its final segment against the listed
 * directory, the same normalization `mergeReaddir` dedups by.
 */
function visibleEntries(entries: string[], parent: string, vis = sessionVisibility()): string[] {
  const base = rstripSlash(parent)
  return entries.filter((e) => {
    const trimmed = rstripSlash(e)
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return pathVisible(vis, `${base}/${name}`)
  })
}

/**
 * Whether a scan guard's path is a directory: a file or a missing name has
 * nothing below it to scan. Mirrors Python's `_is_directory`.
 */
async function isDirectory(mount: MountEntry, path: PathSpec): Promise<boolean> {
  try {
    const found = (await mount.call('stat', path.virtual)) as FileStat | null
    return found?.type === FileType.DIRECTORY
  } catch (err) {
    if (!isMissingPath(err) && !isEnotdir(err)) throw err
    console.debug(`scan guard at ${path.virtual}: ${String(err)}`)
    return false
  }
}

/**
 * A one-call read's answer without the entries the session hides: what the
 * walk the read stands in for would see, since every call it makes reads a
 * hidden path as absent. A `read_tree` answer keeps the entries left visible,
 * keyed below `path`; `files_containing` keeps the files left visible;
 * `search` keeps the hits whose path is visible. Mirrors Python's
 * `_visible_answer`.
 */
function visibleAnswer(
  name: string,
  vis: Visibility | null,
  path: PathSpec,
  result: unknown,
): unknown {
  if (name === 'read_tree') {
    const base = rstripSlash(path.virtual)
    return new Map(
      [...(result as Map<string, FileStat>)].filter(([key]) => pathVisible(vis, `${base}/${key}`)),
    )
  }
  if (name === 'files_containing') {
    return (result as PathSpec[]).filter((hit) => pathVisible(vis, hit.virtual))
  }
  return (result as [string, string][]).filter(([hit]) => pathVisible(vis, hit))
}

/**
 * Whether a read-ahead fetches `path`, asked of the mount's index alone: a
 * file its listing sizes within READ_AHEAD_BYTES, and where the store reads a
 * batch, also a file the listing does not size. Mirrors Python's
 * `_fits_read_ahead`.
 */
function fitsReadAhead(entry: FileStat | null, batched: boolean): boolean {
  if (entry !== null && entry.type === FileType.DIRECTORY) return false
  const size = entry?.size ?? null
  return size === null ? batched : size <= READ_AHEAD_BYTES
}

/**
 * The bytes a batch read answered for `virtual`, null when it left the file
 * out. Mirrors Python's `_answered`.
 */
async function answered(
  batch: Promise<Map<string, Uint8Array>>,
  virtual: string,
): Promise<Uint8Array | null> {
  return (await batch).get(virtual) ?? null
}

/**
 * The last of a write's records that one of `ops` made at `virtual`. Mirrors
 * Python's `_record_of`.
 */
function recordOf(
  records: readonly OpRecord[],
  ops: ReadonlySet<string>,
  virtual: string,
): OpRecord | undefined {
  return [...records].reverse().find((rec) => ops.has(rec.op) && rec.path === virtual)
}

/**
 * Whether a backend listing holds the final name of `virtual`. Compared on
 * the final segment, because backends disagree on entry shape: bare names,
 * a trailing slash to mark a directory, or full paths. The same
 * normalization `mergeReaddir` dedupes on. Mirrors Python's `_lists`.
 */
function lists(listing: readonly string[], virtual: string): boolean {
  const trimmed = rstripSlash(virtual)
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return listing.some((entry) => {
    const segments = rstripSlash(entry).split('/')
    return segments[segments.length - 1] === name
  })
}

// The id of the session this dispatcher serves, empty for the unbound host
// view; the same binding the hides and modes above read.
function sessionId(): string {
  return getCurrentSession()?.sessionId ?? ''
}

/**
 * The `issuer` kwarg lifted off an op, with the kwargs it leaves behind.
 *
 * A caller that stamps its ops (a profile policy's bridge) does so as
 * an argument, and the dispatcher consumes it here: it reaches every gate the
 * dispatch clears as `VfsContext.issuer`, probes and cascades included,
 * and is never forwarded to a backend, which has no such argument.
 */
function takeIssuer(
  kwargs: Record<string, unknown> | undefined,
): [symbol | undefined, Record<string, unknown> | undefined] {
  const issuer = kwargs?.issuer
  if (typeof issuer !== 'symbol') return [undefined, kwargs]
  const rest = { ...kwargs }
  delete rest.issuer
  return [issuer, rest]
}

/** The cache facts of the mount that owns a path, uncacheable without one. */
function factsOf(mount: MountEntry | null): CacheFacts {
  if (mount === null || mount.retiring || !mount.vfs.cachesReads) {
    return { cacheable: false, ttl: DEFAULT_READ_TTL }
  }
  return {
    cacheable: true,
    ttl: mount.read.ttl,
    keepsVersions: mount.write === WritePolicy.CONDITIONAL,
  }
}

/**
 * Answer a mkdir on a read-only region the way the filesystem would. A
 * read-only filesystem refuses only a create it would really make, so the
 * answer is whatever the create runs into first, walking the components from
 * the mount root: a missing one is refused with EROFS, a file in the chain is
 * ENOTDIR, an existing leaf is EEXIST, and `mkdir -p` of a directory that is
 * already there succeeds. The blamed path is the first component that would
 * have been made, as GNU's `mkdir -p` names it (`'/ro/n'` for `/ro/n/m`).
 * Pinned against GNU coreutils 9.7 on a read-only tmpfs. Mirrors Python's
 * `_mkdir_on_read_only`.
 */
async function mkdirOnReadOnly(
  stat: (path: PathSpec) => Promise<FileStat>,
  prefix: string,
  mode: MountMode,
  path: PathSpec,
  parents: boolean,
  access?: SessionAccess,
): Promise<void> {
  const base = rstripSlash(prefix)
  const leaf = rstripSlash(path.virtual) || '/'
  if (leaf !== base && !leaf.startsWith(base + '/')) {
    throw erofs(path.virtual, `mount ${prefix} is read-only`)
  }
  const parts = leaf
    .slice(base.length)
    .split('/')
    .filter((part) => part !== '')
  const chain = parts.map((_, index) =>
    PathSpec.fromStrPath(`${base}/${parts.slice(0, index + 1).join('/')}`),
  )
  for (const [index, component] of chain.entries()) {
    let row: FileStat
    try {
      row = await stat(component)
    } catch (err) {
      if (!isEnoent(err)) throw err
      if (!parents && index < chain.length - 1) throw enoent(path.virtual)
      const blame =
        chain
          .slice(index)
          .find(
            (spec) => effectivePathMode(spec.virtual, prefix, mode, access) === MountMode.READ,
          ) ?? path
      throw erofs(blame.virtual, `mount ${prefix} is read-only`)
    }
    if (row.type !== FileType.DIRECTORY) {
      if (index === chain.length - 1) throw eexist(path.virtual)
      throw enotdir(parents ? component.virtual : path.virtual)
    }
  }
  if (!parents) throw eexist(path.virtual)
}

/** Ask a command's gate once about each distinct path an op reaches. */
function judge(gate: EntryGate, ...paths: readonly unknown[]): void {
  const specs = paths.filter((p): p is PathSpec => p instanceof PathSpec)
  for (const virtual of new Set(specs.map((p) => p.virtual))) gate.check(virtual)
}

/**
 * Whether the running line's newest word on `virtual` is that a change it
 * made took the path's version (a copy, a move, a removal). Bytes cached
 * before that change are not served: a later step of the same op can still
 * be running, and the path is evicted only once the op ends. A read or write
 * since stamps a newer record. Mirrors Python's `_retracted`.
 */
function retracted(virtual: string): boolean {
  const records = activeRecords()
  if (records === undefined) return false
  const rec = recordIndex(records).newestVersion(virtual)
  return rec !== null && RETRACT_FINGERPRINT_OPS.has(rec.op)
}

/**
 * A custom function's other path arguments, by position or keyword; a
 * rename's or a copy's destination is walked on its own. Mirrors Python's
 * `_operands`.
 */
function operands(
  name: string,
  args: readonly unknown[] | undefined,
  kwargs: Record<string, unknown> | undefined,
): [number | string, PathSpec][] {
  if (DESTINATION_OPS.has(name)) return []
  const found: [number | string, PathSpec][] = []
  ;(args ?? []).forEach((value, at) => {
    if (value instanceof PathSpec) found.push([at, value])
  })
  for (const [key, value] of Object.entries(kwargs ?? {})) {
    if (value instanceof PathSpec) found.push([key, value])
  }
  return found
}

/** The byte window a read asked for, whole file when it asked none. */
function readWindow(kwargs: OpKwargs | undefined): [number, number | null] {
  return [
    typeof kwargs?.offset === 'number' ? kwargs.offset : 0,
    typeof kwargs?.size === 'number' ? kwargs.size : null,
  ]
}

/** A read's kwargs with its range dropped: the whole file. */
function wholeRead(kwargs: OpKwargs): OpKwargs {
  return Object.fromEntries(
    Object.entries(kwargs).filter(([key]) => key !== 'offset' && key !== 'size'),
  ) as OpKwargs
}

/**
 * A stat row with the length the file cache holds, when the backend named
 * none. An API mount cannot size a file without fetching it, so once a read
 * kept its bytes, their length is the size, for every caller of the
 * dispatcher (a command, `ws.vfs`, FUSE, a runtime's `fs.stat`). The length
 * alone, read without revalidating: it serves no content. Mirrors Python's
 * `_sized`.
 */
async function sized(mount: MountEntry, path: PathSpec, row: unknown): Promise<unknown> {
  const manager = mount.cacheManager
  if (
    !(row instanceof FileStat) ||
    row.type !== FileType.FILE ||
    row.size !== null ||
    manager === null
  )
    return row
  const size = await manager.cachedSize(path)
  return size === null ? row : row.with({ size })
}

/** The dispatcher's link follow of one path, the final name too (`last`) or
 * only the names above it, with a loop thrown as ELOOP rather than the
 * namespace's CycleError. */
function followOrLoop(
  namespace: Namespace,
  path: PathSpec,
  last: boolean,
  spelled: string = path.virtual,
): string {
  try {
    return last ? namespace.follow(spelled) : namespace.followParent(spelled)
  } catch (err) {
    if (err instanceof CycleError) throw eloop(path.virtual)
    throw err
  }
}

/**
 * One op on its way through the dispatcher, as the stages hand it on. Mirrors
 * Python's `_Call`.
 */
interface Call {
  readonly name: string
  /** The op's path: walked, then followed. */
  path: PathSpec
  /** The path as the caller named it. */
  readonly typed: PathSpec
  /** A rename's walked destination. */
  dst: PathSpec | null
  /** The op's positional arguments; the operand walk replaces path ones. */
  args: readonly unknown[] | undefined
  /** The op's arguments; `follow` consumes `nofollow`. */
  kwargs: Record<string, unknown> | undefined
  /** The session's view, read once at the dispatcher. */
  readonly vis: Visibility | null
  readonly ruleGate: EntryGate | null
  readonly report: OpReport | undefined
  readonly issuer: symbol | undefined
  /** Whether the op acts on the final name itself. */
  readonly noFollow: boolean
  /**
   * Whether policy judges the op a write: set from the op's name by the
   * walk, and from the VFS's own declaration at admission.
   */
  write: boolean
  /** Whether a read is answered as it is pulled. */
  stream: boolean
  /** Whether a read skips the file cache, neither served from it nor kept in it. */
  direct: boolean
  /**
   * Whether a read only asks whether the file cache holds a copy: true once the
   * caller's rule lets the read through, else null; never the bytes, never the
   * backend.
   */
  warm: boolean
  /**
   * Whether a stat asks the backend past the mount's index, through a
   * throwaway store as a `read: fresh` probe does, with the index's rows only
   * as hints, and reconciles the index and file cache with the answer; it
   * runs under its path's writer hold, so no write to the path lands between
   * the two.
   */
  fresh: boolean
  /**
   * The path before a link at its final name was followed, the one a
   * listing's names are spelled under; null when nothing was followed.
   */
  walked: PathSpec | null
}

/**
 * A directory a glob walk lists for a pattern (`PathSpec.dir` shaped), as the
 * mount at `prefix` lists it: with the pattern, which a backend whose listing
 * is a window moves the window by. Null for any other path; a glob word left
 * as typed names no directory. Mirrors Python's MountEntry._scope.
 */
function globScope(path: PathSpec, prefix: string): PathSpec | null {
  const folder = rstripSlash(path.virtual) || '/'
  if (path.pattern === null || folder !== (rstripSlash(path.directory) || '/')) return null
  return new PathSpec({
    virtual: folder,
    directory: folder,
    vfsPath: mountKey(folder, rstripSlash(prefix)),
    pattern: path.pattern,
    resolved: false,
  })
}

/**
 * A listing's names spelled under the directory the caller asked for.
 * Listing a link to a directory lists the directory it reaches, and readdir
 * names its children under the path it was handed, as a walk through the
 * link spells them. A caller that handed the directory the link reaches, its
 * typed spelling riding along, asked for that one. Mirrors Python's
 * `_spelled_under`.
 */
function spelledUnder(call: Call, entries: string[]): string[] {
  const reached = rstripSlash(call.path.virtual)
  if (call.walked === null || rstripSlash(call.typed.virtual) === reached) return entries
  const asked = rstripSlash(call.walked.virtual)
  return entries.map((entry) =>
    entry.startsWith(`${reached}/`) ? asked + entry.slice(reached.length) : entry,
  )
}

/**
 * Whether a lookup is of a path the running command's line names. Under
 * `read: fresh` such a path is checked against the backend the first time the
 * command looks it up (`Reconciler.reconcileRead`), whatever it asks first
 * (`ls` lists its operand before it stats it): a metadata command reads no
 * bytes, so the cache gate never checks its operand, and a copy the backend
 * replaced would stay cached. The answer is kept for the command, so its later
 * lookups and the cache gate reuse it. The entries a walk reaches are left to
 * their listings. A lookup meets no rule (`METADATA_OPS`), so the command's
 * gate rides on its caller rather than on the call. Mirrors Python's `_names`.
 */
function names(call: Call, caller: Caller | null): boolean {
  return (
    (call.name === 'stat' || call.name === 'readdir' || call.name === 'exists') &&
    !call.fresh &&
    caller?.ruleGate?.judged.has(rstripSlash(call.path.virtual) || '/') === true
  )
}

/**
 * What the freshness probe of the running command got from the backend for a
 * stat's path, null when it asked nothing. Under `read: fresh` the probe
 * already asked the backend about the command's operand; asking again resolves
 * through listings the command has not re-checked. A stat that asks for what
 * the backend holds now (`fresh`) is the probe's own question, so it is asked.
 * Mirrors Python's `_probed`.
 */
function probed(call: Call, mount: MountEntry): FileStat | null {
  const manager = mount.cacheManager
  if (call.name !== 'stat' || call.fresh || manager === null) return null
  return manager.probedStat(call.path)
}

/** The filetype a read is rendered as, null for none. */
function readType(call: Call): string | null {
  const requested = call.kwargs?.filetype
  if (requested === undefined) return getExtension(call.path.virtual)
  return typeof requested === 'string' ? requested : null
}

/**
 * The virtual path each item of a custom function's answer names, null when
 * the answer is not a list of paths or of records with a `path`. Mirrors
 * Python's `_answer_paths`.
 */
function answerPaths(result: unknown): string[] | null {
  if (!Array.isArray(result)) return null
  const named: string[] = []
  for (const item of result as unknown[]) {
    const path =
      item instanceof PathSpec
        ? item
        : typeof item === 'object' && item !== null
          ? (item as { path?: unknown }).path
          : undefined
    if (!(path instanceof PathSpec)) return null
    named.push(path.virtual)
  }
  return named
}

/** Runs a write once the workspace admits it. */
type AdmitWrite = <T>(write: () => Promise<T>) => Promise<T>

export class Dispatcher {
  private readonly namespace: Namespace
  private readonly cache: FileCache & BaseVFS
  private readonly policies: Policies
  // The snapshot drift queue rides along because this is the one dispatcher:
  // a strict restore's pending fingerprint checks must run before ANY
  // op can touch a mount, and FUSE and `ws.vfs` reach here
  // without passing Workspace.dispatch.
  private readonly drift: DriftQueue | null
  // So does the workspace's write admission, which holds a write while a
  // capture reads.
  private readonly admitWrite: AdmitWrite | null
  // And the approval ledger, which a path rule that asks is put to where
  // no line is running.
  private readonly decisions: Decisions | null
  private access: SessionAccess | undefined
  // Who makes the op, when the entry point said so; null reads the
  // async context's, which on the fallback storage folds every live one.
  private caller: Caller | null = null
  private state = { writers: new KeyLock(), stores: new WeakMap<BaseVFS, number>(), storeCount: 0 }
  readonly reconciler: Reconciler

  constructor(
    namespace: Namespace,
    cache: FileCache & BaseVFS,
    policies?: Policies,
    drift?: DriftQueue,
    admitWrite?: AdmitWrite,
    decisions?: Decisions,
  ) {
    this.namespace = namespace
    this.cache = cache
    this.policies = policies ?? new Policies()
    this.drift = drift ?? null
    this.admitWrite = admitWrite ?? null
    this.decisions = decisions ?? null
    this.reconciler = new Reconciler(cache, namespace)
  }

  forSession(session: SessionAccess | null): Dispatcher {
    const bound = new Dispatcher(
      this.namespace,
      this.cache,
      this.policies,
      this.drift ?? undefined,
      this.admitWrite ?? undefined,
      this.decisions ?? undefined,
    )
    bound.access = sessionAccess(session)
    bound.caller = this.caller
    bound.state = this.state
    return bound
  }

  /**
   * This dispatcher run as `caller`: its checks read that caller's
   * session, line, dry run and call, not the async context's. A session
   * a `forSession` view already bound stays its own. Mirrors Python's
   * `caller` keyword on Dispatcher.dispatch.
   */
  private forCaller(caller: Caller): Dispatcher {
    const bound = new Dispatcher(
      this.namespace,
      this.cache,
      this.policies,
      this.drift ?? undefined,
      this.admitWrite ?? undefined,
      this.decisions ?? undefined,
    )
    // Without task isolation a caller read off the async context may be
    // another task's, so its session counts only where tasks are isolated;
    // elsewhere the checks keep folding every live session.
    bound.access =
      this.access ??
      (caller.session === null || !asyncContextIsolatesTasks
        ? undefined
        : sessionAccess(caller.session))
    bound.caller = caller
    bound.state = this.state
    return bound
  }

  private sessionId(): string {
    return this.access?.sessionId ?? sessionId()
  }

  /** The dry run the op is part of: the caller's, else the async context's. */
  private explaining(): VfsExplanation[] | DryRun | null {
    return this.caller === null ? explaining() : this.caller.explaining
  }

  /** Whether the op is a running line's: the caller's, else the async context's. */
  private lineRunning(): boolean {
    return this.caller === null ? lineRunning() : this.caller.refusals !== null
  }

  /**
   * The namespace's own answer for a path no backend serves.
   *
   * Child mounts and symlinks are structure the dispatcher owns, so a
   * directory that exists only because a mount or link sits below it
   * still lists and stats. Null for any other op, or when the
   * namespace knows nothing at `virtual`.
   */
  private namespaceResult(name: string, virtual: string): string[] | FileStat | null {
    const vis = sessionVisibility(this.access)
    if (name === 'readdir') {
      return namespaceListing(vis, this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    if (name === 'stat') {
      return namespaceStat(vis, this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    return null
  }

  dispatch: CallerDispatchFn = async (name, path, args, kwargs, report, caller) => {
    try {
      if (caller !== undefined && caller !== this.caller) {
        const view = this.forCaller(caller)
        const run = (): ReturnType<DispatchFn> => view.dispatch(name, path, args, kwargs, report)
        // What runs below the dispatcher (a policy, a backend's record)
        // reads the caller the dispatcher judges by, all but its rule gate:
        // a policy's own read below is no call of the command's. Without
        // task isolation that binding would reach other tasks' ops, so there
        // only the dispatcher's own checks read it.
        return await (asyncContextIsolatesTasks
          ? runWithCaller({ ...caller, ruleGate: null }, run)
          : run())
      }
      // Only forSession and forCaller know the owner. An unbound browser
      // call must keep the conservative live-session checks rather than
      // borrow the newest binding, which can belong to a wider concurrent
      // session.
      const run = (): ReturnType<DispatchFn> =>
        name === 'read' && kwargs?.warm !== true
          ? this.readRefusingDirs(path, args, kwargs, report)
          : this.dispatchAdmitted(name, path, args, kwargs, report)
      if (this.admitWrite === null || !POLICY_WRITE_OPS.has(name)) return await run()
      return await this.admitWrite(run)
    } finally {
      const data = args?.[0] ?? kwargs?.data
      if (
        (name === 'write' || name === 'append') &&
        data !== null &&
        typeof data === 'object' &&
        Symbol.asyncIterator in data
      ) {
        await closeQuietly(data as ByteSource)
      }
    }
  }

  private dispatchAdmitted: DispatchFn = async (name, path, args, kwargs, report) => {
    // The caller's own mark on the op, lifted before any gate fires so
    // each one is told whose op it judges.
    const [issuer, stripped] = takeIssuer(kwargs)
    kwargs = stripped
    // The dispatcher's own keywords: a read answered as it is pulled, a read of
    // what the backend holds now, past the file cache, a read of what the file
    // cache alone holds, and a stat of what the backend holds now, past the
    // mount's index.
    const admitOnly = (name === 'write' || name === 'stat') && kwargs?.admit_only === true
    if (admitOnly) {
      kwargs = { ...kwargs }
      delete kwargs.admit_only
    }
    const { stream, direct, warm, fresh, ...own } = (kwargs ?? {}) as {
      stream?: unknown
      direct?: unknown
      warm?: unknown
      fresh?: unknown
    }
    if (name === 'read' && (stream !== undefined || direct !== undefined || warm !== undefined))
      kwargs = own
    if (name === 'stat' && fresh !== undefined) kwargs = own
    if (name === 'read_many') {
      const { paths } = (kwargs ?? {}) as { paths?: PathSpec[] }
      await this.readMany([path, ...(paths ?? [])], issuer)
      return [null, new IOResult()]
    }
    const { scopes, ...searched } = (kwargs ?? {}) as { scopes?: PathSpec[] }
    if (name === 'search' && scopes !== undefined) {
      kwargs = searched
      if (scopes.length > 0) {
        const hits = await this.searchTogether([path, ...scopes], args, searched, report, issuer)
        return [hits, new IOResult()]
      }
    }
    await this.prepare()
    // With no scan guard on any mount, no path reaches one to ask.
    if (
      name === 'before_full_scan' &&
      !this.namespace.mountPrefixes().some((p) => this.namespace.mountFor(p).vfs.supports(name))
    ) {
      return [null, new IOResult()]
    }
    // The command's gate judges its own calls; a metadata call passes, as
    // its guards let stat pass, unless it only asks admission, and a scan
    // guard reads nothing: the rule judges each read it guards. A warm read
    // is judged in the cache stage, held or not: its answer stands in for the
    // read (a search's ruled-out file is read as empty), so it meets the rule
    // the read would.
    const isWarm = name === 'read' && warm === true
    const gate =
      (METADATA_OPS.has(name) && !admitOnly) || name === 'before_full_scan' || isWarm
        ? null
        : (this.caller?.ruleGate ?? null)
    const call = await this.walk(
      name,
      path,
      args,
      kwargs,
      gate,
      report,
      issuer,
      name === 'stat' && fresh === true,
    )
    call.stream = name === 'read' && stream === true
    call.direct = name === 'read' && direct === true
    call.warm = isWarm
    call.fresh = name === 'stat' && fresh === true
    await this.refuseRename(call)
    if (report) report.path = call.path.virtual
    if (admitOnly) {
      this.follow(call)
      if (name === 'stat') {
        memoryAnswered(report)
        return [null, new IOResult()]
      }
      const owner = this.namespace.tryMountFor(call.path.virtual)
      if (owner === null) throw enoent(call.path)
      const writeCall = CALLS.get('write')
      if (writeCall === undefined) throw new Error('missing write call definition')
      await this.admit(call, this.boundary(owner), writeCall)
      memoryAnswered(report)
      return [null, new IOResult()]
    }
    if (this.tableAnswers(name, call.path.virtual, call.kwargs)) {
      return [
        this.onDevice(
          name,
          call.path.virtual,
          await this.tableCall(name, call.path, call.args ?? [], call.kwargs ?? {}, report, issuer),
        ),
        new IOResult(),
      ]
    }
    this.follow(call)
    if (report) report.path = call.path.virtual
    await this.walkOperands(call)
    if (XATTR_OPS.has(name)) {
      return [
        await this.answerXattr(name, call.path, call.kwargs ?? {}, report, issuer),
        new IOResult(),
      ]
    }
    if (name === 'statfs') return [await this.statfs(call.path, issuer), new IOResult()]
    const owner = this.namespace.tryMountFor(call.path.virtual)
    // A mount with no scan guard has nothing to refuse, so a command asks
    // every mount it walks and only a guard costs a call.
    if (name === 'before_full_scan' && !owner?.vfs.supports(name)) {
      return [null, new IOResult()]
    }
    // The cache stage answers first where the file cache decides: a call
    // standing in for a read gives way to the read for a file it holds,
    // which is judged, and a warm read answers whether it holds one, judged
    // as the read it stands in for.
    if (READ_STAND_IN_OPS.has(name) && (await this.held(call, owner))) {
      memoryAnswered(report)
      return [null, new IOResult()]
    }
    if (call.warm) {
      const held = await this.held(call, owner)
      const ruleGate = this.caller?.ruleGate ?? null
      if (ruleGate !== null) judge(ruleGate, call.typed, call.walked, call.path)
      memoryAnswered(report)
      return [held ? true : null, new IOResult()]
    }
    // mkdir(2) looks its name up first, so on a read-only region that lookup
    // answers for the mode, after every other policy has spoken. A dry run
    // never looks, so it explains the mode's refusal.
    const looksUp =
      owner !== null &&
      name === 'mkdir' &&
      this.explaining() === null &&
      effectivePathMode(call.path.virtual, owner.prefix, owner.mode, this.access) === MountMode.READ
    const boundary = looksUp
      ? new Boundary(
          this.policies,
          owner.prefix,
          undefined,
          this.sessionId(),
          this.decisions,
          this.access,
          this.caller ?? undefined,
        )
      : this.boundary(owner)
    if (owner !== null) {
      const across = this.copyTarget(call, owner)
      if (across === null) await this.refuseCrossMount(call, owner)
      if (await this.declines(call)) {
        if (across !== null) throw exdev(call.path)
        if (name === 'search' || name === 'files_containing') return [null, new IOResult()]
        throw walkDeclined(owner.vfs.name, name, call.path)
      }
      const mark = declared(owner.vfs.constructor, name) ?? CALLS.get(name) ?? null
      if (mark === null) throw enotsup(owner.vfs.name, name, call.path)
      await this.admit(call, boundary, mark)
      if (looksUp) {
        await mkdirOnReadOnly(
          dispatchStat(this.dispatch),
          owner.prefix,
          owner.mode,
          call.path,
          call.kwargs?.parents === true,
          this.access,
        )
        await boundary.complete(mark, call.path, call.write, null, call.issuer)
        return [null, new IOResult()]
      }
      if (across !== null) {
        await this.copyAcross(call, owner, across)
        await boundary.complete(mark, call.path, call.write, null, call.issuer)
        return [null, new IOResult()]
      }
    }
    let resolved: [BaseVFS, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(call.path.virtual, false)
    } catch (err) {
      return [
        this.onDevice(name, call.path.virtual, await this.answerUnmounted(call, err)),
        new IOResult(),
      ]
    }
    const [vfs, resolvedScope, mode] = resolved
    // resolve() above already threw for a path outside every mount, so
    // this lookup cannot miss.
    const mount = this.namespace.mountFor(call.path.virtual)
    const scope = (name === 'readdir' ? globScope(call.path, mount.prefix) : null) ?? resolvedScope
    if (mount !== owner) throw ebusy(call.path.virtual)
    const links = this.namespace.symlinkTargets()
    if (
      name === 'rmdir' &&
      this.namespace
        .linkStatsBelow(call.path.virtual)
        .some(([link]) => pathVisible(call.vis, link) && !leadsHidden(call.vis, link, links))
    ) {
      throw enotempty(call.path.virtual)
    }
    const mark = declared(vfs.constructor, name) ?? CALLS.get(name) ?? null
    if (mark === null) throw enotsup(vfs.name, name, call.path)
    await mount.ensureReady()
    const cached = await this.serveCached(call, mount, vfs, boundary, mark)
    if (cached !== null) {
      return [cached, new IOResult()]
    }
    const settles =
      (DISPATCH_WRITE_OPS.has(name) || (call.write && !POLICY_WRITE_OPS.has(name))) &&
      !SERIAL_WRITE_OPS.has(name)
    let ran: Awaited<ReturnType<typeof this.callBackend>>
    try {
      ran = call.fresh
        ? await this.freshCall(call, mount, vfs, scope, mode)
        : await this.callBackend(call, mount, vfs, scope, mode)
    } catch (err) {
      if (settles) {
        await this.evictFailedWrite(
          name,
          call.path,
          call.dst,
          operands(name, call.args, call.kwargs),
          lostPaths(activeRecords()),
        )
      }
      throw err
    }
    const [answer, dst, fullArgs] = ran
    let result = this.filter(call, answer)
    if (settles) {
      await this.settleWrite(
        name,
        call.path,
        dst,
        fullArgs,
        operands(name, call.args, call.kwargs),
        answer,
      )
    }
    if (!CALLS.has(name)) result = this.customAnswer(call, vfs.name, result)
    // The transfer already happened, so a limit changes what the caller
    // receives, not what the backend moved; the report above already
    // carries the moved count.
    return [
      await boundary.complete(mark, call.path, call.write, result, call.issuer),
      new IOResult(),
    ]
  }

  /**
   * A read that refuses a directory with GNU's EISDIR, at the path it was
   * handed.
   *
   * A store answers a read of a directory in its own voice: ENOENT from a
   * keyed store, whose directory is a set of keys rather than an object, an
   * opaque error from sftp, no bytes from some drivers. So a read that fails
   * or answers no bytes asks whether its path is a directory (`readHitADir`),
   * and any other answer stands. A stream is judged as it is pulled; a live
   * pipe is no directory. Mirrors Python's Dispatcher._read_refusing_dirs.
   */
  private async readRefusingDirs(
    path: PathSpec,
    args: readonly unknown[] | undefined,
    kwargs: Record<string, unknown> | undefined,
    report: OpReport | undefined,
  ): Promise<[unknown, IOResult]> {
    let answer: [unknown, IOResult]
    try {
      answer = await this.dispatchAdmitted('read', path, args, kwargs, report)
    } catch (err) {
      if (await this.readHitADir(path, err)) throw eisdir(path)
      throw err
    }
    const [data, io] = answer
    if (data instanceof PipeStream) return answer
    if (data !== null && typeof data === 'object' && Symbol.asyncIterator in data) {
      const drained = this.drainRefusingDirs(path, data as AsyncIterable<Uint8Array>)
      await drained.next()
      return [drained, io]
    }
    if (
      ((data as Uint8Array | null)?.byteLength ?? 0) === 0 &&
      (await this.readHitADir(path, null))
    ) {
      throw eisdir(path)
    }
    return answer
  }

  /**
   * A streamed read that refuses a directory once it fails or ends with no
   * bytes. Run to its empty first step before it is handed on, as `primed`
   * runs a stream, so a caller that closes it before pulling still closes the
   * read. Mirrors Python's Dispatcher._drain_refusing_dirs.
   */
  private async *drainRefusingDirs(
    path: PathSpec,
    source: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    let empty = true
    try {
      yield new Uint8Array()
      for await (const chunk of source) {
        empty = empty && chunk.byteLength === 0
        yield chunk
      }
    } catch (err) {
      if (await this.readHitADir(path, err)) throw eisdir(path)
      throw err
    } finally {
      await closeQuietly(source)
    }
    if (empty && (await this.readHitADir(path, null))) throw eisdir(path)
  }

  /**
   * Whether a read of `path` that failed or answered no bytes reached a
   * directory, probed as this dispatcher's caller. The probes are the
   * dispatcher's own, no call of the command's, so its path rules do not
   * judge them; the caller's hides do. A policy's refusal is the dispatcher's
   * own answer rather than a store's, so it stands, and a dry run asks the
   * gates only, so it probes nothing. Mirrors Python's
   * Dispatcher._read_hit_a_dir.
   */
  private async readHitADir(path: PathSpec, err: unknown): Promise<boolean> {
    if (this.explaining() !== null || err instanceof PolicyDenied || err instanceof PolicyError) {
      return false
    }
    // A name the caller cannot see, or one whose walk crosses hidden space,
    // stays missing: probing past it, to its link's target, would tell that
    // it is there.
    const vis = sessionVisibility(this.access)
    if (
      !pathVisible(vis, path.virtual) ||
      leadsHidden(vis, path.virtual, this.namespace.symlinkTargets())
    ) {
      return false
    }
    const prober = this.caller === null ? undefined : { ...this.caller, ruleGate: null }
    // A read follows a final link, so the kind is its target's, as GNU's cat
    // calls a link to a directory one; the error keeps the name as typed.
    let followed: string
    try {
      followed = this.namespace.follow(path.virtual)
    } catch (e) {
      if (e instanceof CycleError) return false
      throw e
    }
    return readHitADir(
      (p) => this.lstat(prober, p),
      (p) => this.listing(prober, p),
      followed === path.virtual ? path : PathSpec.fromStrPath(followed),
      err,
    )
  }

  /** The entry at `path` itself, as lstat answers; throws when nothing is there. */
  private async lstat(caller: Caller | undefined, path: PathSpec): Promise<FileStat> {
    const [row] = await this.dispatch('stat', path, [], { nofollow: true }, undefined, caller)
    if (!(row instanceof FileStat)) throw enoent(path)
    return row
  }

  /** The entries of the directory at `path`. */
  private async listing(caller: Caller | undefined, path: PathSpec): Promise<string[]> {
    const [entries] = await this.dispatch('readdir', path, [], {}, undefined, caller)
    return [...(entries as string[])]
  }

  /**
   * Whether the file cache holds a copy of the call's path, asked of the store
   * without fetching the bytes or checking the copy against the backend: a
   * read of a held file is checked as it is served. Mirrors Python's
   * Dispatcher._held.
   */
  private async held(call: Call, mount: MountEntry | null): Promise<boolean> {
    const manager = mount?.cacheManager ?? null
    return manager !== null && (await manager.isCached(call.path))
  }

  /**
   * Rank several scopes as one query, as a store's `searchMany` does. One
   * call answers for them all where one mount serves every scope and its VFS
   * ranks a batch, past the same checks each scope's own search meets: each
   * is walked and followed, a path rule or a coded preVfs policy reaching
   * below any of them declines the batch (null), and every hit the session
   * hides is dropped. Otherwise, and while a postVfs policy speaks for the
   * session (it judges each scope's answer on its own), each scope is
   * searched on its own and the hits joined in scope order. Mirrors Python's
   * Dispatcher._search_together.
   */
  private async searchTogether(
    scopes: readonly PathSpec[],
    args: readonly unknown[] | undefined,
    kwargs: Record<string, unknown>,
    report: OpReport | undefined,
    issuer: symbol | undefined,
  ): Promise<[string, string][] | null> {
    await this.prepare()
    const gate = this.caller?.ruleGate ?? null
    const calls: Call[] = []
    for (const typed of scopes) {
      const call = await this.walk('search', typed, args, { ...kwargs }, gate, report, issuer)
      this.follow(call)
      calls.push(call)
    }
    const first = calls[0]
    const owner = first === undefined ? null : this.namespace.tryMountFor(first.path.virtual)
    if (
      first === undefined ||
      owner === null ||
      !owner.vfs.supports('searchMany') ||
      calls.some((call) => this.namespace.tryMountFor(call.path.virtual) !== owner) ||
      (await this.policies.wantsFor('postVfs', this.sessionId()))
    ) {
      const hits: [string, string][] = []
      for (const typed of scopes) {
        const [answer] = await this.dispatchAdmitted(
          'search',
          typed,
          args,
          issuer === undefined ? kwargs : { ...kwargs, issuer },
          report,
        )
        if (answer === null) return null
        hits.push(...(answer as [string, string][]))
      }
      return hits
    }
    for (const call of calls) {
      if (await this.declines(call)) return null
    }
    const mark = declared(owner.vfs.constructor, 'search') ?? CALLS.get('search') ?? null
    if (mark === null) throw enotsup(owner.vfs.name, 'search', first.path)
    const boundary = this.boundary(owner)
    for (const call of calls) await this.admit(call, boundary, mark)
    await owner.ensureReady()
    const result = await owner.searchMany(
      calls.map((call) => call.path.virtual),
      args?.[0] as SearchQuery,
    )
    served(report, result)
    const visible = result === null ? null : result.filter(([hit]) => pathVisible(first.vis, hit))
    return (await boundary.complete(mark, first.path, false, visible, issuer)) as
      | [string, string][]
      | null
  }

  /**
   * Keep the small files `typed` names in the read cache, for the reads a
   * command is about to make of them; nothing is answered. Each read that
   * follows still meets every check of its own and is served what this kept,
   * so nothing is fetched where a check could refuse that read before its
   * backend is asked: nothing in a dry run or while a coded preVfs policy
   * speaks for the session (the rule a one-call walk meets in `declines`),
   * and no path the session hides or a path rule reaches. A file already
   * kept, one a renderer answers, one pinned to a revision and one on a mount
   * that keeps no reads or holds its data locally (read as fast when asked)
   * is passed over. A store that reads a batch
   * (`readMany`) is asked once for the rest of its files; any other is asked
   * for each file its listing sizes within READ_AHEAD_BYTES. A failure is
   * logged and dropped: the read that follows meets it itself. Mirrors
   * Python's Dispatcher._read_many.
   */
  private async readMany(typed: readonly PathSpec[], issuer: symbol | undefined): Promise<void> {
    if (
      this.explaining() !== null ||
      (await this.policies.wantsFor('preVfs', this.sessionId(), this.lineRunning()))
    ) {
      return
    }
    await this.prepare()
    const gate = this.caller?.ruleGate ?? null
    const batches = new Map<string, [MountEntry, CacheManager, PathSpec[]]>()
    for (const path of typed) {
      let call: Call
      try {
        call = await this.walk('read', path, [], {}, null, undefined, issuer)
        this.follow(call)
      } catch (err) {
        console.debug(`read-ahead passes over ${path.virtual}: ${String(err)}`)
        continue
      }
      const mount = this.namespace.tryMountFor(call.path.virtual)
      const manager = mount === null ? null : this.filler(call, mount, mount.vfs)
      if (
        mount === null ||
        manager === null ||
        mount.retiring ||
        mount.vfs.local ||
        mount.revisions.has(call.path.virtual) ||
        (gate !== null && (gate.scopes(path.virtual) || gate.scopes(call.path.virtual)))
      ) {
        continue
      }
      const batch = batches.get(mount.prefix) ?? [mount, manager, []]
      batch[2].push(call.path)
      batches.set(mount.prefix, batch)
    }
    const warm = async (): Promise<void> => {
      for (const [mount, manager, paths] of batches.values()) {
        await mount.ensureReady()
        const batched = mount.vfs.supports('readMany')
        const entries = await mount.index.getMany(paths.map((p) => p.virtual))
        const wanted: PathSpec[] = []
        for (const p of paths) {
          if (
            fitsReadAhead(entries.get(p.virtual) ?? null, batched) &&
            !(await manager.isCached(p))
          ) {
            wanted.push(p)
          }
        }
        if (wanted.length === 0) continue
        let settle: (answers: Promise<Map<string, Uint8Array>>) => void = () => undefined
        const answers = new Promise<Map<string, Uint8Array>>((resolve) => {
          settle = resolve
        })
        // Each fill takes its generation, and the place its records start,
        // before the one request goes out: a write landing while it runs
        // keeps none of it.
        const fills = wanted.map((p) => {
          const filetype = getExtension(p.virtual)
          return manager.fill(
            p,
            batched
              ? () => answered(answers, p.virtual)
              : () =>
                  mount.call(
                    'read',
                    p.virtual,
                    [],
                    filetype === null ? {} : { filetype },
                    this.access,
                  ),
          )
        })
        if (batched) {
          settle(
            mount.readMany(
              wanted.map((p) => p.virtual),
              READ_AHEAD_BYTES,
            ),
          )
        }
        for (const outcome of await Promise.allSettled(fills)) {
          if (outcome.status === 'rejected') {
            console.debug(`read-ahead dropped: ${String(outcome.reason)}`)
          }
        }
      }
    }
    if (activeRecords() === undefined) await runWithRecording(warm)
    else await warm()
  }

  /**
   * Load the namespace and run what a snapshot restore left owed.
   *
   * Pending fingerprint checks from a strict snapshot restore run before
   * the op can touch a mount, whichever surface called: FUSE and `ws.vfs`
   * come straight here, so a drain that lived any higher would let a
   * first write clobber drifted state. drain() clears pending before it
   * stats, so its own probes cannot recurse into it. A dry run leaves them
   * pending, its policies' reads included: the check is no policy's
   * answer, and the op that does run still owes it. Mirrors Python's
   * Dispatcher._prepare.
   */
  private async prepare(): Promise<void> {
    await this.namespace.ensureLoaded()
    if (this.drift?.pending === true && this.explaining() === null) {
      // Resolve backend IDs afresh without consulting the restored index:
      // the check's own throwaway store, which a backend may answer by
      // asking for the one path.
      await this.drift.drain(this.namespace, async (p) => {
        const [stat] = await this.dispatch('stat', PathSpec.fromStrPath(p), [], {
          index: new ListingCheckStore(),
        })
        return stat
      })
    }
  }

  /**
   * Walk the op's path, as the kernel does before a call sees it.
   *
   * Hidden paths answer before anything else can: the typed path is
   * checked so a link inside hidden space cannot be followed out of it,
   * the followed path is re-checked (`follow`) so a visible link cannot
   * lead in, and a rename's or a copy's destination is a create. Every link
   * above the
   * final name is then followed, whatever the op does with the name:
   * command dispatch walks the operands it classifies, and this is the
   * same walk for every other caller (a relative word ln resolves itself,
   * `ws.vfs`, a runtime's os.symlink), so a link made, read or
   * removed under a linked directory lands in the directory the link
   * names. Mirrors Python's Dispatcher._walk.
   */
  private async walk(
    name: string,
    path: PathSpec,
    args: readonly unknown[] | undefined,
    kwargs: Record<string, unknown> | undefined,
    ruleGate: EntryGate | null,
    report: OpReport | undefined,
    issuer: symbol | undefined,
    fresh = false,
  ): Promise<Call> {
    const vis = sessionVisibility(this.access)
    const links = this.namespace.symlinkTargets()
    const hidden = !pathVisible(vis, path.virtual)
    if (hidden || leadsHidden(vis, path.virtual, links)) {
      // An op that follows a link into hidden space lands there, so it
      // answers as a create under a hidden directory does.
      const follows = !NO_FOLLOW_OPS.has(name) && kwargs?.nofollow !== true
      throw hiddenRefusal(
        vis,
        path.virtual,
        HIDDEN_CREATE_OPS.has(name) && (hidden || !follows),
        links,
      )
    }
    let dstArg = DESTINATION_OPS.has(name) ? args?.[0] : undefined
    if (dstArg instanceof PathSpec) {
      const dstHidden = !pathVisible(vis, dstArg.virtual)
      if (dstHidden || leadsHidden(vis, dstArg.virtual, links)) {
        throw hiddenRefusal(vis, dstArg.virtual, dstHidden || !COPY_OPS.has(name), links)
      }
    }
    // An operand the walk already refused (the empty name, a link loop)
    // names nothing an op can reach, whatever `virtual` says.
    for (const walkedArg of [path, dstArg]) {
      if (walkedArg instanceof PathSpec && walkedArg.walkError !== null) {
        throw walkRefusal(walkedArg)
      }
    }
    // A `.` or `..` resolves against the directory it sits in, so every
    // name in front of one has to be a directory: `virtual` simplified the
    // dots away and reaches `f` through a missing `nope/..`, the typed
    // spelling (`dotted`) does not. A trailing slash is part of that
    // spelling: `x/` must be a directory, so a create of one is EISDIR before
    // anything is looked up, as GNU tee and truncate answer `missing/` and
    // `f/`. Behind a dot (`x/./`) the walk through the dot answers first,
    // ENOENT or ENOTDIR, as GNU does. Deliberate divergence: under a parent
    // that is itself absent GNU reports the parent first (ENOENT); the
    // spelling is refused here without a round trip, so that corner reads
    // EISDIR.
    const slashed =
      FILE_CREATE_OPS.has(name) &&
      (path.dotted?.endsWith('/') === true || path.rawPath.endsWith('/'))
    if (slashed && !endsAtDot(path.rawPath === '' ? (path.dotted ?? '') : path.rawPath))
      throw eisdir(path)
    const renamed = dstArg instanceof PathSpec ? dstArg : null
    if (path.dotted !== null || (renamed !== null && renamed.dotted !== null)) {
      const walkStat = dispatchStat(
        fresh
          ? (op, p, a, k, r) => this.dispatch(op, p, a, { ...k, fresh: true }, r)
          : this.dispatch,
      )
      const follow = (virtual: string): string => this.namespace.follow(virtual)
      const visible = (virtual: string): boolean => pathVisible(vis, virtual)
      const refusal =
        hiddenWalk(path, follow, visible) ??
        (renamed !== null ? hiddenWalk(renamed, follow, visible) : null) ??
        (await dotRefusal(walkStat, path, follow, ENTRY_CREATE_OPS.has(name))) ??
        (renamed !== null ? await dotRefusal(walkStat, renamed, follow) : null)
      if (refusal !== null) throw refusal
    }
    if (slashed) throw eisdir(path)
    const [typed, typedDst] = [path, dstArg]
    path = this.walked(path, HIDDEN_CREATE_OPS.has(name))
    if (dstArg instanceof PathSpec) {
      dstArg = this.walked(dstArg, true)
      args = [dstArg, ...(args ?? []).slice(1)]
    }
    // The command's gate judges each spelling, as handed in and as walked,
    // once both walks have answered for hidden space: here for an op on the
    // name itself and for a destination, in `follow` for the rest.
    if ((typed.virtual.endsWith('/') || typed.rawPath.endsWith('/')) && kwargs !== undefined) {
      // A trailing slash names the directory a link at the final name
      // reaches, as path resolution reads `link/`.
      const rest = { ...kwargs }
      delete rest.nofollow
      kwargs = rest
    }
    const noFollow = NO_FOLLOW_OPS.has(name) || kwargs?.nofollow === true
    if (ruleGate !== null && noFollow) judge(ruleGate, typed, path, typedDst, dstArg)
    else if (ruleGate !== null) judge(ruleGate, typedDst, dstArg)
    return {
      name,
      path,
      typed,
      dst: dstArg instanceof PathSpec ? dstArg : null,
      args,
      kwargs,
      vis,
      ruleGate,
      report,
      issuer,
      noFollow,
      write: POLICY_WRITE_OPS.has(name),
      stream: false,
      direct: false,
      warm: false,
      fresh: false,
      walked: null,
    }
  }

  /**
   * Refuse a rename the namespace forbids before any backend runs.
   *
   * A rename re-anchors everything below its source while the hides stay
   * where they are written, so hidden content would land at paths the
   * session can see. Destroying hidden content is silent (rmR, the remnant
   * rmdir); relocating it into view is refused. Only a directory has
   * anything below it to re-anchor, so a file source passes. rename(2)
   * also replaces a destination directory only when it is empty, and the
   * node table is half of what empty means here: a link is invisible to
   * every backend, so a destination the backend reads as empty can still
   * hold one. Left to the backend the rename succeeded and the purge then
   * deleted the link with it, losing namespace state silently where POSIX
   * promises ENOTEMPTY. Mirrors Python's Dispatcher._refuse_rename.
   */
  private async refuseRename(call: Call): Promise<void> {
    const dst = call.dst
    if (call.name !== 'rename' || dst === null) return
    if (
      moveReveals(call.vis, call.path.virtual, dst.virtual) &&
      (await this.movedSourceIsDir(call.path, call.issuer))
    ) {
      throw eacces(call.path.virtual)
    }
    if (this.namespace.linkStatsBelow(dst.virtual).length > 0) throw enotempty(dst.virtual)
  }

  /**
   * Follow the final name, unless the op acts on the name itself.
   *
   * `nofollow` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts on a
   * link entry itself (chown -h writing the link's own attrs) keeps the
   * typed path. Consumed here, never forwarded. A copy writes its
   * destination as a write does, through a link at the final name; a
   * rename moves the name itself. A copy whose two ends then name one file
   * is refused: a backend that replaces its destination would delete the
   * source first. Mirrors Python's Dispatcher._follow.
   */
  private follow(call: Call): void {
    const nofollow = call.kwargs?.nofollow === true
    if (call.kwargs !== undefined && 'nofollow' in call.kwargs) {
      const rest = { ...call.kwargs }
      delete rest.nofollow
      call.kwargs = rest
    }
    const walked = call.path
    if (COPY_OPS.has(call.name) && call.dst !== null && !nofollow) {
      const dst = PathSpec.fromStrPath(followOrLoop(this.namespace, call.dst, true))
      if (dst.virtual !== call.dst.virtual) {
        if (!pathVisible(call.vis, dst.virtual)) throw hiddenRefusal(call.vis, dst.virtual, true)
        if (call.ruleGate !== null) judge(call.ruleGate, dst)
        call.dst = dst
        call.args = [dst, ...(call.args ?? []).slice(1)]
      }
    }
    if (nofollow && DIRECTORY_OPEN_OPS.has(call.name) && this.namespace.isLink(call.path.virtual)) {
      throw enotdir(call.path.virtual)
    }
    if (!NO_FOLLOW_OPS.has(call.name) && !nofollow) {
      const followed = followOrLoop(this.namespace, call.path, true)
      if (followed !== call.path.virtual) {
        call.walked = call.path
        call.path = PathSpec.fromStrPath(followed)
        if (!pathVisible(call.vis, call.path.virtual)) {
          throw hiddenRefusal(call.vis, call.path.virtual, HIDDEN_CREATE_OPS.has(call.name))
        }
      }
    }
    if (call.ruleGate !== null && !call.noFollow)
      judge(call.ruleGate, call.typed, walked, call.path)
    if (COPY_OPS.has(call.name) && call.dst?.virtual === call.path.virtual) throw einval(call.dst)
  }

  /**
   * Walk and follow each other path argument the way the path is: the same
   * hides, spelling checks and rule gate apply, and the followed spelling
   * replaces it. Mirrors Python's Dispatcher._walk_operands.
   */
  private async walkOperands(call: Call): Promise<void> {
    for (const [at, typed] of operands(call.name, call.args, call.kwargs)) {
      const other = await this.walk(call.name, typed, [], {}, call.ruleGate, undefined, call.issuer)
      this.follow(other)
      const landed = other.path
      if (typeof at === 'number') {
        call.args = (call.args ?? []).map((value, i) => (i === at ? landed : value))
      } else {
        call.kwargs = { ...call.kwargs, [at]: landed }
      }
    }
  }

  /**
   * The mount a copy's destination is on, when that is another mount whose
   * store may copy from this one's; null otherwise. Mirrors Python's
   * Dispatcher._copy_target.
   */
  private copyTarget(call: Call, owner: MountEntry): MountEntry | null {
    if (call.name !== 'copy' || call.dst === null) return null
    const other = this.namespace.tryMountFor(call.dst.virtual)
    if (other === null || other === owner || !other.vfs.supports('copyFrom')) return null
    return other
  }

  /**
   * Copy a file onto another mount, store to store.
   *
   * Admission judged the source as a read and the destination as a create
   * under its own mount's mode, as for a copy within one mount. The
   * destination's store copies from the source's where it can (one bucket to
   * another under one set of credentials); otherwise it answers EXDEV, as a
   * copy between two mounts always did, and the caller moves the bytes
   * itself. The destination's name is held, and its caches settled, on its
   * own mount; a copy past its timeout keeps the name until the store
   * answers. Mirrors Python's Dispatcher._copy_across.
   */
  private async copyAcross(call: Call, owner: MountEntry, other: MountEntry): Promise<void> {
    const dst = call.dst
    if (dst === null) throw exdev(call.path)
    await owner.ensureReady()
    await other.ensureReady()
    if (!(await other.canCopyFrom(owner, call.path.virtual))) throw exdev(call.path)
    const key = `${String(this.storeId(other.vfs))}:${mountKey(dst.virtual, rstripSlash(other.prefix))}`
    const line = activeRecords()
    const owners = this.owners([dst])
    try {
      await this.holdWrite(
        [key],
        other.opTimeout('copy'),
        'copy',
        `copy ${call.path.virtual}`,
        (onCall) => other.copyFrom(owner, call.path.virtual, dst.virtual, onCall),
        async () => {
          await this.settleWrite('copy', call.path, dst, [dst], [])
        },
        async () => {
          await this.evictFailedWrite('copy', call.path, dst, [], lostPaths(line), owners)
        },
      )
    } catch (err) {
      await this.evictFailedWrite('copy', call.path, dst, [], lostPaths(line))
      throw err
    }
  }

  /**
   * Answer EXDEV for a rename or a copy between two mounts.
   *
   * A mount is a filesystem boundary: rename(2) moves a name within one and
   * answers EXDEV across two, before any permission is weighed, so `mv`
   * falls back to copy and unlink instead of the source's backend taking
   * the destination for one of its keys; a backend copies only within
   * itself, the same way. It resolves both parent directories first, so a
   * missing one is ENOENT (ENOTDIR through a file) ahead of EXDEV. Mirrors
   * Python's Dispatcher._refuse_cross_mount.
   */
  private async refuseCrossMount(call: Call, owner: MountEntry): Promise<void> {
    // A function runs on one backend, so every path it is handed must be
    // on the mount that serves it.
    for (const [, other] of operands(call.name, call.args, call.kwargs)) {
      if (this.namespace.tryMountFor(other.virtual) !== owner) throw exdev(other)
    }
    const dst = call.dst
    if (dst === null || this.namespace.tryMountFor(dst.virtual) === owner) return
    // A copy between two stores that cannot make it is the caller's cue to
    // move the bytes, whose read and write word any missing parent
    // themselves, so it asks the backends nothing.
    if (call.name === 'copy') throw exdev(call.path)
    throw (
      (await this.parentRefusal(call.path, call.issuer)) ??
      (await this.parentRefusal(dst, call.issuer)) ??
      exdev(call.path)
    )
  }

  /**
   * Whether a one-call walk gives way to the caller's own walk.
   *
   * A backend's find, du, search, tree copy or tree removal answers for
   * every entry under its path in one call, past the checks each entry would
   * meet on its own. So when the command's path rules or, for a `ws.vfs`
   * call, a coded preVfs policy reach below one of its paths, it is declined
   * and the caller walks, entry by entry, through calls that are each judged.
   * Inside a running line only the profile's path rules judge an entry, so a
   * coded policy declines no walk there. A path rule declines no
   * `files_containing`: its answer only rules files out of a walk that still
   * lists every one, and each file it rules out meets the rule as a warm read,
   * so one the rule refuses reports `Permission denied` as its read would. A
   * hide declines the copies and the removal, which would reach hidden
   * entries; a read in HIDE_FILTERED_OPS
   * runs and `filter` drops what the session hides from its answer. A file
   * copy is declined the same way: the bytes it moves never pass through a
   * read. A tree copy is declined too when a link stands below its
   * destination: the backend writes each child name as it is, where the
   * walk's copies follow the link. Mirrors Python's Dispatcher._declines.
   */
  private async declines(call: Call): Promise<boolean> {
    if (!NATIVE_WALK_OPS.has(call.name)) return false
    if (
      call.name === 'dir_copy' &&
      call.dst !== null &&
      this.namespace.linkStatsBelow(call.dst.virtual).length > 0
    ) {
      return true
    }
    const paths = call.dst === null ? [call.path] : [call.path, call.dst]
    if (!HIDE_FILTERED_OPS.has(call.name) && paths.some((p) => hiddenUnder(call.vis, p.virtual))) {
      return true
    }
    if (call.ruleGate !== null) {
      return (
        call.name !== 'files_containing' &&
        paths.some((p) => call.ruleGate?.scopes(p.virtual) === true)
      )
    }
    return this.policies.wantsFor('preVfs', this.sessionId(), this.lineRunning())
  }

  /**
   * Run admission for an op on a mounted path.
   *
   * Admission policies fire at the dispatcher, before the warm-cache early
   * return: a cached read must be refused exactly like a cold one, or the
   * cache becomes a policy bypass. This dispatcher is the one dispatcher in
   * TypeScript: shell internals, programmatic access, `ws.vfs`, and
   * FUSE all end up here. A rename's or a copy's destination is a create
   * there: it passes the same gate as the source, so a path rule holds
   * against moving or copying into a protected scope (or onto the directory
   * that holds one) the way it holds against writing there, under the mode
   * of the mount that owns it. A copy only reads its source. Mirrors
   * Python's Dispatcher._admit.
   */
  private async admit(call: Call, boundary: Boundary, mark: VfsCall): Promise<void> {
    // A function the VFS declares a write is judged as one, whatever its
    // name: the POSIX names are known here, a custom one only to the VFS
    // that defines it.
    call.write = call.write || WRITE_EFFECTS.includes(mark.effect)
    const gate = call.ruleGate === null ? {} : { gate: call.ruleGate }
    await boundary.admit(
      mark,
      call.path,
      call.write && !COPY_OPS.has(call.name),
      { final: call.dst === null, ...gate },
      call.issuer,
    )
    if (call.dst !== null) {
      await this.boundary(this.namespace.tryMountFor(call.dst.virtual)).admit(
        { ...mark, creates: true },
        call.dst,
        true,
        gate,
        call.issuer,
      )
    }
    for (const [, other] of operands(call.name, call.args, call.kwargs)) {
      await boundary.admit(mark, other, call.write, gate, call.issuer)
    }
  }

  /**
   * Answer an op on a path no mount serves.
   *
   * The namespace may still know a directory there (a deeper mount, a
   * link). No mount means no cache to keep straight and no owning prefix
   * (the gates see ''), but admission still fires: a policy that bounds
   * readdir or stat by path must cover the synthetic answer too. A real but
   * ungranted mount is the same case: a granted mount below it already put
   * this path's name in a listing, so walking down to the grant must
   * answer, and the merged names are session-filtered individually, so
   * nothing of the mount's own content leaks. A setattr with no owning
   * mount lands in the overlay (a link above every mount still takes
   * chown -h), gated exactly like the mounted overlay write; an ungranted
   * mount is not that case and keeps the canonical denial. Mirrors Python's
   * Dispatcher._answer_unmounted.
   */
  private async answerUnmounted(call: Call, err: unknown): Promise<unknown> {
    const bare = this.boundary(null)
    const mark = CALLS.get(call.name)
    if (mark === undefined) throw enotsup('namespace', call.name, call.path)
    if (call.name === 'setattr' && isMissingPath(err)) {
      await bare.admit(mark, call.path, true, {}, call.issuer)
      const stored = await this.overlaySetattr(call.path, call.kwargs ?? {})
      memoryAnswered(call.report)
      await bare.complete(mark, call.path, true, stored, call.issuer)
      return stored
    }
    let fallback = isMissingPath(err) ? this.namespaceResult(call.name, call.path.virtual) : null
    if (fallback === null) throw err
    if (call.name === 'readdir' && Array.isArray(fallback)) {
      fallback = visibleEntries(fallback, call.path.virtual, sessionVisibility(this.access))
    }
    await bare.admit(mark, call.path, call.write, {}, call.issuer)
    // A synthetic namespace answer (a directory that exists only because a
    // mount or a link sits below it) contacts nothing, so attributing it to
    // the mount that lexically owns the path would invent a network op
    // against that backend. Stamped before the gate and the cap, so
    // whatever they throw cannot erase it.
    memoryAnswered(call.report)
    return bare.complete(mark, call.path, call.write, fallback, call.issuer)
  }

  /**
   * Whether a read is answered as it is pulled. A whole read of stored bytes
   * streams through the VFS's own `readStream`. A window, a rendering, a VFS
   * with no stream and a postVfs policy that may read the result each get the
   * whole bytes instead, which are a stream of one chunk. A read a running
   * line makes reaches no postVfs policy, so it streams either way. Mirrors
   * Python's Dispatcher._streams.
   */
  private async streams(call: Call, mount: MountEntry, vfs: BaseVFS): Promise<boolean> {
    const [offset, size] = readWindow(call.kwargs)
    if (
      !call.stream ||
      offset !== 0 ||
      size !== null ||
      !vfs.supports('readStream') ||
      this.rendersRead(call, mount)
    ) {
      return false
    }
    return this.lineRunning() || !(await this.policies.wantsFor('postVfs', this.sessionId()))
  }

  /**
   * Open a streamed read, its first chunk pulled before it returns. A cold
   * read fills the cache as it is pulled. A live pipe's read is neither
   * pulled nor cached: it answers as a `PipeStream`. Mirrors Python's
   * Dispatcher._open_stream.
   */
  private async openStream(
    call: Call,
    mount: MountEntry,
    scope: PathSpec,
    filler: CacheManager | null,
  ): Promise<AsyncIterable<Uint8Array>> {
    const [source, records] = await commandRecords((mine) =>
      Promise.resolve([mount.readStream(scope, this.access), mine] as const),
    )
    const pipe = mount.livePipe(scope.virtual, this.access)
    if (pipe !== null) {
      const live = new PipeStream(await primed(source, call.report, false), call.path, pipe)
      pipe.readers.add(new WeakRef(live))
      return live
    }
    const stream =
      filler === null
        ? source
        : filler.fillStream(call.path, source, records, () => !this.rendersRead(call, mount))
    return await primed(stream, call.report)
  }

  /** Whether a filetype renderer answers this read on `vfs`; asked each
   * time, since a renderer can land while the read runs. */
  private rendersRead(call: Call, mount: MountEntry): boolean {
    return mount.renders(readType(call))
  }

  /**
   * Answer a read from the file cache, or null to read the backend.
   *
   * The file cache holds what commands read, keyed on the path alone: the
   * stored bytes, which are the rendering for a VFS with no `read` of its
   * own. A read through a filetype renderer (whoever registered it) asks
   * for a different value under the same key, so it is neither served
   * from that cache nor kept in it, and neither is a direct read
   * (`direct: true`), which asks for what the backend holds now: a
   * follow's poll for bytes the cached copy cannot have yet. The cache
   * holds the whole object, so a ranged read is answered by slicing it,
   * never by handing back the whole file: the window is what the caller
   * asked for instead of the file, and git reads pack indexes this way.
   * sliceWindow is the same helper the ranged read op falls back to, so
   * warm and cold agree.
   * Mirrors Python's Dispatcher._serve_cached.
   */
  private async serveCached(
    call: Call,
    mount: MountEntry,
    vfs: BaseVFS,
    boundary: Boundary,
    mark: VfsCall,
  ): Promise<Uint8Array | null> {
    if (call.direct || !vfs.cachesReads || !DISPATCH_READ_OPS.has(call.name)) return null
    const cached = await this.cache.get(call.path.virtual)
    if (
      cached === null ||
      retracted(call.path.virtual) ||
      !(await this.reconciler.mayServeCached(mount, call.path.virtual)) ||
      this.rendersRead(call, mount) ||
      mount.retiring ||
      this.namespace.tryMountFor(call.path.virtual) !== mount
    ) {
      return null
    }
    mount.refuseKeywords(call.name, call.kwargs ?? {})
    const [offset, size] = readWindow(call.kwargs)
    const window = sliceWindow(cached, offset, size)
    // Nothing crossed the network, and neither a gate nor a hard cap leaves
    // the caller able to tell: without the stamp a refused warm read is
    // recorded against the backend and counted as traffic that never
    // happened.
    memoryAnswered(call.report, window.byteLength)
    return (await boundary.complete(mark, call.path, call.write, window, call.issuer)) as Uint8Array
  }

  /**
   * The cache manager a cold read fills, or null to keep nothing.
   *
   * A cold read keeps the whole file it fetched for the next reader,
   * through the mount's own manager, the one a command's read fills: a
   * write racing the fetch retires its generation, so the bytes it read
   * are not kept. A ranged read comes from the store only where the store
   * can serve one; elsewhere the read op would fetch the whole file and
   * slice it for every range, so the whole file is read once, kept, and
   * each range sliced from it. The op is resolved only once the mount is
   * ready, so a renderer can land after this check; the fill asks again
   * before it keeps anything. Mirrors Python's Dispatcher._filler.
   */
  private filler(call: Call, mount: MountEntry, vfs: BaseVFS): CacheManager | null {
    const [offset, size] = readWindow(call.kwargs)
    const whole = offset === 0 && size === null
    return vfs.cachesReads &&
      !call.direct &&
      DISPATCH_READ_OPS.has(call.name) &&
      size !== 0 &&
      (whole || !mount.readsRanges(call.path.virtual)) &&
      !this.rendersRead(call, mount)
      ? mount.cacheManager
      : null
  }

  /**
   * How many files the session sees under a scan guard's path, counted off
   * the mount's `readTree` with every hidden file dropped, so a guard's
   * refusal never counts what the session cannot see; null when the mount
   * cannot answer the subtree in one call. Mirrors Python's
   * Dispatcher._visible_files.
   */
  private async visibleFiles(mount: MountEntry, vfs: BaseVFS, call: Call): Promise<number | null> {
    if (!vfs.supports('read_tree')) return null
    const found = (await mount.call('read_tree', call.path.virtual)) as Map<string, FileStat> | null
    if (found === null) return null
    const visible = visibleAnswer('read_tree', call.vis, call.path, found) as Map<string, FileStat>
    return [...visible.values()].filter((st) => st.type === FileType.FILE).length
  }

  /**
   * Run a fresh stat under its path's writer hold, so no local write to the
   * path lands between the backend's answer and its reconcile. The wait for
   * the hold is bounded by the stat's own timeout, since a write the clock
   * gave up on keeps the path until its call settles; a waiter past it leaves
   * the queue rather than running late. Once admitted, the backend call keeps
   * its own timeout and the reconcile runs to its end under the hold. Mirrors
   * Python's Dispatcher._fresh_call.
   */
  private async freshCall(
    call: Call,
    mount: MountEntry,
    vfs: BaseVFS,
    scope: PathSpec,
    mode: MountMode,
  ): Promise<[unknown, PathSpec | null, readonly unknown[]]> {
    const key = `${String(this.storeId(vfs))}:${mountKey(call.path.virtual, rstripSlash(mount.prefix))}`
    const seconds = mount.opTimeout('stat')
    const expired = new AbortController()
    let admitted = false
    const timer =
      seconds !== null && seconds > 0
        ? setTimeout(() => {
            if (!admitted) expired.abort()
          }, seconds * 1000)
        : undefined
    try {
      return await this.state.writers.withLock(
        key,
        () => {
          admitted = true
          return this.callBackend(call, mount, vfs, scope, mode)
        },
        expired.signal,
      )
    } catch (err) {
      if (expired.signal.aborted && seconds !== null) {
        throw new CommandTimeoutError('stat', seconds)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Run the op on its mount and stamp what it moved.
   *
   * Returns the op's answer with the rename destination and the arguments
   * the backend received, which the write's settling reads. Mirrors
   * Python's Dispatcher._call.
   */
  private async callBackend(
    call: Call,
    mount: MountEntry,
    vfs: BaseVFS,
    scope: PathSpec,
    mode: MountMode,
  ): Promise<[unknown, PathSpec | null, readonly unknown[]]> {
    const { name, path: p, kwargs, report } = call
    const mountPrefix = mount.prefix
    const filler = this.filler(call, mount, vfs)
    const filetype = getExtension(p.virtual)
    const [readOffset, readSize] = readWindow(kwargs)
    const whole = readOffset === 0 && readSize === null
    // Ops registered under a rendered filetype (gdocs/gsheets/gslides/
    // gmail reads) resolve by the path's extension; Python reaches them
    // because its dispatcher routes through Mount.call, which
    // stamps the filetype. Stamp it here the same way.
    // Every path argument beside the path (a rename's destination, a
    // custom function's other paths) is addressed against the same mount.
    const prefix = rstripSlash(mountPrefix)
    const keyed = (value: unknown): unknown =>
      value instanceof PathSpec
        ? new PathSpec({
            virtual: value.virtual,
            directory: value.virtual.slice(0, value.virtual.lastIndexOf('/')) || '/',
            vfsPath: mountKey(value.virtual, prefix),
          })
        : value
    const fullKwargs: OpKwargs = {
      ...Object.fromEntries(Object.entries(kwargs ?? {}).map(([key, v]) => [key, keyed(v)])),
      ...(kwargs?.index === undefined ? this.indexKwargs(mount) : {}),
      ...(call.fresh ? { index: new ListingCheckStore({ hints: mount.index }) } : {}),
      ...(filetype !== null && kwargs?.filetype === undefined ? { filetype } : {}),
    }
    if (name === 'before_full_scan') {
      if (!(await isDirectory(mount, p))) return [null, null, []]
      fullKwargs.files = await this.visibleFiles(mount, vfs, call)
    }
    const dst =
      DESTINATION_OPS.has(name) && call.args?.[0] instanceof PathSpec ? call.args[0] : null
    const fullArgs = (call.args ?? []).map(keyed)
    // Per-op command limits bind to the executing (post-follow)
    // mount, and the timeout window covers only the backend op — cache
    // probes and post-write invalidation stay outside the budget —
    // mirroring Python's Mount.call.
    const opTimeout = mount.opTimeout(name)
    // A fill keeps the token its backend records with the read; a read
    // outside a line (FUSE, ws.vfs) records into a scope of its own for that.
    const recorded = <T>(fill: () => Promise<T>): Promise<T> =>
      filler !== null && activeRecords() === undefined
        ? runWithRecording(fill).then(([value]) => value)
        : fill()
    let result
    try {
      if (await this.streams(call, mount, vfs)) {
        return [await recorded(() => this.openStream(call, mount, scope, filler)), dst, fullArgs]
      }
      const run = (opKwargs: OpKwargs, onCall?: (call: Promise<unknown>) => void) =>
        mount.use(async () => {
          const answer = await runWithMountContext(
            () =>
              mount.runWithWriteRevisions(async () => {
                const pending = Promise.resolve(
                  name === 'setattr'
                    ? this.applySetattr(mount, scope, p, opKwargs)
                    : mount.callKeyed(name, scope, fullArgs, opKwargs, this.access),
                )
                onCall?.(pending)
                return runWithTimeout(pending, opTimeout, name)
              }),
            mount.mountId,
          )
          return wrapStream(answer, mount.mountId, mount.activity)
        })
      if (filler !== null) {
        const kept = await recorded(() =>
          filler.fill(
            p,
            () => run(wholeRead(fullKwargs)),
            () => !this.rendersRead(call, mount),
          ),
        )
        result =
          whole || !(kept instanceof Uint8Array) ? kept : sliceWindow(kept, readOffset, readSize)
      } else if (SERIAL_WRITE_OPS.has(name)) {
        // Held by the store's own object, so one store mounted twice is one
        // file, and a rename or a copy holds both of its names, taken in one
        // order so two between the same pair cannot deadlock. What the write
        // changes beside the store (caches, the node table's links and
        // attributes) changes under the same hold: a chain of renames
        // finishing out of order would move one name's attributes onto
        // another.
        // A copy meeting a live pipe holds no name: the pipe's other end may
        // need it (`cp f >(cat > f)`).
        const meetsPipe =
          dst !== null &&
          [p.virtual, dst.virtual].some((path) => mount.livePipe(path, this.access) !== null)
        const keys = meetsPipe
          ? []
          : [...new Set([p.virtual, ...(dst !== null ? [dst.virtual] : [])])]
              .map((virtual) => `${String(this.storeId(vfs))}:${mountKey(virtual, prefix)}`)
              .sort(compareCodePoints)
        let mine: OpRecord[] = []
        let line: readonly OpRecord[] | undefined
        let before: [Uint8Array, string | null] | null = null
        let payload: LentPayload | null = null
        const others = operands(name, call.args, kwargs)
        const owners = this.owners([
          p,
          ...(dst !== null ? [dst] : []),
          ...others.map(([, other]) => other),
        ])
        const own = async (
          onCall: (storeCall: Promise<unknown>) => void,
          holds: readonly KeyHold[],
        ): Promise<unknown> => {
          line = activeRecords()
          before = await this.cachedBefore(call, mount)
          if ((name === 'write' || name === 'append') && !(fullArgs[0] instanceof Uint8Array)) {
            const budget = factsOf(mount).cacheable ? drainBudget(this.cache) : 0
            payload = new LentPayload(fullArgs[0] as ByteSource, holds, budget)
            fullArgs[0] = payload.chunks()
            await this.invalidateStream(mount, p)
          }
          try {
            return await commandRecords((records) => {
              mine = records
              return run(fullKwargs, onCall)
            })
          } finally {
            if (payload !== null) await this.invalidateStream(mount, p)
          }
        }
        try {
          result = await this.holdWrite(
            keys,
            opTimeout,
            name,
            `${name} ${p.virtual}`,
            (onCall, holds) =>
              activeRecords() === undefined
                ? runWithRecording(() => own(onCall, holds)).then(([value]) => value)
                : own(onCall, holds),
            async (value) => {
              served(report, value, payload?.moved ?? null)
              await this.settleWrite(name, p, dst, fullArgs, others, value)
              await this.keepWritten(
                call,
                mount,
                payload === null ? fullArgs[0] : payload.whole(),
                mine,
                payload === null || payload.moved > 0 ? before : null,
              )
            },
            async () => {
              await this.evictFailedWrite(name, p, dst, others, lostPaths(line), owners)
            },
          )
        } catch (err) {
          await this.evictFailedWrite(name, p, dst, others, lostPaths(line))
          throw err
        }
      } else {
        if (names(call, this.caller)) await this.reconciler.reconcileRead(mount, p.virtual)
        const answered = probed(call, mount)
        result = answered ?? (await run(fullKwargs))
        if (call.fresh) {
          await this.reconciler.onFreshStat(
            mount,
            p.virtual,
            result instanceof FileStat ? result : null,
          )
        }
        if (name === 'stat') result = await sized(mount, p, result)
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (name === 'rmdir' && (code === 'ENOTEMPTY' || code === 'EEXIST')) {
        await this.rmdirRemnants(vfs, scope, mountPrefix, mode, err, call.ruleGate, call.issuer)
        result = null
      } else {
        const fallback =
          isMissingPath(err) || isEnotdir(err) ? this.namespaceResult(name, p.virtual) : null
        if (fallback === null) {
          if (call.fresh && (isMissingPath(err) || isEnotdir(err))) {
            await this.reconciler.onFreshStat(mount, p.virtual, null)
          } else {
            await this.reconciler.onEnoent(mount, name, p.virtual, err)
          }
          throw err
        }
        result = fallback
        memoryAnswered(report)
      }
    }
    // The op ran, whatever invalidation, the post gate, or an output
    // cap do next: stamped here so a failure in any of them cannot
    // erase a transfer the backend already made.
    served(report, result)
    return [result, dst, fullArgs]
  }

  /**
   * Keep a whole write's bytes for the next read, under its name's hold.
   *
   * The write's own record labels them with the token the backend
   * answered, so a `fresh` mount does not refetch what it just wrote; a
   * record moving another length than was sent keeps nothing, and so does a
   * name another mount took while the write ran, read under the cache's lock.
   * The bytes kept are a copy, so a caller reusing its buffer cannot change
   * them. Mirrors Python's Dispatcher._keep_written.
   */
  /**
   * The cached copy an append may extend, read under its name's hold before
   * the append runs: its bytes and their token. Mirrors Python's
   * Dispatcher._cached_before.
   */
  private async cachedBefore(
    call: Call,
    mount: MountEntry,
  ): Promise<[Uint8Array, string | null] | null> {
    if (call.name !== 'append' || !factsOf(mount).cacheable) return null
    const kept = await this.cache.get(call.path.virtual)
    if (kept === null) return null
    return [kept, (await this.cache.fingerprints([call.path.virtual]))[0] ?? null]
  }

  /** Drop content without losing the conditional-write baseline. */
  private async invalidateStream(mount: MountEntry, path: PathSpec): Promise<void> {
    const manager = mount.cacheManager
    if (manager === null) return
    const version = await manager.readVersion(path)
    await manager.invalidate(path, FileChangeKind.UPDATE)
    if (version !== null) await manager.keepVersion(path, version)
  }

  /**
   * Keep a write's bytes for the next read, under its name's hold. The
   * write's own record labels them with the token the backend answered, so
   * a `fresh` mount does not refetch what it just wrote; a record moving
   * another length than was sent keeps nothing. An append extends the cached
   * copy only where the file is proven to have been that copy: the backend
   * rewrote it whole, its read saw the copy's token, and its write moved the
   * copy's length plus the appended bytes. A store with no tokens, or one
   * that appends by itself, proves nothing, so the copy stays dropped. An
   * append of nothing that wrote nothing (`cmd >> f` opening `f`) leaves the
   * copy as it was; one that made the file anew drops it, and so does a
   * streamed one, whose name another writer could take while it waited.
   * Mirrors Python's Dispatcher._keep_written.
   */
  private async keepWritten(
    call: Call,
    mount: MountEntry,
    sent: unknown,
    records: readonly OpRecord[],
    before: [Uint8Array, string | null] | null,
  ): Promise<void> {
    if ((call.name !== 'write' && call.name !== 'append') || !factsOf(mount).cacheable) {
      return
    }
    const record = recordOf(records, WRITE_FINGERPRINT_OPS, call.path.virtual)
    let fingerprint = record?.fingerprint ?? null
    if (!(sent instanceof Uint8Array)) {
      if (fingerprint !== null) await mount.cacheManager?.keepVersion(call.path, fingerprint)
      return
    }
    let data: Uint8Array = sent.slice()
    if (call.name === 'append') {
      if (before === null) return
      const [kept, token] = before
      const seen = recordOf(records, new Set(['read']), call.path.virtual)?.fingerprint ?? ''
      if (sent.byteLength === 0 && record === undefined) {
        data = kept
        fingerprint = token
      } else if (
        record?.bytes !== kept.byteLength + sent.byteLength ||
        seen === '' ||
        seen !== token
      ) {
        return
      } else {
        data = new Uint8Array(kept.byteLength + sent.byteLength)
        data.set(kept)
        data.set(sent, kept.byteLength)
      }
    } else if (record !== undefined && record.bytes !== sent.byteLength) {
      await this.cache.remove(call.path.virtual)
      return
    }
    await mount.cacheManager?.keepWritten(call.path, data, fingerprint)
  }

  /**
   * Merge the namespace into a backend answer and drop hidden names.
   *
   * A listing gains the child mounts and links the namespace holds below
   * it and loses every name the session hides; a stat gains the attribute
   * overlay recorded at its path. Mirrors Python's Dispatcher._filter.
   */
  private filter(call: Call, result: unknown): unknown {
    if (call.name === 'readdir' && Array.isArray(result)) {
      return spelledUnder(
        call,
        visibleEntries(
          mergeReaddir(
            call.vis,
            result,
            this.namespace.mountPrefixes(),
            this.namespace,
            call.path.virtual,
          ),
          call.path.virtual,
          call.vis,
        ),
      )
    }
    if (call.name === 'stat' && result instanceof FileStat) {
      const name = rstripSlash(call.path.virtual).split('/').pop() ?? ''
      // A mount's root answers as the backend's own root; in the namespace
      // it is the name it is mounted at.
      const row = result.name === '/' && name !== '' ? result.with({ name }) : result
      return this.onDevice(
        call.name,
        call.path.virtual,
        mergeOverlayStat(this.namespace.metaFor(call.path.virtual), row),
      )
    }
    if (call.name === 'read_tree' && result instanceof Map) {
      result = this.onDevice(
        call.name,
        call.path.virtual,
        this.overlaid(
          call.path,
          this.withLinks(call.path, result as Map<string, FileStat>, call.vis),
        ),
      )
    }
    // A tree read keys its entries below the path; a search names each hit
    // itself, and a store can rank a hit from outside the scope (a whole
    // table, a filter it ignores), so every hit is checked.
    if (
      HIDE_FILTERED_OPS.has(call.name) &&
      result !== null &&
      result !== undefined &&
      (call.name !== 'read_tree' || hiddenUnder(call.vis, call.path.virtual))
    ) {
      return visibleAnswer(call.name, call.vis, call.path, result)
    }
    return result
  }

  /**
   * A stat, or a subtree's stats, on the device of the mount serving
   * `virtual`. The device is the id a runtime reports as a guest's st_dev,
   * so `stat %d` and `fs.stat` name one device, and a walk tells a mount
   * boundary by it. A path no mount serves is on the namespace's own, the
   * one a root mount would have. Anything but a stat or a subtree's stats
   * passes unchanged.
   */
  /**
   * A custom function's answer as the session may see it. A list of paths,
   * or of records with a `path`, loses what the session hides, as a
   * `files_containing` answer does. Any other answer cannot be told apart
   * from what it names, so it is declined while the session hides anything
   * under the call's path. No answer reveals nothing. Mirrors Python's
   * Dispatcher._custom_answer.
   */
  private customAnswer(call: Call, vfs: string, result: unknown): unknown {
    if (result === null || result === undefined) return result
    const named = answerPaths(result)
    if (named !== null) {
      const links = this.namespace.symlinkTargets()
      return (result as unknown[]).filter(
        (_, i) =>
          pathVisible(call.vis, named[i] ?? '') && !leadsHidden(call.vis, named[i] ?? '', links),
      )
    }
    if (hiddenUnder(call.vis, call.path.virtual)) throw walkDeclined(vfs, call.name, call.path)
    return result
  }

  private onDevice(name: string, virtual: string, result: unknown): unknown {
    if (name !== 'stat' && name !== 'read_tree') return result
    if (!(result instanceof FileStat) && !(result instanceof Map)) return result
    const mount = this.namespace.tryMountFor(virtual)
    const dev = ident(mount === null ? '/' : mount.prefix)
    if (result instanceof FileStat) return result.with({ dev })
    const stamped = new Map<unknown, unknown>()
    for (const [key, row] of result as Map<unknown, unknown>) {
      stamped.set(key, row instanceof FileStat ? row.with({ dev }) : row)
    }
    return stamped
  }

  /**
   * A subtree read with the links the namespace holds below `path` on the
   * same mount, each as the link it is. No backend stores a link, so a walk
   * that reads the subtree in one call meets them only here, as a listing
   * meets them in `readdir`; a link that leads where the session cannot see
   * is left out, as a listing leaves it out. Mirrors Python's
   * Dispatcher._with_links.
   */
  /** A subtree read with the attributes the overlay holds for each entry, the
   * ones a stat of that entry carries. */
  private overlaid(path: PathSpec, tree: Map<string, FileStat>): Map<string, FileStat> {
    const base = rstripSlash(path.virtual)
    const merged = new Map<string, FileStat>()
    for (const [rel, row] of tree) {
      merged.set(rel, mergeOverlayStat(this.namespace.metaFor(`${base}/${rel}`), row))
    }
    return merged
  }

  private withLinks(
    path: PathSpec,
    tree: Map<string, FileStat>,
    vis: Visibility | null,
  ): Map<string, FileStat> {
    const base = rstripSlash(path.virtual)
    const owner = this.namespace.tryMountFor(path.virtual)
    const links = this.namespace.symlinkTargets()
    const merged = new Map(tree)
    for (const [virtual, row] of this.namespace.linkStatsBelow(path.virtual)) {
      if (this.namespace.tryMountFor(virtual) !== owner || leadsHidden(vis, virtual, links))
        continue
      const rel = virtual.slice(base.length + 1)
      if (!merged.has(rel)) merged.set(rel, row)
    }
    return merged
  }

  /**
   * Run one write with its names held, one writer at a time per name.
   *
   * The caller's timeout covers its wait for the hold and the store's
   * call, not `after` (the bookkeeping), which it then waits for. A writer
   * that gives up while queued lets go of any name it already holds and
   * never runs. One that gives up after its call started keeps the hold
   * until the store's own call settles, since a timeout cannot stop the
   * call and a timed-out pwrite still writes back what it read; the
   * mount's activity ends at the timeout as for any op, so an unmount
   * does not wait on it. `after` runs only for a caller still waiting: a
   * call that lands after its timeout runs `landed` instead, which drops what
   * the landing made stale where its names still belong to the mount that
   * ran it (a read between the timeout and the landing may have cached the
   * old bytes); a failure nobody waits for any more is reported.
   *
   * Args:
   *   keys: the names to hold, in the one order every writer takes them.
   *   timeout: the op's timeout in seconds, or null for none.
   *   name: the function, for the timeout's error.
   *   label: the op and path, for a late failure's report.
   *   call: runs the op, handing over the store's own call once it starts.
   *   after: the bookkeeping, run while the caller still waits.
   *   landed: run once a call that outlived its timeout settles.
   */
  private async holdWrite(
    keys: readonly string[],
    timeout: number | null,
    name: string,
    label: string,
    call: (
      onCall: (storeCall: Promise<unknown>) => void,
      holds: readonly KeyHold[],
    ) => Promise<unknown>,
    after: (value: unknown) => Promise<void>,
    landed: () => Promise<void>,
  ): Promise<unknown> {
    const turn = { entered: false, abandoned: false, late: false, started: false, settled: false }
    let giveUp = (): void => undefined
    const gaveUp = new Promise<void>((resolve) => {
      giveUp = resolve
    })
    let answer: Promise<unknown> = Promise.resolve()
    let finished: Promise<void> = Promise.resolve()
    const entered = new Promise<void>((enter) => {
      const held = async (holds: readonly KeyHold[]): Promise<void> => {
        if (turn.abandoned) return
        turn.entered = true
        const started: { call?: Promise<unknown> } = {}
        answer = call((storeCall) => {
          started.call = storeCall
          turn.started = true
          storeCall.then(
            () => {
              turn.settled = true
            },
            () => {
              turn.settled = true
            },
          )
        }, holds)
        // The store's own call once it started, else the run's answer: a
        // timeout answers the caller, not the store.
        const stored = answer.then(
          () => started.call ?? answer,
          () => started.call ?? answer,
        )
        finished = stored.then(
          async (value) => {
            if (turn.late) await landed()
            else await after(value)
          },
          async (err: unknown) => {
            if (turn.late) await landed()
            throw err
          },
        )
        enter()
        await finished.catch((err: unknown) => {
          if (turn.late) console.warn(`${label} failed after its timeout: ${String(err)}`)
        })
      }
      void keys.reduceRight<(holds: readonly KeyHold[]) => Promise<void>>(
        (inner, key) => (holds) =>
          this.state.writers.withLock(key, (hold) =>
            Promise.race([inner([...holds, hold]), gaveUp]),
          ),
        held,
      )([])
    })
    let value: unknown
    try {
      value = await runWithTimeout(
        entered.then(() => answer),
        timeout,
        name,
      )
    } catch (err) {
      if (turn.started && !turn.settled) turn.late = true
      if (!turn.entered) {
        turn.abandoned = true
        giveUp()
      }
      throw err
    }
    await finished
    return value
  }

  /**
   * What a write changes beside the store: the caches above the path, and
   * the node table's links and attributes at its names. Mirrors Python's
   * Dispatcher._settle_write.
   */
  /**
   * What a write changes beside the store: the caches above the path, and the
   * node table's links and attributes at its names. A copy reads its path, so
   * only its destination changes. A create that answers its new entry's stat
   * (`created`) has it kept where its parent's listing names it, in place of
   * dropping that listing for a re-list: the create is the one change to it,
   * and the next level of a nested create finds its parent there. Mirrors
   * Python's Dispatcher._settle_write.
   */
  private async settleWrite(
    name: string,
    p: PathSpec,
    dst: PathSpec | null,
    args: readonly unknown[],
    others: readonly [number | string, PathSpec][],
    created: unknown = null,
  ): Promise<void> {
    const opened = appendsNothing(name, args)
    const observed = STAMP_WRITE_OPS.has(name) && !opened ? Date.now() / 1000 : null
    const removes = name === 'unlink' || name === 'rmdir' || name === 'rm_r'
    const row = created instanceof FileStat ? created : null
    // A copy reads its path, so only its destination changes: the copy is a
    // new file there, or a new tree.
    if (COPY_OPS.has(name) && dst !== null) {
      await this.changed(dst.virtual, FileChangeKind.CREATE, row)
      if (name === 'dir_copy') await this.settleTreeCopy(p, dst)
      return
    }
    // rename(2) moves a file without touching its times, which the node
    // table carries to the new name below. rm_r takes everything below with
    // it: the cached bodies and listings, and the links and overlays only the
    // node table holds there.
    await this.changed(
      p.virtual,
      name === 'rm_r'
        ? FileChangeKind.UNKNOWN
        : removes
          ? FileChangeKind.DELETE
          : FileChangeKind.CREATE,
      name === 'rename' ? null : row,
      { observed, times: !opened && name !== 'rename' },
    )
    for (const [, other] of others) await this.changed(other.virtual, FileChangeKind.UPDATE)
    if (name === 'rm_r') await this.namespace.purgeUnder(p.virtual)
    if (removes) {
      // The name no longer holds that file, so what was set on it
      // (overlay mode and owner, extended attributes) goes with it, as
      // the shell's rm already drops it: a file created there next
      // starts bare on every surface.
      await this.namespace.dropOverlay(p.virtual)
      if (name === 'rmdir') {
        // The link check ran before the backend was asked, so a visible
        // link below now was created since: it is younger than this
        // rmdir, lands after it in the serial order (a link synthesizes
        // its parents), and the purge taking the directory's hidden nodes
        // must not take it too.
        const arrived = new Set<string>()
        const vis = sessionVisibility(this.access)
        const links = this.namespace.symlinkTargets()
        for (const [link] of this.namespace.linkStatsBelow(p.virtual)) {
          if (pathVisible(vis, link) && !leadsHidden(vis, link, links)) arrived.add(link)
        }
        await this.namespace.purgeUnder(p.virtual, arrived)
      }
    }
    if (name === 'rename' && dst !== null) {
      // A rename re-anchors the whole subtree under its source, so what was
      // cached one level down under either name is stale, not just the two
      // paths and their parents: left there, a moved directory's old name
      // answered `stat` and `ls` from its cached children.
      for (const moved of [p, dst]) {
        await this.changed(moved.virtual, FileChangeKind.UNKNOWN, null, { times: false })
      }
      if (row !== null) {
        await this.changed(dst.virtual, FileChangeKind.CREATE, row, { times: false })
      }
      // rename(2) replaces the destination, so a node the table holds
      // at that name does not survive the move. A link left there
      // shadowed the file that had just landed: the listing showed the
      // new file, every read followed the old link, and the moved
      // content was reachable under no name at all.
      await this.namespace.unlink(dst.virtual)
      // The subtree moves with it, and only the node table can move the
      // part of it no backend holds: a link or an attr overlay below the
      // source is addressed by absolute path, so it would otherwise stay
      // behind at a name the rename has emptied. The destination's own
      // subtree is replaced first, as rename(2) replaces what it lands on.
      await this.namespace.purgeUnder(dst.virtual)
      // The node at the source itself is not part of the subtree below it,
      // so re-anchoring that subtree leaves it behind: the mode or ownership
      // a chmod recorded stayed at the emptied name, never reached the
      // landing, and was inherited by whatever was created at the old name
      // next. Shell mv compensates for this in its own prepare step; a verb
      // reaching the dispatcher directly, as git mv does, had nothing to.
      await this.namespace.rename(p.virtual, dst.virtual)
      await this.namespace.renameUnder(p.virtual, dst.virtual)
    }
  }

  /**
   * The mount serving each of a write's names as it starts, keyed by the
   * name, for the cleanup after a call that lands past its timeout.
   */
  private owners(paths: readonly PathSpec[]): ReadonlyMap<string, MountEntry | null> {
    return new Map(
      paths.map((path) => [
        path.virtual,
        this.namespace.tryMountFor(rstripSlash(path.virtual) || '/'),
      ]),
    )
  }

  /**
   * Drop what a write that threw may have made stale.
   *
   * A write that fails partway may already have changed the store (a
   * paginated delete, a copy that merged some children), so the caches at
   * and below every name it reaches go either way; the node table moves only
   * with a write that landed. The version the line held for each name is
   * kept, so the next write there stays conditioned on what the agent read,
   * and so is each version `lost` marks under them, which a refused
   * conditional write kept: a retry without a read is refused again.
   * Over-dropping costs a refetch. An eviction error is logged, not thrown,
   * so the caller still learns why the write failed. `owners`, for a call
   * that landed after its timeout, holds the mount each name was on when the
   * call started: a name another mount has taken since is that mount's now,
   * so nothing at or under it is touched. Mirrors Python's
   * Dispatcher._evict_failed_write, whose timed-out call is cancelled and
   * never lands late.
   */
  private async evictFailedWrite(
    name: string,
    p: PathSpec,
    dst: PathSpec | null,
    others: readonly [number | string, PathSpec][],
    lost: LostPaths | null,
    owners: ReadonlyMap<string, MountEntry | null> | null = null,
  ): Promise<void> {
    const names = [
      ...(COPY_OPS.has(name) ? [] : [p]),
      ...(dst !== null && DESTINATION_OPS.has(name) ? [dst] : []),
      ...others.map(([, other]) => other),
    ]
    const taken = (target: PathSpec, mount: MountEntry): boolean =>
      owners !== null && owners.get(target.virtual) !== mount
    for (const target of names) {
      try {
        const path = rstripSlash(target.virtual) || '/'
        const mount = this.namespace.tryMountFor(path)
        if (mount === null || taken(target, mount)) continue
        const kept: [CacheManager, PathSpec, string | null][] = []
        for (const [owner, alias] of this.aliases(mount, path)) {
          if (owner.cacheManager === null) continue
          const spec = PathSpec.fromStrPath(alias)
          kept.push([owner.cacheManager, spec, await owner.cacheManager.readVersion(spec)])
        }
        await this.changed(path, FileChangeKind.UNKNOWN, null, { times: false })
        for (const [manager, spec, version] of kept) {
          if (version !== null && version !== '') await manager.keepVersion(spec, version)
        }
      } catch (err) {
        console.debug(`evicting after a failed ${name}: ${String(err)}`)
      }
    }
    if (lost === null) return
    for (const key of [...lost.marks.keys()]) {
      const version = lost.version(key)
      const target = names.find((written) => underPath(key, written.virtual))
      if (version === null || target === undefined) continue
      try {
        const mount = this.namespace.tryMountFor(key)
        if (mount === null || taken(target, mount)) continue
        for (const [owner, alias] of this.aliases(mount, key)) {
          await owner.cacheManager?.keepVersion(PathSpec.fromStrPath(alias), version)
        }
      } catch (err) {
        console.debug(`keeping ${key} after a refusal: ${String(err)}`)
      }
    }
  }

  /**
   * What a tree copy changed under `dst`: each entry it wrote. The copy
   * merges into what `dst` already held, so a file it left keeps its cached
   * copy and the version a conditional write needs; the files and
   * directories it wrote are the source's, listed after the copy, so an
   * empty directory it made drops its folder's listing too. Mirrors Python's
   * Dispatcher._settle_tree_copy.
   */
  private async settleTreeCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    const mount = this.namespace.tryMountFor(src.virtual)
    if (mount === null) return
    const base = rstripSlash(src.virtual)
    const landing = rstripSlash(dst.virtual)
    for (const virtual of await this.entriesBelow(mount, src.virtual)) {
      await this.changed(landing + virtual.slice(base.length), FileChangeKind.CREATE)
    }
  }

  /**
   * Every file and directory at any depth under `root`, through the mount's
   * own listing.
   */
  private async entriesBelow(mount: MountEntry, root: string): Promise<string[]> {
    const found: string[] = []
    const pending = [root]
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const entries = (await mount.call('readdir', directory)) as string[]
      for (const entry of entries) {
        const child = rstripSlash(entry)
        found.push(child)
        const row = (await mount.call('stat', child)) as FileStat
        if (row.type === FileType.DIRECTORY) pending.push(child)
      }
    }
    return found
  }

  /** A number naming one store object, the same for every mount of it. */
  private storeId(vfs: BaseVFS): number {
    const known = this.state.stores.get(vfs)
    if (known !== undefined) return known
    this.state.storeCount += 1
    this.state.stores.set(vfs, this.state.storeCount)
    return this.state.storeCount
  }

  /**
   * Whether the node table answers this op instead of a backend.
   *
   * `symlink` and `readlink` always, because a link exists nowhere else.
   * The rest only when the path itself is a link, and then for the same
   * reason the create and the read are the dispatcher's: forwarding reaches a
   * backend that has never heard of the name. A no-follow stat is the
   * read half of that fact (lstat asks for the link's own row, which
   * only the table holds); a following stat never arrives here, since
   * the follow below rewrote it to the target. Mirrors Python's
   * Dispatcher._table_answers.
   */
  /**
   * The index kwargs normal dispatch stamps on every registered op, for
   * the dispatcher's own raw registry calls: an indexed backend cannot
   * resolve a nested path without it.
   */
  private indexKwargs(mount: MountEntry | null): OpKwargs {
    const index = mount?.index
    return index !== undefined ? { index } : {}
  }

  /** The policy boundary for an op on a path `mount` owns: the mount's
   * prefix and mode, or for a path above every mount an empty prefix and
   * full write, governed by `/` (`MountModePolicy`). Mirrors Python's
   * Dispatcher._boundary. */
  private boundary(mount: MountEntry | null): Boundary {
    return new Boundary(
      this.policies,
      mount?.prefix ?? '',
      mount?.mode ?? MountMode.WRITE,
      this.sessionId(),
      this.decisions,
      this.access,
      this.caller ?? undefined,
    )
  }

  /**
   * The dispatcher's own channel for internal walks: the TS twin of Python's
   * Mount.call plus the dispatcher-side duties around it. The
   * same mode fence, index stamping and mount-prefix context normal
   * dispatch applies, plus the boundary's admission and completion for
   * writes (Python's `_MountChannel` holds the same `Boundary`) and the
   * dispatcher's own write invalidation, because a raw mount call
   * runs outside the cache context dispatch establishes, so the cores'
   * invalidation cannot land. Invalidation runs even when the op
   * fails: a missing-path failure means the tree changed under the
   * walk, and the walk's own earlier listing is exactly the entry that
   * must not survive. Only the visibility filter stays off, which is
   * what lets a remnant walk see hidden entries. Every internal
   * backend call in this class routes through here; a bare
   * `callKeyed` outside dispatch is a bug.
   */
  private async fencedCall(
    vfs: BaseVFS,
    mountPrefix: string,
    mode: MountMode,
    name: string,
    spec: PathSpec,
    issuer?: symbol,
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const mount = this.namespace.mountFor(spec.virtual)
    const mark = declared(vfs.constructor, name) ?? CALLS.get(name) ?? null
    const write = mark !== null && WRITE_EFFECTS.includes(mark.effect)
    const boundary = new Boundary(
      this.policies,
      mountPrefix,
      mode,
      this.sessionId(),
      this.decisions,
      this.access,
      this.caller ?? undefined,
    )
    if (mark !== null && write) {
      // The same pre-vfs admission a dispatched op answers, with the
      // walk's own child path: the gate that admitted the rmdir judged
      // the directory, not what the cascade found under it, and a
      // policy that protects one of those paths must refuse its
      // deletion exactly as it would refuse a first-class op. The
      // caller folds the denial into its original refusal, so a
      // policy's protection of a hidden path never surfaces as its own
      // denial.
      await boundary.admit(mark, spec, true, { checkHidden: false }, issuer)
    }
    // The fence reruns backend ops outside `dispatch`, so the revision
    // pins have to ride here as on the main path above, or a cascade
    // read answers from the wrong version of a revision-pinned mount.
    // Python's twin gets both bindings from `Mount.call`.
    await mount.ensureReady()
    try {
      const result = await mount.use(async () => {
        const answer = await runWithMountContext(
          () =>
            mount.runWithWriteRevisions(() =>
              mount.callKeyed(
                name,
                spec,
                [],
                {
                  ...this.indexKwargs(mount),
                  ...kwargs,
                },
                this.access,
              ),
            ),
          mount.mountId,
        )
        return wrapStream(answer, mount.mountId, mount.activity)
      })
      // A deletion is not completed through postVfs, which could only
      // refuse after the entry is gone and strand the cascade.
      return result
    } finally {
      if (write) {
        await this.changed(
          spec.virtual,
          name === 'unlink' || name === 'rmdir' ? FileChangeKind.DELETE : FileChangeKind.UPDATE,
        )
      }
    }
  }

  /**
   * Whether a rename's source stats as a directory.
   *
   * Only a directory can carry hidden content into view, so the reveal
   * refusal probes the source before it fires and lets a file rename
   * pass. An absent source moves nothing (the rename itself reports
   * it); a source the mount cannot classify fails toward refusal, the
   * same stance the pattern arm takes. Mirrors Python's
   * Dispatcher._moved_source_is_dir.
   */
  private async movedSourceIsDir(path: PathSpec, issuer?: symbol): Promise<boolean> {
    let resolved: [BaseVFS, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(path.virtual, false)
    } catch {
      // No mount to ask; classification fails toward refusal.
      return true
    }
    const [vfs, scope, mode] = resolved
    let row: unknown
    try {
      row = await this.fencedCall(
        vfs,
        this.namespace.mountFor(path.virtual).prefix,
        mode,
        'stat',
        scope,
        issuer,
      )
    } catch (err) {
      // An absent source moves nothing; the rename itself reports it.
      if (isMissingPath(err) || isEnotdir(err)) return false
      // Unanswerable classification fails toward refusal.
      return true
    }
    return !(row instanceof FileStat) || row.type === FileType.DIRECTORY
  }

  /**
   * Take a visibly-empty directory's hidden remnants with it.
   *
   * The backend refused the rmdir because entries remain, but when the
   * session's view of the directory is empty the refusal would leak
   * that something invisible exists. A session's mutation may destroy
   * what it cannot see, never learn of it, so the remnants go with the
   * directory through the shared removeRemnants walk; a visible child,
   * or any cascade failure (a mode-protected entry, a visible entry
   * appearing mid-walk), re-raises the backend's refusal. Emptiness is
   * the dispatcher's own readdir pipeline: backend entries merged with the
   * namespace's children (nested mounts, links) and judged by
   * visibility, so a visible child no backend can see keeps the
   * refusal instead of reporting a successful rmdir while the mounted
   * child remains. The namespace's own hidden nodes under the subtree
   * (links, attr overlays) are purged with it, so the removed tree
   * cannot resurface from the node table once the hide lifts.
   */
  private async rmdirRemnants(
    vfs: BaseVFS,
    path: PathSpec,
    mountPrefix: string,
    mode: MountMode,
    refusal: unknown,
    ruleGate: EntryGate | null,
    issuer?: symbol,
  ): Promise<void> {
    const vis = sessionVisibility(this.access)
    if (!hiddenUnder(vis, path.virtual)) throw refusal
    let entries: unknown
    try {
      entries = await this.fencedCall(vfs, mountPrefix, mode, 'readdir', path, issuer)
    } catch {
      // A backend that cannot list (or later, remove) the remnants
      // keeps the original refusal: the dispatcher has no way to take them.
      throw refusal
    }
    if (!Array.isArray(entries)) throw refusal
    const names = entries.map(String)
    const merged = mergeReaddir(
      vis,
      names,
      this.namespace.mountPrefixes(),
      this.namespace,
      path.virtual,
    )
    const visible = (virtual: string): boolean => pathVisible(vis, virtual)
    if (names.length === 0 || visibleBelow(path.virtual, merged, visible)) throw refusal
    const channel: RemnantChannel = {
      readdir: async (at) => {
        const listed = await this.fencedCall(vfs, mountPrefix, mode, 'readdir', at, issuer)
        return Array.isArray(listed) ? listed.map(String) : []
      },
      stat: (at) => this.fencedCall(vfs, mountPrefix, mode, 'stat', at, issuer),
      // The command's path rules judge each deletion too: the gate that
      // admitted the rmdir judged the directory, not what is under it.
      unlink: async (at) => {
        ruleGate?.check(at.virtual)
        await this.fencedCall(vfs, mountPrefix, mode, 'unlink', at, issuer)
      },
      rmdir: async (at) => {
        ruleGate?.check(at.virtual)
        await this.fencedCall(vfs, mountPrefix, mode, 'rmdir', at, issuer)
      },
    }
    try {
      await removeRemnants(channel, visible, path)
    } catch {
      throw refusal
    }
    // The namespace's own nodes under the subtree go with it: a hidden
    // link is invisible to every backend, so the walk above cannot
    // take it, and left in the table it would resurface the removed
    // tree the moment the hide lifts (a link synthesizes its
    // ancestors). Classification proved every link below is hidden --
    // a visible one contributes its child segment to the merged
    // listing above -- so this is the walk's own revalidate-then-
    // destroy applied to the name plane: a link that became visible
    // mid-cascade keeps the refusal like any visible remnant, and the
    // purge also drops the attr overlays of paths the cascade just
    // destroyed, as `rm` does.
    const base = rstripSlash(path.virtual) + '/'
    const links = this.namespace.symlinkTargets()
    for (const link of links.keys()) {
      if (link.startsWith(base) && pathVisible(vis, link) && !leadsHidden(vis, link, links)) {
        throw refusal
      }
    }
    await this.namespace.purgeUnder(path.virtual)
  }

  /**
   * `path` with the links above its final name followed.
   *
   * The walked path answers to the session's hides as the typed one did,
   * the rule the follow of the final name applies too: a visible link must
   * not lead into hidden space. Throws `eloop` when a link above the name
   * loops (ELOOP), as the coded error every caller's per-operand catch
   * words. Mirrors Python's Dispatcher._walked.
   */
  private walked(path: PathSpec, create: boolean): PathSpec {
    const spelled = walkSpelling(path, (p) => this.namespace.follow(p))
    let walked = followOrLoop(this.namespace, path, false, spelled)
    if (spelled !== path.virtual) walked = posixNormpath(walked)
    if (walked === path.virtual) return path
    const vis = sessionVisibility(this.access)
    if (!pathVisible(vis, walked)) throw hiddenRefusal(vis, walked, create)
    return PathSpec.fromStrPath(walked)
  }

  private tableAnswers(
    name: string,
    virtual: string,
    kwargs: Record<string, unknown> | undefined,
  ): boolean {
    if (NAMESPACE_TABLE_OPS.has(name)) return true
    if (!LINK_ENTRY_OPS.has(name)) return false
    if (name === 'stat' && kwargs?.nofollow !== true) return false
    return this.namespace.isLink(virtual)
  }

  /**
   * Answer a node-table op at the dispatcher itself, gated like a backend.
   *
   * A symlink is namespace state with no backend behind it, so the dispatcher
   * owns every verb that names one. Admission still fires exactly as for
   * a backend write: the link's turf is the longest mount prefix above it
   * (the same ownership rule the link read filter uses), session grants
   * and both gates run, and the write leaves an OpRecord — a scoped
   * kernel mount refuses exactly like a scoped shell. The turf's mode
   * gates the write too (`MountModePolicy` at the `Boundary`), so a
   * read-only mount or grant answers EROFS for a link exactly as for a
   * file; a link above every mount is bare namespace structure, gated
   * with an empty prefix and governed by `/`. A rename's
   * destination is judged on its own turf, since the endpoints need not
   * share one. Also answers the `unlink`, `rename` and no-follow
   * `stat` of a path the node table holds a link for. Mirrors Python's
   * Dispatcher._namespace_table_op.
   */
  private async tableCall(
    name: string,
    path: PathSpec,
    args: readonly unknown[],
    kwargs: OpKwargs,
    report: OpReport | undefined,
    issuer?: symbol,
  ): Promise<string | FileStat | null> {
    const timer = startOp()
    const mount = this.namespace.tryMountFor(path.virtual)
    const boundary = this.boundary(mount)
    const write = POLICY_WRITE_OPS.has(name)
    const mark = CALLS.get(name)
    if (mark === undefined) throw enotsup('namespace', name, path)
    await boundary.admit(mark, path, write, { final: name !== 'rename' }, issuer)
    let target: string
    let result: string | FileStat | null = null
    if (name === 'unlink') {
      target = this.namespace.readlink(path.virtual) ?? ''
      await this.namespace.unlink(path.virtual)
    } else if (name === 'rename') {
      target = this.namespace.readlink(path.virtual) ?? ''
      const dst = args[0]
      if (!(dst instanceof PathSpec)) throw new Error('rename op requires dst')
      // The destination is a create there, gated like the source and on
      // its own turf, the way the backend path gates both ends of a
      // rename. It is then replaced as rename(2) replaces it: any node
      // the table holds at that name (a link, an attr overlay) goes.
      const dstMount = this.namespace.tryMountFor(dst.virtual)
      await this.boundary(dstMount).admit({ ...mark, creates: true }, dst, true, {}, issuer)
      // The name the link moves to must have a directory above it, as for
      // a new link: the table alone would file it under an absent parent
      // and synthesize the directories above it.
      const refusal = await this.parentRefusal(dst, issuer)
      if (refusal !== null) throw refusal
      if (!this.namespace.isLink(dst.virtual)) {
        const kind = await this.entryType(dst.virtual, issuer)
        if (kind === FileType.DIRECTORY) throw eisdir(dst)
        if (kind !== null)
          await this.dispatch('unlink', dst, [], issuer === undefined ? {} : { issuer })
      }
      await this.namespace.unlink(dst.virtual)
      await this.namespace.rename(path.virtual, dst.virtual)
    } else if (name === 'symlink') {
      target = String(kwargs.target)
      // symlink(2) refuses an occupied name and a name its parent cannot
      // hold, and the dispatcher is the only place that can tell: the node table
      // sees a link, and a probe sees what a backend holds. Left unchecked,
      // the new node shadowed live data (the bytes stayed, the name read as
      // a link), could bury a mount root, which is the one name a
      // deployment configured, and under an absent parent was an orphan
      // that invented the directories above it.
      const refusal = await this.symlinkRefusal(path, issuer)
      if (refusal !== null) throw refusal
      await this.namespace.symlink(path.virtual, target, Date.now() / 1000)
    } else if (name === 'stat') {
      const row = this.namespace.linkStatAt(path.virtual)
      if (row === null) throw enoent(path)
      target = this.namespace.readlink(path.virtual) ?? ''
      result = row
    } else {
      const found = this.namespace.readlink(path.virtual)
      if (found === null) throw await this.readlinkMiss(path, issuer)
      target = found
      result = found
    }
    record(name, path.virtual, VFSName.RAM, encodeText(target).byteLength, timer)
    memoryAnswered(report)
    return (await boundary.complete(mark, path, write, result, issuer)) as string | FileStat | null
  }

  /**
   * The error a readlink of something that is not a link answers.
   *
   * readlink(2) splits the two misses and callers read them differently:
   * a path that is there but is not a link is EINVAL, and one that is
   * not there at all is ENOENT, which is the code a guest's
   * `except FileNotFoundError` catches. The node table only knows the
   * first half, so absence is probed here and only here, on the failure
   * path, where one extra round trip buys the right errno. Mirrors
   * Python's Dispatcher._readlink_miss.
   */
  private async readlinkMiss(path: PathSpec, issuer?: symbol): Promise<FsError> {
    const [present] = await this.occupancy(path, issuer)
    return present ? einval(path) : enoent(path)
  }

  /**
   * Whether anything at all is at `path`, and the parent's listing.
   *
   * Four channels, asked in the order of what they prove. The namespace
   * goes first: a link, and a directory that exists only because a
   * mount or a link sits below it, are structure no backend can see,
   * and a mount root is the deployment's own configuration. Then the
   * backend's row, which settles a file. A directory row settles
   * nothing, because an API tree synthesizes its directories: a
   * postgres schema lists `tables/` and `views/` before anything has
   * asked whether that schema is there, and a grouping mount stats
   * every path under a live collection as a directory. So a directory
   * is proven the way the hierarchy kit itself proves one, by appearing
   * in its parent's listing, which is also the only way a prefix store
   * can answer for a directory that is nothing but a set of keys.
   * Cannot reuse `resolvePathStat`: that dispatches, and the dispatcher is
   * what dispatch is inside of.
   *
   * The parent's listing comes back beside the answer, null when no probe
   * reached it or it gave none, because a listing with entries in it also
   * proves the parent a directory: a create in a directory that holds
   * anything costs no round trip beyond this one. Mirrors Python's
   * Dispatcher._occupancy.
   */
  private async occupancy(
    path: PathSpec,
    issuer?: symbol,
  ): Promise<[boolean, readonly string[] | null]> {
    if (this.namespace.isLink(path.virtual)) return [true, null]
    const prefixes = this.namespace.mountPrefixes()
    if (
      namespaceStat(sessionVisibility(this.access), prefixes, this.namespace, path.virtual) !== null
    ) {
      return [true, null]
    }
    const mount = this.namespace.tryMountFor(path.virtual)
    // Only "no mount serves this path" is the absence being probed for.
    if (mount === null) return [false, null]
    const resolved = await this.namespace.resolve(path.virtual, false)
    if (normDir(mount.prefix) === normDir(path.virtual)) return [true, null]
    let listing: readonly string[] | null
    try {
      const row = (await this.probeRead('stat', resolved, issuer)) as FileStat | null
      if (row !== null && row.type !== FileType.DIRECTORY) return [true, null]
      listing = await this.parentListing(path.virtual, issuer)
    } catch (err) {
      if (!(err instanceof PolicyDenied) && !(err instanceof PolicyError)) throw err
      // A channel that refuses to answer is not evidence of absence.
      // Reporting "present" keeps the answer at the EINVAL every miss
      // gave before the split, which asserts nothing the policy is
      // withholding; reporting absence would assert a fact the dispatcher was
      // not allowed to check.
      return [true, null]
    }
    return [listing !== null && lists(listing, path.virtual), listing]
  }

  /**
   * What symlink(2) answers instead of making a link at `path`.
   *
   * Null when the link can be made. The name must be free (EEXIST) and
   * its parent a directory (`parentRefusal`), both read off the probes
   * `occupancy` makes: a parent whose listing answered with entries is a
   * directory, so only an empty or silent parent is walked, which is the
   * failure path nearly always. Mirrors Python's
   * Dispatcher._symlink_refusal.
   */
  private async symlinkRefusal(path: PathSpec, issuer?: symbol): Promise<FsError | null> {
    const [present, listing] = await this.occupancy(path, issuer)
    if (present) return eexist(path)
    if (listing !== null && listing.length > 0) return null
    return this.parentRefusal(path, issuer)
  }

  /**
   * The errno the parent chain of a name being created answers.
   *
   * symlink(2) and rename(2) resolve the directory a name goes in before
   * they look at the name: ENOENT when it is absent and ENOTDIR when a
   * non-directory stands anywhere in the chain. The chain is walked
   * upward until something is there, as `destKind` walks a copy's
   * destination, because a store answers a path under a plain file with
   * the same miss as an absent one: the parent itself being a directory
   * is the one clean answer, a directory higher up means the components
   * below it are absent, and anything else is ENOTDIR. Null when the
   * parent is a directory, and when a policy closes a channel, which
   * proves nothing either way. Mirrors Python's
   * Dispatcher._parent_refusal.
   */
  private async parentRefusal(path: PathSpec, issuer?: symbol): Promise<FsError | null> {
    const immediate = parent(norm(path.virtual))
    let node = immediate
    let kind: FileType | null
    try {
      kind = await this.entryType(node, issuer)
      while (kind === null) {
        node = parent(node)
        kind = await this.entryType(node, issuer)
      }
    } catch (err) {
      if (err instanceof PolicyDenied || err instanceof PolicyError) return null
      if (!isEnotdir(err)) throw err
      // A store that sees the file in the chain answers the probe itself
      // with ENOTDIR, which is the verdict.
      kind = FileType.FILE
    }
    if (kind !== FileType.DIRECTORY) return enotdir(path)
    return node === immediate ? null : enoent(path)
  }

  /**
   * The type of what stands at `virtual`, null when nothing does.
   *
   * The channels `occupancy` asks, for a path the walk above a new name
   * reaches: namespace structure and a mount root are directories, then
   * the backend's row, then the path's own entry in its parent's
   * listing, which is how a prefix store holds a directory that is
   * nothing but a set of keys. Mirrors Python's Dispatcher._entry_type.
   */
  private async entryType(virtual: string, issuer?: symbol): Promise<FileType | null> {
    if (virtual === '/') return FileType.DIRECTORY
    const prefixes = this.namespace.mountPrefixes()
    if (namespaceStat(sessionVisibility(this.access), prefixes, this.namespace, virtual) !== null) {
      return FileType.DIRECTORY
    }
    const mount = this.namespace.tryMountFor(virtual)
    if (mount === null) return null
    if (normDir(mount.prefix) === normDir(virtual)) return FileType.DIRECTORY
    const resolved = await this.namespace.resolve(virtual, false)
    const row = (await this.probeRead('stat', resolved, issuer)) as FileStat | null
    if (row !== null) return row.type
    const listing = await this.parentListing(virtual, issuer)
    return listing !== null && lists(listing, virtual) ? FileType.DIRECTORY : null
  }

  /**
   * The backend listing of the directory `virtual` sits in: null when no
   * mount serves that directory, its backend lists nothing there, or the
   * path has no name to sit in one. Mirrors Python's
   * Dispatcher._parent_listing.
   */
  private async parentListing(virtual: string, issuer?: symbol): Promise<readonly string[] | null> {
    const trimmed = rstripSlash(virtual)
    const cut = trimmed.lastIndexOf('/')
    const name = trimmed.slice(cut + 1)
    if (cut < 0 || name === '') return null
    const above = trimmed.slice(0, cut) || '/'
    if (this.namespace.tryMountFor(above) === null) return null
    const resolved = await this.namespace.resolve(above, false)
    const entries = await this.probeRead('readdir', resolved, issuer)
    return Array.isArray(entries) ? entries.map(String) : null
  }

  /**
   * Run one read op for a probe, or null when it found nothing.
   *
   * The probe reads on the caller's behalf but not at its request, so it
   * passes the same admission gate the op would at the dispatcher: a policy
   * that denies `stat` must not be reachable through a readlink. That
   * refusal is raised, not swallowed, because only the caller knows what
   * to answer when a channel goes dark.
   *
   * The index and the path's filetype are the two kwargs that decide
   * which registered op answers, so a probe that omitted them would ask
   * a different question than the dispatcher does and report a rendered path
   * as absent. Python needs no twin of that half: its dispatcher routes
   * through `Mount.call`, which stamps both itself.
   *
   * Args:
   *   name: the function to run, `stat` or `readdir`.
   *   resolved: what the namespace resolved the path to.
   *   issuer: the mark on the op being served, carried to the probe's
   *     gate so the probe is judged as its caller's.
   */
  private async probeRead(
    name: string,
    resolved: [BaseVFS, PathSpec, MountMode],
    issuer?: symbol,
  ): Promise<unknown> {
    const [vfs, scope] = resolved
    const mount = this.namespace.tryMountFor(scope.virtual)
    if (mount === null) return null
    const mark = declared(vfs.constructor, name) ?? CALLS.get(name) ?? null
    if (mark === null) throw enotsup(vfs.name, name, scope)
    const boundary = this.boundary(mount)
    await boundary.admit(mark, scope, false, {}, issuer)
    await mount.ensureReady()
    const filetype = getExtension(scope.virtual)
    try {
      const result = await mount.use(() =>
        mount.callKeyed(name, scope, [], {
          ...this.indexKwargs(mount),
          ...(filetype !== null ? { filetype } : {}),
        }),
      )
      return await boundary.complete(mark, scope, false, result, issuer)
    } catch (err) {
      // Final on every channel: a plain file above the path means nothing
      // can be at it or under it, and symlink(2) and readlink(2) answer
      // with this errno.
      if (isEnotdir(err)) throw err
      // The "nothing here" set exactly, plus a backend with no such op:
      // a miss on one channel is not absence on its own, so the caller
      // tries the other.
      if (isMissError(err) || isMissingOp(err, name)) return null
      throw err
    }
  }

  /**
   * Answer an extended-attribute op from the node table.
   *
   * The attributes a caller sets live on the path's node, so they
   * survive on a backend that has no such slot and move with a rename;
   * the backend's own facts are read off its stat on every call and
   * refused to writers with EPERM, the answer for an attribute the
   * filesystem keeps for itself. The listing is sorted, so both hosts
   * and every backend agree on its order. Gated like a setattr: both
   * admission gates fire on the path's turf, and a write needs a
   * writable turf. Mirrors Python's Dispatcher._xattr_op.
   *
   * Args:
   *   name: `getxattr`, `listxattr`, `setxattr` or `removexattr`.
   *   path: the path, already followed unless the caller asked for its
   *     link node itself.
   *   kwargs: `name` for all but listxattr, `value` and the
   *     `create`/`replace` flags for setxattr.
   *   report: the caller's report.
   *   issuer: the mark on the op being served.
   */
  private async answerXattr(
    name: string,
    path: PathSpec,
    kwargs: OpKwargs,
    report: OpReport | undefined,
    issuer?: symbol,
  ): Promise<unknown> {
    const timer = startOp()
    const mount = this.namespace.tryMountFor(path.virtual)
    const boundary = this.boundary(mount)
    const write = POLICY_WRITE_OPS.has(name)
    const mark = CALLS.get(name)
    if (mark === undefined) throw enotsup('namespace', name, path)
    await boundary.admit(mark, path, write, {}, issuer)
    await this.xattrTarget(mount, path)
    const stored = this.namespace.xattrs(path.virtual)
    const attr = typeof kwargs.name === 'string' ? kwargs.name : ''
    let result: Uint8Array | string[] | null = null
    if (name === 'listxattr') {
      result = [...stored.keys()].sort(compareCodePoints)
    } else if (name === 'getxattr') {
      const found = stored.get(attr)
      if (found === undefined) throw noXattr(path.virtual)
      result = found
    } else if (name === 'setxattr') {
      if (kwargs.create === true && stored.has(attr)) throw eexist(path.virtual)
      if (kwargs.replace === true && !stored.has(attr)) throw noXattr(path.virtual)
      const value = kwargs.value instanceof Uint8Array ? kwargs.value : new Uint8Array()
      await this.namespace.setXattr(path.virtual, attr, value)
    } else {
      if (!stored.has(attr)) throw noXattr(path.virtual)
      await this.namespace.removeXattr(path.virtual, attr)
    }
    record(
      name,
      path.virtual,
      VFSName.RAM,
      result instanceof Uint8Array ? result.byteLength : 0,
      timer,
    )
    report?.served(null, null)
    return boundary.complete(mark, path, write, result, issuer)
  }

  /**
   * Answer statfs(2) for a path: the type name and the capacity of the
   * mount that holds it, which is what df reports for that mount. The path
   * must exist, as statfs's own walk requires. The namespace above every
   * mount has no file system behind it, so its type is `-` and its
   * capacity unknown. Mirrors Python's Dispatcher._statfs.
   *
   * Args:
   *   path: the path, already followed.
   *   issuer: the mark on the op being served.
   */
  private async statfs(path: PathSpec, issuer?: symbol): Promise<[string, CapacityResult]> {
    const mount = this.namespace.tryMountFor(path.virtual)
    const boundary = this.boundary(mount)
    const statfs: VfsCall = {
      name: 'statfs',
      effect: Effect.METADATA,
      target: Target.ANY,
      creates: false,
      subtree: false,
    }
    await boundary.admit(statfs, path, false, {}, issuer)
    await this.xattrTarget(mount, path)
    const answer: [string, CapacityResult] =
      mount === null
        ? ['-', { state: CapacityState.UNKNOWN }]
        : [mount.vfs.name, await mount.use(() => mount.vfs.capacity())]
    // A policy may deny the reply as it may any op's; a capacity is no bytes,
    // so a bound has nothing to cap.
    await boundary.complete(statfs, path, false, answer, issuer)
    return answer
  }

  /**
   * Settle that an attribute op's path exists, which it answers first. A
   * link node's own attributes and a directory that exists only in the
   * namespace have no backend behind them; anything else the backend's
   * stat must find, or the op is ENOENT. Mirrors Python's
   * Dispatcher._xattr_target.
   */
  private async xattrTarget(mount: MountEntry | null, path: PathSpec): Promise<void> {
    if (this.namespace.isLink(path.virtual)) return
    let stat: FileStat | null = null
    let missing: unknown = null
    if (mount !== null) {
      const [, scope] = await this.namespace.resolve(path.virtual, false)
      await mount.ensureReady()
      const filetype = getExtension(scope.virtual)
      try {
        const found = await mount.use(() =>
          mount.callKeyed('stat', scope, [], {
            ...this.indexKwargs(mount),
            ...(filetype !== null ? { filetype } : {}),
          }),
        )
        stat = found instanceof FileStat ? found : null
      } catch (err) {
        if (!isMissingPath(err) && !isEnotdir(err)) throw err
        missing = err
        await this.reconciler.onEnoent(mount, 'stat', path.virtual, err)
      }
    }
    if (stat !== null || this.namespaceResult('stat', path.virtual) instanceof FileStat) return
    if (isEnotdir(missing)) throw missing
    throw mount === null ? noMount(path.virtual) : enoent(path.virtual)
  }

  /**
   * Apply attributes natively where the backend can, overlay the rest.
   *
   * A VFS with a registered setattr op applies what it can and
   * returns the residual; residual fields go to the overlay and
   * natively applied ones are dropped from it, so a stale overlay never
   * shadows a fresh backend value. A VFS without the op, and a
   * link path (which has no backend inode), overlay everything. The
   * overlay half is the dispatcher's own write, so it runs inside the same
   * gates as the native half. Mirrors Python's Dispatcher._apply_setattr.
   */
  private async applySetattr(
    mount: MountEntry,
    scope: PathSpec,
    p: PathSpec,
    kwargs: OpKwargs,
  ): Promise<Record<string, number | string>> {
    if (this.namespace.isLink(p.virtual) || !mount.answers('setattr')) {
      // No backend inode answers for the path here, so nothing would
      // refuse a missing one: the overlay would stamp it.
      await this.xattrTarget(mount, p)
      return this.overlaySetattr(p, kwargs)
    }
    const raw = await mount.callKeyed('setattr', scope, [], kwargs, this.access)
    const residual = raw as Record<string, number | string>
    const applied = SETATTR_KEYS.filter(
      (key) => kwargs[key] !== undefined && kwargs[key] !== null && !(key in residual),
    )
    if (applied.length > 0) {
      await this.namespace.dropAttrs(p.virtual, applied)
      await this.changed(p.virtual, FileChangeKind.UPDATE, null, { times: false })
    } else {
      // A backend that applied nothing may not have looked for the path.
      await this.xattrTarget(mount, p)
    }
    if (Object.keys(residual).length > 0) await this.writeOverlay(p.virtual, residual)
    return residual
  }

  /** Store every requested field in the namespace overlay. */
  private async overlaySetattr(
    p: PathSpec,
    kwargs: OpKwargs,
  ): Promise<Record<string, number | string>> {
    const timer = startOp()
    const overlay: Record<string, number | string> = {}
    for (const key of SETATTR_KEYS) {
      const value = kwargs[key]
      if (value !== undefined && value !== null) overlay[key] = value as number | string
    }
    await this.writeOverlay(p.virtual, overlay)
    record('setattr', p.virtual, VFSName.RAM, 0, timer)
    return overlay
  }

  /** Write one overlay entry, converting an ISO mtime to epoch seconds. */
  private async writeOverlay(
    virtual: string,
    fields: Record<string, number | string>,
  ): Promise<void> {
    const { mtime, ...rest } = fields
    await this.namespace.setAttrs(virtual, {
      ...rest,
      ...(mtime !== undefined
        ? { mtime: typeof mtime === 'string' ? new Date(mtime).getTime() / 1000 : mtime }
        : {}),
    })
  }

  /**
   * Drop what a change to `rawPath` made stale above the store.
   *
   * The mount's caches take it under every mount of its store
   * (`CacheManager.invalidate`); a removal through the dispatcher knows
   * nothing was below the name, so its index is not asked. The overlay times
   * a content write moves go too, under each name: `observed` is the epoch
   * seconds of a content write to record, null for a removal, and `times`
   * false keeps them, for a change that moved no times. `row` is a CREATE's
   * new entry, kept in its parent's listing; null drops that entry. Mirrors
   * Python's Dispatcher._changed.
   */
  private async changed(
    rawPath: string,
    kind: FileChangeKind,
    row: FileStat | null = null,
    options: { observed?: number | null; times?: boolean } = {},
  ): Promise<void> {
    // Directory writes (mkdir/rmdir via tree copies) arrive with a trailing
    // slash; normalize so the parent computation does not invalidate the
    // written directory itself instead of its parent (Python normalizes the
    // same way via PathSpec.mount_path).
    const path = rstripSlash(rawPath) || '/'
    const mount = this.namespace.tryMountFor(path)
    if (mount === null) return
    if (options.times ?? true) {
      for (const [, name] of this.aliases(mount, path)) {
        await this.namespace.clearTimes(name, options.observed ?? null)
      }
    }
    await mount.cacheManager?.invalidate(path, kind, row, {
      leaf: kind === FileChangeKind.DELETE,
    })
  }

  /**
   * `path` under each mount of its store, its own mount first.
   *
   * One store mounted at two prefixes holds one file under two names, so what
   * a write makes stale under one name is stale under each. A name another
   * mount holds is that mount's file and is left out. Mirrors Python's
   * Dispatcher._aliases.
   */
  private aliases(mount: MountEntry, path: string): [MountEntry, string][] {
    const key = mountKey(path, rstripSlash(mount.prefix))
    const found: [MountEntry, string][] = [[mount, path]]
    for (const prefix of this.namespace.mountPrefixes()) {
      const other = this.namespace.mountFor(prefix)
      if (other === mount || other.vfs !== mount.vfs) continue
      const base = rstripSlash(other.prefix)
      const name = key === '' ? base || '/' : `${base}/${key}`
      if (this.namespace.tryMountFor(name) === other) found.push([other, name])
    }
    return found
  }

  /**
   * Bind the end of a line to the mounts it started with.
   *
   * The mount table is pinned at the line's start, so a version kept when it
   * ends is judged by the mount that produced it rather than whatever holds
   * the prefix by then. Mirrors Python's Dispatcher.capture_cache_facts.
   */
  captureCacheFacts(): (path: string) => CacheFacts {
    const mounts = new Map(
      this.namespace.mountPrefixes().map((p) => [p, this.namespace.mountFor(p)]),
    )
    return (path) => {
      const prefix = ownerPrefix(mounts.keys(), path)
      const original = prefix === null ? null : mounts.get(prefix)
      const mount = this.namespace.tryMountFor(path)
      return factsOf(original === mount ? mount : null)
    }
  }

  /**
   * Keep the version each path last had on a line that ended; a nested
   * line's keeps only the versions of paths still lost. Mirrors Python's
   * Dispatcher.keep_versions.
   */
  async keepVersions(
    records: readonly OpRecord[],
    cacheFacts: (path: string) => CacheFacts,
    lost: LostPaths | null,
    nested = false,
  ): Promise<void> {
    await keepVersions(this.cache, records, cacheFacts, lost, nested)
  }
}

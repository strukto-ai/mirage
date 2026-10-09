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

import type { OpKwargs } from '../../view/types.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { applyIo, setCached } from '../../cache/file/io.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { KeyLock } from '../../cache/lock.ts'
import { CacheManager } from '../../cache/manager.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { dispatchStat, dotRefusal, walkSpelling } from '../../commands/builtin/utils/paths.ts'
import { getExtension } from '../../utils/filetype.ts'
import { IOResult, type OpReport } from '../../io/types.ts'
import {
  eacces,
  eexist,
  einval,
  enoent,
  eisdir,
  enotdir,
  enotempty,
  erofs,
  isEnoent,
  isEnotdir,
  isMissError,
  isMissingOp,
  eloop,
  exdev,
  noMount,
  noXattr,
  walkRefusal,
} from '../../errors/fs.ts'
import { type FsError } from '../../errors/types.ts'
import { Policies, PolicyDenied } from '../../policy/index.ts'
import type { Decisions } from '../../policy/decisions.ts'
import { Boundary } from '../../policy/boundary.ts'
import { PolicyError } from '../../policy/errors.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { normDir, ownerPrefix, rstripSlash } from '../../utils/slash.ts'
import { CycleError, norm, parent, posixNormpath } from '../../utils/path.ts'
import type { Visibility } from '../../types.ts'
import type { EntryGate } from '../../policy/types.ts'
import {
  activeRecords,
  commandRecords,
  type LostPaths,
  record,
  runWithMountContext,
  runWithRecording,
  startOp,
} from '../../observe/context.ts'
import { wrapStream } from '../mount/mount.ts'
import { OpRecord, WRITE_FINGERPRINT_OPS } from '../../observe/record.ts'
import { mergeReaddir, namespaceListing, namespaceStat } from '../../view/namespace_view.ts'
import { ebusy, isMissingPath } from '../../errors/fs.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import {
  type CacheFacts,
  type CapacityResult,
  CapacityState,
  DEFAULT_READ_TTL,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  VFSName,
  WritePolicy,
} from '../../types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountEntry } from '../mount/mount.ts'
import { mergeOverlayStat } from '../mount/namespace/overlay.ts'
import { Reconciler } from '../reconcile.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import {
  DISPATCH_READ_OPS,
  DISPATCH_WRITE_OPS,
  ENTRY_CREATE_OPS,
  FILE_CREATE_OPS,
  HIDDEN_CREATE_OPS,
  LINK_ENTRY_OPS,
  NAMESPACE_TABLE_OPS,
  NO_FOLLOW_OPS,
  POLICY_WRITE_OPS,
  SERIAL_WRITE_OPS,
  SETATTR_KEYS,
  STAMP_WRITE_OPS,
  XATTR_OPS,
} from './constants.ts'
import {
  effectivePathMode,
  explaining,
  getCurrentSession,
  hiddenRefusal,
  sessionVisibility,
} from '../../context/session_context.ts'
import { hiddenUnder, moveReveals, pathVisible } from '../../utils/hidden.ts'
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
function visibleEntries(entries: string[], parent: string): string[] {
  const base = rstripSlash(parent)
  const vis = sessionVisibility()
  return entries.filter((e) => {
    const trimmed = rstripSlash(e)
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return pathVisible(vis, `${base}/${name}`)
  })
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
          .find((spec) => effectivePathMode(spec.virtual, prefix, mode) === MountMode.READ) ?? path
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
 * A custom function's other path arguments, by position or keyword; a
 * rename's destination is walked on its own. Mirrors Python's `_operands`.
 */
function operands(
  name: string,
  args: readonly unknown[] | undefined,
  kwargs: Record<string, unknown> | undefined,
): [number | string, PathSpec][] {
  if (name === 'rename') return []
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
 * Stamp the caller's report: memory answered, no backend ran.
 *
 * Fires at the moment a warm file-cache hit or a synthetic namespace
 * answer is in hand, before the post gate and any output cap, so
 * whatever those throw cannot erase the fact. The value is
 * `VFSName.RAM`, which is how a record says "this never crossed
 * the network": `OpRecord.isCache` is defined as that string, and
 * every network/cache total derives from it.
 */
function memoryAnswered(report: OpReport | undefined, moved: number | null = null): void {
  report?.served(VFSName.RAM, moved)
}

/**
 * Stamp the caller's report: the owning mount answered. A report memory
 * already stamped (a namespace answer for a missing path) keeps that.
 * Mirrors Python's `_served`.
 */
function served(report: OpReport | undefined, result: unknown): void {
  if (report?.completed === true) return
  report?.served(null, result instanceof Uint8Array ? result.byteLength : null)
}

/**
 * Pull a stream's first chunk now and answer the stream from there, so a read
 * that fails at its start fails at the call, where the dispatcher handles it, rather
 * than in the hands of whoever pulls it later. Mirrors Python's `_primed`.
 */
async function primed(
  stream: AsyncIterable<Uint8Array>,
  report: OpReport | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  const iterator = stream[Symbol.asyncIterator]()
  let first: IteratorResult<Uint8Array>
  try {
    first = await iterator.next()
  } catch (err) {
    await iterator.return?.()
    throw err
  }
  const rest = resumed(first.done === true ? [] : [first.value], iterator, report)
  await rest.next()
  return rest
}

/**
 * The chunks already pulled, then the rest of the stream. `primed` runs it to
 * its empty first step, inside the `try`, so a caller that closes it before
 * pulling still closes the stream. The stream completes when its last chunk is
 * pulled or it is closed, so that is when the caller's report is stamped, with
 * the bytes the store moved.
 */
async function* resumed(
  head: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  report: OpReport | undefined,
): AsyncGenerator<Uint8Array> {
  let moved = head.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  try {
    yield new Uint8Array()
    yield* head
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) return
      moved += next.value.byteLength
      yield next.value
    }
  } finally {
    await iterator.return?.()
    report?.served(null, moved)
  }
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
  readonly dst: PathSpec | null
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
}

/** The filetype a read is rendered as, null for none. */
function readType(call: Call): string | null {
  const requested = call.kwargs?.filetype
  if (requested === undefined) return getExtension(call.path.virtual)
  return typeof requested === 'string' ? requested : null
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
  private readonly writers = new KeyLock()
  private readonly stores = new WeakMap<BaseVFS, number>()
  private storeCount = 0
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

  /**
   * The namespace's own answer for a path no backend serves.
   *
   * Child mounts and symlinks are structure the dispatcher owns, so a
   * directory that exists only because a mount or link sits below it
   * still lists and stats. Null for any other op, or when the
   * namespace knows nothing at `virtual`.
   */
  private namespaceResult(name: string, virtual: string): string[] | FileStat | null {
    const vis = sessionVisibility()
    if (name === 'readdir') {
      return namespaceListing(vis, this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    if (name === 'stat') {
      return namespaceStat(vis, this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    return null
  }

  dispatch: DispatchFn = (name, path, args, kwargs, report) => {
    const run = (): ReturnType<DispatchFn> =>
      this.dispatchAdmitted(name, path, args, kwargs, report)
    if (this.admitWrite === null || !POLICY_WRITE_OPS.has(name)) return run()
    return this.admitWrite(run)
  }

  private dispatchAdmitted: DispatchFn = async (name, path, args, kwargs, report) => {
    // The caller's own mark on the op, lifted before any gate fires so
    // each one is told whose op it judges.
    const [issuer, stripped] = takeIssuer(kwargs)
    // withDispatchRuleGuard's mark, never forwarded to an op.
    const { ruleGate, ...unmarked } = (stripped ?? {}) as { ruleGate?: EntryGate | null }
    kwargs = ruleGate === undefined ? stripped : unmarked
    // The dispatcher's own keywords: a read answered as it is pulled, and a read
    // of what the backend holds now, past the file cache.
    const { stream, direct, ...own } = (kwargs ?? {}) as { stream?: unknown; direct?: unknown }
    if (name === 'read' && (stream !== undefined || direct !== undefined)) kwargs = own
    await this.prepare()
    const call = await this.walk(name, path, args, kwargs, ruleGate ?? null, report, issuer)
    call.stream = name === 'read' && stream === true
    call.direct = name === 'read' && direct === true
    await this.refuseRename(call)
    if (this.tableAnswers(name, call.path.virtual, call.kwargs)) {
      return [
        await this.tableCall(name, call.path, call.args ?? [], call.kwargs ?? {}, report, issuer),
        new IOResult(),
      ]
    }
    this.follow(call)
    await this.walkOperands(call)
    if (XATTR_OPS.has(name)) {
      return [
        await this.answerXattr(name, call.path, call.kwargs ?? {}, report, issuer),
        new IOResult(),
      ]
    }
    if (name === 'statfs') return [await this.statfs(call.path, issuer), new IOResult()]
    const owner = this.namespace.tryMountFor(call.path.virtual)
    const boundary = this.boundary(owner)
    if (owner !== null) {
      await this.refuseCrossMount(call, owner)
      try {
        await this.admit(call, owner, boundary)
      } catch (err) {
        // mkdir(2) looks its name up first, so on a read-only region the
        // answer is whatever that lookup finds.
        if (
          name !== 'mkdir' ||
          (err as { code?: unknown } | null)?.code !== 'EROFS' ||
          effectivePathMode(call.path.virtual, owner.prefix, owner.mode) !== MountMode.READ
        ) {
          throw err
        }
        await mkdirOnReadOnly(
          dispatchStat(this.dispatch),
          owner.prefix,
          owner.mode,
          call.path,
          call.kwargs?.parents === true,
        )
        return [null, new IOResult()]
      }
    }
    let resolved: [BaseVFS, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(call.path.virtual, false)
    } catch (err) {
      return [await this.answerUnmounted(call, err), new IOResult()]
    }
    const [vfs, scope, mode] = resolved
    // resolve() above already threw for a path outside every mount, so
    // this lookup cannot miss.
    const mount = this.namespace.mountFor(call.path.virtual)
    if (mount !== owner) throw ebusy(call.path.virtual)
    if (
      name === 'rmdir' &&
      this.namespace.linkStatsBelow(call.path.virtual).some(([link]) => pathVisible(call.vis, link))
    ) {
      throw enotempty(call.path.virtual)
    }
    await mount.ensureReady()
    const cached = await this.serveCached(call, mount, vfs, boundary)
    if (cached !== null) {
      return [cached, new IOResult({ reads: { [call.path.virtual]: cached } })]
    }
    const [answer, renameDst, fullArgs] = await this.callBackend(call, mount, vfs, scope, mode)
    const result = this.filter(call, answer)
    if (
      (DISPATCH_WRITE_OPS.has(name) || (call.write && !POLICY_WRITE_OPS.has(name))) &&
      !SERIAL_WRITE_OPS.has(name)
    ) {
      await this.settleWrite(
        name,
        call.path,
        renameDst,
        fullArgs,
        operands(name, call.args, call.kwargs),
      )
    }
    // The transfer already happened, so a limit changes what the caller
    // receives, not what the backend moved; the report above already
    // carries the moved count.
    return [await boundary.complete(name, call.path, call.write, result), new IOResult()]
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
    if (this.drift?.pending === true && explaining() === null) {
      // Resolve backend IDs afresh without consulting the restored index.
      await this.drift.drain(this.namespace, async (p) => {
        const [stat] = await this.dispatch('stat', PathSpec.fromStrPath(p), [], {
          index: new RAMIndexCacheStore(),
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
   * lead in, and a rename destination is a create. Every link above the
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
  ): Promise<Call> {
    const vis = sessionVisibility()
    if (!pathVisible(vis, path.virtual)) {
      throw hiddenRefusal(vis, path.virtual, HIDDEN_CREATE_OPS.has(name))
    }
    let dstArg = args?.[0]
    if (name === 'rename' && dstArg instanceof PathSpec && !pathVisible(vis, dstArg.virtual)) {
      throw hiddenRefusal(vis, dstArg.virtual, true)
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
    // spelling: `x/` must be a directory, so a create of one is EISDIR
    // before anything is looked up.
    if (FILE_CREATE_OPS.has(name) && path.dotted?.endsWith('/') === true) throw eisdir(path)
    const renamed = name === 'rename' && dstArg instanceof PathSpec ? dstArg : null
    if (path.dotted !== null || (renamed !== null && renamed.dotted !== null)) {
      const walkStat = dispatchStat(this.dispatch)
      const follow = (virtual: string): string => this.namespace.follow(virtual)
      const refusal =
        (await dotRefusal(walkStat, path, follow, ENTRY_CREATE_OPS.has(name))) ??
        (renamed !== null ? await dotRefusal(walkStat, renamed, follow) : null)
      if (refusal !== null) throw refusal
    }
    const [typed, typedDst] = [path, dstArg]
    path = this.walked(path, HIDDEN_CREATE_OPS.has(name))
    if (name === 'rename' && dstArg instanceof PathSpec) {
      dstArg = this.walked(dstArg, true)
      args = [dstArg, ...(args ?? []).slice(1)]
    }
    // The command's gate judges each spelling, as handed in and as walked,
    // once both walks have answered for hidden space: here for an op on the
    // name itself, in `follow` for the rest.
    const noFollow = NO_FOLLOW_OPS.has(name) || kwargs?.nofollow === true
    if (ruleGate !== null && noFollow) judge(ruleGate, typed, path, typedDst, dstArg)
    return {
      name,
      path,
      typed,
      dst: name === 'rename' && dstArg instanceof PathSpec ? dstArg : null,
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
    if (dst === null) return
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
   * typed path. Consumed here, never forwarded. Mirrors Python's
   * Dispatcher._follow.
   */
  private follow(call: Call): void {
    const nofollow = call.kwargs?.nofollow === true
    if (call.kwargs !== undefined && 'nofollow' in call.kwargs) {
      const rest = { ...call.kwargs }
      delete rest.nofollow
      call.kwargs = rest
    }
    const walked = call.path
    if (!NO_FOLLOW_OPS.has(call.name) && !nofollow) {
      const followed = followOrLoop(this.namespace, call.path, true)
      if (followed !== call.path.virtual) {
        call.path = PathSpec.fromStrPath(followed)
        if (!pathVisible(call.vis, call.path.virtual)) {
          throw hiddenRefusal(call.vis, call.path.virtual, HIDDEN_CREATE_OPS.has(call.name))
        }
      }
    }
    if (call.ruleGate !== null && !call.noFollow)
      judge(call.ruleGate, call.typed, walked, call.path)
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
   * Answer EXDEV for a rename between two mounts.
   *
   * A mount is a filesystem boundary: rename(2) moves a name within one and
   * answers EXDEV across two, before any permission is weighed, so `mv`
   * falls back to copy and unlink instead of the source's backend taking
   * the destination for one of its keys. It resolves both parent
   * directories first, so a missing one is ENOENT (ENOTDIR through a file)
   * ahead of EXDEV. Mirrors Python's Dispatcher._refuse_cross_mount.
   */
  private async refuseCrossMount(call: Call, owner: MountEntry): Promise<void> {
    // A function runs on one backend, so every path it is handed must be
    // on the mount that serves it.
    for (const [, other] of operands(call.name, call.args, call.kwargs)) {
      if (this.namespace.tryMountFor(other.virtual) !== owner) throw exdev(other)
    }
    const dst = call.dst
    if (dst === null || this.namespace.tryMountFor(dst.virtual) === owner) return
    throw (
      (await this.parentRefusal(call.path, call.issuer)) ??
      (await this.parentRefusal(dst, call.issuer)) ??
      exdev(call.path)
    )
  }

  /**
   * Run admission for an op on a mounted path.
   *
   * Admission policies fire at the dispatcher, before the warm-cache early
   * return: a cached read must be refused exactly like a cold one, or the
   * cache becomes a policy bypass. This dispatcher is the one dispatcher in
   * TypeScript: shell internals, programmatic access, `ws.vfs`, and
   * FUSE all end up here. A rename's destination is a create there: it
   * passes the same gate as the source, so a path rule holds against
   * moving into a protected scope (or onto the directory that holds one)
   * the way it holds against writing there, under the mode of the mount
   * that owns it. Mirrors Python's Dispatcher._admit.
   */
  private async admit(call: Call, mount: MountEntry, boundary: Boundary): Promise<void> {
    // A function the VFS declares a write is judged as one, whatever its
    // name: the POSIX names are known here, a custom one only to the VFS
    // that defines it.
    call.write = call.write || mount.writes(call.name)
    await boundary.admit(
      call.name,
      call.path,
      call.write,
      {
        create: HIDDEN_CREATE_OPS.has(call.name),
        subtree: call.name === 'rename',
        final: call.name !== 'rename',
      },
      call.issuer,
    )
    if (call.dst !== null) {
      await this.boundary(this.namespace.tryMountFor(call.dst.virtual)).admit(
        call.name,
        call.dst,
        true,
        { create: true, subtree: true },
        call.issuer,
      )
    }
    for (const [, other] of operands(call.name, call.args, call.kwargs)) {
      await boundary.admit(call.name, other, call.write, {}, call.issuer)
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
    if (call.name === 'setattr' && isMissingPath(err)) {
      await bare.admit(call.name, call.path, true, {}, call.issuer)
      const stored = await this.overlaySetattr(call.path, call.kwargs ?? {})
      memoryAnswered(call.report)
      await bare.complete(call.name, call.path, true, stored)
      return stored
    }
    let fallback = isMissingPath(err) ? this.namespaceResult(call.name, call.path.virtual) : null
    if (fallback === null) throw err
    if (call.name === 'readdir' && Array.isArray(fallback)) {
      fallback = visibleEntries(fallback, call.path.virtual)
    }
    await bare.admit(call.name, call.path, call.write, {}, call.issuer)
    // A synthetic namespace answer (a directory that exists only because a
    // mount or a link sits below it) contacts nothing, so attributing it to
    // the mount that lexically owns the path would invent a network op
    // against that backend. Stamped before the gate and the cap, so
    // whatever they throw cannot erase it.
    memoryAnswered(call.report)
    return bare.complete(call.name, call.path, call.write, fallback)
  }

  /**
   * Whether a read is answered as it is pulled. A whole read of stored bytes
   * streams through the VFS's own `readStream`. A window, a rendering, a VFS
   * with no stream and a postVfs policy that may read the result each get the
   * whole bytes instead, which are a stream of one chunk. Mirrors Python's
   * Dispatcher._streams.
   */
  private streams(call: Call, mount: MountEntry, vfs: BaseVFS): boolean {
    const [offset, size] = readWindow(call.kwargs)
    return (
      call.stream &&
      offset === 0 &&
      size === null &&
      vfs.supports('readStream') &&
      !this.rendersRead(call, mount) &&
      !this.policies.readsResults()
    )
  }

  /**
   * Open a streamed read, its first chunk pulled before it returns. A cold
   * read fills the cache as it is pulled. Mirrors Python's
   * Dispatcher._open_stream.
   */
  private async openStream(
    call: Call,
    mount: MountEntry,
    scope: PathSpec,
    filler: CacheManager | null,
  ): Promise<AsyncIterable<Uint8Array>> {
    const [opened, records] = await commandRecords((mine) =>
      Promise.resolve([mount.readStream(scope), mine] as const),
    )
    const stream =
      filler === null
        ? opened
        : filler.fillStream(call.path, opened, records, () => !this.rendersRead(call, mount))
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
  ): Promise<Uint8Array | null> {
    if (call.direct || !vfs.cachesReads || !DISPATCH_READ_OPS.has(call.name)) return null
    const cached = await this.cache.get(call.path.virtual)
    if (
      cached === null ||
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
    return (await boundary.complete(call.name, call.path, call.write, window)) as Uint8Array
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
      ...(filetype !== null && kwargs?.filetype === undefined ? { filetype } : {}),
    }
    const renameDst = name === 'rename' && call.args?.[0] instanceof PathSpec ? call.args[0] : null
    const fullArgs = (call.args ?? []).map(keyed)
    // Per-op command limits bind to the executing (post-follow)
    // mount, and the timeout window covers only the backend op — cache
    // probes and post-write invalidation stay outside the budget —
    // mirroring Python's Mount.call.
    const opOverride = mount.commandLimits.get(name) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    // A fill keeps the token its backend records with the read; a read
    // outside a line (FUSE, ws.vfs) records into a scope of its own for that.
    const recorded = <T>(fill: () => Promise<T>): Promise<T> =>
      filler !== null && activeRecords() === undefined
        ? runWithRecording(fill).then(([value]) => value)
        : fill()
    let result
    try {
      if (this.streams(call, mount, vfs)) {
        return [
          await recorded(() => this.openStream(call, mount, scope, filler)),
          renameDst,
          fullArgs,
        ]
      }
      const run = (opKwargs: OpKwargs, onCall?: (call: Promise<unknown>) => void) =>
        mount.use(async () => {
          const answer = await runWithMountContext(
            () =>
              mount.runWithWriteRevisions(async () => {
                const pending = Promise.resolve(
                  name === 'setattr'
                    ? this.applySetattr(mount, vfs, scope, p, opKwargs)
                    : mount.callKeyed(name, scope, fullArgs, opKwargs),
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
        // file, and a rename holds both of its names, taken in one order so
        // two renames between the same pair cannot deadlock. What the write
        // changes beside the store (caches, the node table's links and
        // attributes) changes under the same hold: a chain of renames
        // finishing out of order would move one name's attributes onto
        // another.
        const keys = [...new Set([p.virtual, ...(renameDst !== null ? [renameDst.virtual] : [])])]
          .map((virtual) => `${String(this.storeId(vfs))}:${mountKey(virtual, prefix)}`)
          .sort(compareCodePoints)
        let mine: OpRecord[] = []
        const own = (onCall: (storeCall: Promise<unknown>) => void): Promise<unknown> =>
          commandRecords((records) => {
            mine = records
            return run(fullKwargs, onCall)
          })
        result = await this.holdWrite(
          keys,
          opTimeout,
          name,
          `${name} ${p.virtual}`,
          (onCall) =>
            activeRecords() === undefined
              ? runWithRecording(() => own(onCall)).then(([value]) => value)
              : own(onCall),
          async (value) => {
            served(report, value)
            await this.settleWrite(name, p, renameDst, fullArgs, operands(name, call.args, kwargs))
            await this.keepWritten(call, mount, fullArgs, mine)
          },
        )
      } else {
        result = await run(fullKwargs)
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (name === 'rmdir' && (code === 'ENOTEMPTY' || code === 'EEXIST')) {
        await this.rmdirRemnants(vfs, scope, mountPrefix, mode, err, call.issuer)
        result = null
      } else {
        const fallback =
          isMissingPath(err) || isEnotdir(err) ? this.namespaceResult(name, p.virtual) : null
        if (fallback === null) {
          await this.reconciler.onEnoent(mount, name, p.virtual, err)
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
    return [result, renameDst, fullArgs]
  }

  /**
   * Keep a whole write's bytes for the next read, under its name's hold.
   *
   * The write's own record labels them with the token the backend
   * answered, so a `fresh` mount does not refetch what it just wrote; a
   * record moving another length than was sent keeps nothing. Mirrors
   * Python's Dispatcher._keep_written.
   */
  private async keepWritten(
    call: Call,
    mount: MountEntry,
    args: readonly unknown[],
    records: readonly OpRecord[],
  ): Promise<void> {
    const data = args[0]
    const facts = factsOf(mount)
    if (call.name !== 'write' || !(data instanceof Uint8Array) || !facts.cacheable) return
    // Copies, so the line's records do not hold the written bytes.
    const claims = records.map((rec) =>
      WRITE_FINGERPRINT_OPS.has(rec.op) && rec.path === call.path.virtual
        ? new OpRecord({
            op: rec.op,
            path: rec.path,
            source: rec.source,
            bytes: rec.bytes,
            timestamp: rec.timestamp,
            durationMs: rec.durationMs,
            fingerprint: rec.fingerprint,
            revision: rec.revision,
            mountId: rec.mountId,
            claimed: data,
          })
        : rec,
    )
    await setCached(this.cache, call.path.virtual, data, data, claims, () => facts)
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
      return visibleEntries(
        mergeReaddir(
          call.vis,
          result,
          this.namespace.mountPrefixes(),
          this.namespace,
          call.path.virtual,
        ),
        call.path.virtual,
      )
    }
    if (call.name === 'stat' && result instanceof FileStat) {
      return mergeOverlayStat(this.namespace.metaFor(call.path.virtual), result)
    }
    return result
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
   * call that lands after its timeout changes nothing beside the store, as
   * every timed-out op, since by then the names it touched may belong to
   * other mounts; a failure nobody waits for any more is reported.
   *
   * Args:
   *   keys: the names to hold, in the one order every writer takes them.
   *   timeout: the op's timeout in seconds, or null for none.
   *   name: the function, for the timeout's error.
   *   label: the op and path, for a late failure's report.
   *   call: runs the op, handing over the store's own call once it starts.
   *   after: the bookkeeping, run while the caller still waits.
   */
  private async holdWrite(
    keys: readonly string[],
    timeout: number | null,
    name: string,
    label: string,
    call: (onCall: (storeCall: Promise<unknown>) => void) => Promise<unknown>,
    after: (value: unknown) => Promise<void>,
  ): Promise<unknown> {
    const turn = { entered: false, abandoned: false, late: false, started: false, settled: false }
    let giveUp = (): void => undefined
    const gaveUp = new Promise<void>((resolve) => {
      giveUp = resolve
    })
    let answer: Promise<unknown> = Promise.resolve()
    let finished: Promise<void> = Promise.resolve()
    const entered = new Promise<void>((enter) => {
      const held = async (): Promise<void> => {
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
        })
        // The store's own call once it started, else the run's answer: a
        // timeout answers the caller, not the store.
        const stored = answer.then(
          () => started.call ?? answer,
          () => started.call ?? answer,
        )
        finished = stored.then(async (value) => {
          if (!turn.late) await after(value)
        })
        enter()
        await finished.catch((err: unknown) => {
          if (turn.late) console.warn(`${label} failed after its timeout: ${String(err)}`)
        })
      }
      void keys.reduceRight<() => Promise<void>>(
        (inner, key) => () => this.writers.withLock(key, () => Promise.race([inner(), gaveUp])),
        held,
      )()
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
  private async settleWrite(
    name: string,
    p: PathSpec,
    renameDst: PathSpec | null,
    args: readonly unknown[],
    others: readonly [number | string, PathSpec][],
  ): Promise<void> {
    const opened = appendsNothing(name, args)
    const observed = STAMP_WRITE_OPS.has(name) && !opened ? Date.now() / 1000 : null
    // rename(2) moves a file without touching its times, which the node
    // table carries to the new name below.
    await this.invalidateAfterWriteByPath(
      p.virtual,
      observed,
      !opened && name !== 'rename',
      name === 'unlink' || name === 'rmdir',
    )
    for (const [, other] of others) await this.invalidateAfterWriteByPath(other.virtual)
    if (name === 'unlink' || name === 'rmdir') {
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
        const vis = sessionVisibility()
        for (const [link] of this.namespace.linkStatsBelow(p.virtual)) {
          if (pathVisible(vis, link)) arrived.add(link)
        }
        await this.namespace.purgeUnder(p.virtual, arrived)
      }
    }
    if (renameDst !== null) {
      await this.invalidateAfterRenameByPath(p.virtual, renameDst.virtual)
      // rename(2) replaces the destination, so a node the table holds
      // at that name does not survive the move. A link left there
      // shadowed the file that had just landed: the listing showed the
      // new file, every read followed the old link, and the moved
      // content was reachable under no name at all.
      await this.namespace.unlink(renameDst.virtual)
      // The subtree moves with it, and only the node table can move the
      // part of it no backend holds: a link or an attr overlay below the
      // source is addressed by absolute path, so it would otherwise stay
      // behind at a name the rename has emptied. The destination's own
      // subtree is replaced first, as rename(2) replaces what it lands on.
      await this.namespace.purgeUnder(renameDst.virtual)
      // The node at the source itself is not part of the subtree below it,
      // so re-anchoring that subtree leaves it behind: the mode or ownership
      // a chmod recorded stayed at the emptied name, never reached the
      // landing, and was inherited by whatever was created at the old name
      // next. Shell mv compensates for this in its own prepare step; a verb
      // reaching the dispatcher directly, as git mv does, had nothing to.
      await this.namespace.rename(p.virtual, renameDst.virtual)
      await this.namespace.renameUnder(p.virtual, renameDst.virtual)
    }
  }

  /** A number naming one store object, the same for every mount of it. */
  private storeId(vfs: BaseVFS): number {
    const known = this.stores.get(vfs)
    if (known !== undefined) return known
    this.storeCount += 1
    this.stores.set(vfs, this.storeCount)
    return this.storeCount
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
      sessionId(),
      this.decisions,
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
    const write = mount.writes(name)
    const boundary = new Boundary(this.policies, mountPrefix, mode, sessionId(), this.decisions)
    if (write) {
      // The same pre-vfs admission a dispatched op answers, with the
      // walk's own child path: the gate that admitted the rmdir judged
      // the directory, not what the cascade found under it, and a
      // policy that protects one of those paths must refuse its
      // deletion exactly as it would refuse a first-class op. The
      // caller folds the denial into its original refusal, so a
      // policy's protection of a hidden path never surfaces as its own
      // denial.
      await boundary.admit(name, spec, true, { checkHidden: false }, issuer)
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
              mount.callKeyed(name, spec, [], {
                ...this.indexKwargs(mount),
                ...kwargs,
              }),
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
        await this.invalidateAfterWriteByPath(
          spec.virtual,
          null,
          true,
          name === 'unlink' || name === 'rmdir',
        )
      }
    }
  }

  /**
   * The stat this dispatcher runs for one mount's VFS, behind the same
   * fence as its own probes (mode, revision pins, index kwargs), with no
   * namespace follow or visibility filter: the caller has resolved the
   * path already. The path's filetype is stamped as dispatch stamps it,
   * so an op registered for one filetype answers here too. A
   * trailing-slash glob classifies a match with it, the twin of Python's
   * `owner.call("stat")`, so a trailing-slash glob and `stat` read
   * the same op table.
   */
  opStat(mount: MountEntry, path: PathSpec): Promise<unknown> {
    const filetype = getExtension(path.virtual)
    return this.fencedCall(
      mount.vfs,
      mount.prefix,
      mount.mode,
      'stat',
      path,
      undefined,
      filetype !== null ? { filetype } : {},
    )
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
    issuer?: symbol,
  ): Promise<void> {
    const vis = sessionVisibility()
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
      unlink: async (at) => {
        await this.fencedCall(vfs, mountPrefix, mode, 'unlink', at, issuer)
      },
      rmdir: async (at) => {
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
    for (const link of this.namespace.symlinkTargets().keys()) {
      if (link.startsWith(base) && pathVisible(vis, link)) throw refusal
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
    const vis = sessionVisibility()
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
    await boundary.admit(
      name,
      path,
      write,
      { create: HIDDEN_CREATE_OPS.has(name), final: name !== 'rename' },
      issuer,
    )
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
      await this.boundary(dstMount).admit(name, dst, true, { create: true }, issuer)
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
    return (await boundary.complete(name, path, write, result)) as string | FileStat | null
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
    if (namespaceStat(sessionVisibility(), prefixes, this.namespace, path.virtual) !== null) {
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
    if (namespaceStat(sessionVisibility(), prefixes, this.namespace, virtual) !== null) {
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
    const [, scope] = resolved
    const mount = this.namespace.tryMountFor(scope.virtual)
    if (mount === null) return null
    const boundary = this.boundary(mount)
    await boundary.admit(name, scope, false, {}, issuer)
    await mount.ensureReady()
    const filetype = getExtension(scope.virtual)
    try {
      const result = await mount.use(() =>
        mount.callKeyed(name, scope, [], {
          ...this.indexKwargs(mount),
          ...(filetype !== null ? { filetype } : {}),
        }),
      )
      return await boundary.complete(name, scope, false, result)
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
    await boundary.admit(name, path, write, {}, issuer)
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
    return boundary.complete(name, path, write, result)
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
    await boundary.admit('statfs', path, false, {}, issuer)
    await this.xattrTarget(mount, path)
    const answer: [string, CapacityResult] =
      mount === null
        ? ['-', { state: CapacityState.UNKNOWN }]
        : [mount.vfs.name, await mount.use(() => mount.vfs.capacity())]
    // A policy may deny the reply as it may any op's; a capacity is no bytes,
    // so a bound has nothing to cap.
    await boundary.complete('statfs', path, false, answer)
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
    vfs: BaseVFS,
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
    const raw = await mount.callKeyed('setattr', scope, [], kwargs)
    const residual = raw as Record<string, number | string>
    const applied = SETATTR_KEYS.filter(
      (key) => kwargs[key] !== undefined && kwargs[key] !== null && !(key in residual),
    )
    if (applied.length > 0) await this.namespace.dropAttrs(p.virtual, applied)
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

  /** Drop the whole file cache (post-remote-line invalidation). */
  async clearFileCache(): Promise<void> {
    await this.cache.clear()
  }

  /**
   * The cache manager that owns a mount's listings and bodies.
   *
   * One manager for both halves, as Python's invalidate_after_write does: it
   * is what knows the file cache is keyed mount-absolute while the index may
   * not be, and evicting the index inline here spelled the key the other way
   * and missed.
   */
  private managerFor(mount: MountEntry): CacheManager {
    return (
      mount.cacheManager ??
      new CacheManager(this.cache, mount.indexStore, mount.prefix, mount.vfs.cachesReads)
    )
  }

  /**
   * Drop what a write to `rawPath` made stale above the store. `observed` is
   * the epoch seconds of a content write to record, null for a removal;
   * `times` false keeps the overlay times, for an open that wrote nothing;
   * `removed` drops the path's own listing too, for an unlink or rmdir, as
   * a core's removal drops it. Mirrors Python's
   * Dispatcher.invalidate_after_write.
   */
  async invalidateAfterWriteByPath(
    rawPath: string,
    observed: number | null = null,
    times = true,
    removed = false,
  ): Promise<void> {
    // Directory writes (mkdir/rmdir via tree copies) arrive with a
    // trailing slash; normalize so the parent computation below does not
    // invalidate the written directory itself instead of its parent
    // (Python normalizes the same way via PathSpec.mount_path).
    const path = rstripSlash(rawPath) || '/'
    const mount = this.namespace.tryMountFor(path)
    if (mount === null) return
    if (times) await this.namespace.clearTimes(path, observed)
    const manager = this.managerFor(mount)
    if (removed) await manager.invalidateAfterUnlink(path)
    else await manager.invalidateAfterWrite(path)
    await manager.invalidateAncestors(path)
  }

  /**
   * Drop everything cached below both ends of a rename.
   *
   * A rename re-anchors the whole subtree under its source, so the listings
   * and bodies cached one level down under either name are stale, not just the
   * two paths and their parents. Evicting only those left a moved directory's
   * old name answering `stat` and `ls` from its cached children, so the next
   * rename onto that name saw a directory that was no longer there.
   */
  async invalidateAfterRenameByPath(source: string, dst: string): Promise<void> {
    const from = rstripSlash(source) || '/'
    const to = rstripSlash(dst) || '/'
    const mount = this.namespace.tryMountFor(from)
    if (mount === null) return
    const manager = this.managerFor(mount)
    await manager.invalidateSubtree(from)
    await manager.invalidateSubtree(to)
    await manager.invalidateAncestors(to)
  }

  // The file cache only holds paths for read-caching mounts, mirroring
  // Python's cache_facts_for gate; without it every backend's reads
  // land in the cache.
  cacheFactsFor = (path: string): CacheFacts => factsOf(this.namespace.tryMountFor(path))

  /**
   * Bind deferred command results to the mounts that produced them.
   *
   * The mount table is pinned at command start, so a fill that lands after
   * the command is stamped with the bound of the mount that produced the
   * bytes rather than whatever holds the prefix by then.
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

  async applyIo(
    io: IOResult,
    records?: readonly OpRecord[],
    cacheFacts: (path: string) => CacheFacts = this.cacheFactsFor,
    lost: LostPaths | null = null,
    nested = false,
  ): Promise<void> {
    await applyIo(this.cache, io, cacheFacts, records, lost, nested)
  }
}

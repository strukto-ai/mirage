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

import { NOOPAccessor } from '../../accessor/base.ts'
import { applyIo } from '../../cache/file/io.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { CacheManager } from '../../cache/manager.ts'
import { applyOpLimit, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { getExtension } from '../../commands/resolve.ts'
import { IOResult, type OpReport } from '../../io/types.ts'
import {
  eacces,
  erofsReadOnly,
  eexist,
  einval,
  enoent,
  isMissError,
  isMissingOp,
  type FsError,
} from '../../utils/errors.ts'
import { Policies, PolicyDenied, postOpsGate, preOpsGate } from '../../policy/index.ts'
import { PolicyError } from '../../policy/errors.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { normDir, ownerPrefix, rstripSlash } from '../../utils/slash.ts'
import { record, runWithMountPrefix, runWithRevisions, startOp } from '../../observe/context.ts'
import { wrapOpStream } from '../mount/mount.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import { type OpKwargs } from '../../ops/registry.ts'
import { NO_FOLLOW_OPS, STAMP_WRITE_OPS } from '../../ops/config.ts'
import { mergeReaddir, namespaceListing, namespaceStat } from '../../ops/namespace_view.ts'
import { ebusy, isMissingPath } from '../../utils/errors.ts'
import { cachesReads, type Resource } from '../../resource/base.ts'
import {
  ConsistencyPolicy,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  ResourceName,
} from '../../types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountEntry } from '../mount/mount.ts'
import { mergeOverlayStat } from '../mount/namespace/overlay.ts'
import { Reconciler } from '../reconcile.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import {
  DISPATCH_READ_OPS,
  DISPATCH_WRITE_OPS,
  HIDDEN_CREATE_OPS,
  LINK_ENTRY_OPS,
  NAMESPACE_TABLE_OPS,
  POLICY_WRITE_OPS,
  SETATTR_KEYS,
} from './constants.ts'
import { requireTurfWritable } from './lineage.ts'
import {
  effectivePathMode,
  getCurrentSession,
  hiddenPathsIntersect,
  liveSessions,
  pathAllowed,
} from '../../context/session_context.ts'
import { moveReveals } from '../../utils/hidden.ts'
import { removeRemnants, visibleBelow, type RemnantChannel } from '../../utils/remnants.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()

/** The error a hidden path answers: ENOENT, or EACCES for a create. */
function hiddenRefusal(opName: string, virtual: string): Error {
  return HIDDEN_CREATE_OPS.has(opName) ? eacces(virtual) : enoent(virtual)
}

/**
 * Drop listing entries the current session's spec hides.
 *
 * Entry shapes vary by backend (bare names, trailing-slash names, full
 * paths), so each is keyed by its final segment against the listed
 * directory, the same normalization `mergeReaddir` dedups by.
 */
function visibleEntries(entries: string[], parent: string): string[] {
  const base = rstripSlash(parent)
  return entries.filter((e) => {
    const trimmed = rstripSlash(e)
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return pathAllowed(`${base}/${name}`)
  })
}

// The id of the session this door serves, empty for the unbound host
// view; the same binding the hides and modes above read.
function sessionId(): string {
  return getCurrentSession()?.sessionId ?? ''
}

/**
 * The `issuer` kwarg lifted off an op, with the kwargs it leaves behind.
 *
 * A caller that stamps its ops (a profile policy's bridge) does so as
 * an argument, and the door consumes it here: it reaches every gate the
 * dispatch clears as `OpsContext.issuer`, probes and cascades included,
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

/** The byte window a read asked for, whole file when it asked none. */
function readWindow(kwargs: OpKwargs | undefined): [number, number | null] {
  return [
    typeof kwargs?.offset === 'number' ? kwargs.offset : 0,
    typeof kwargs?.size === 'number' ? kwargs.size : null,
  ]
}

export type ResolveFn = (path: string) => Promise<[Resource, PathSpec, MountMode]>

/**
 * Stamp the caller's report: memory answered, no backend ran.
 *
 * Fires at the moment a warm file-cache hit or a synthetic namespace
 * answer is in hand, before the post gate and any output cap, so
 * whatever those throw cannot erase the fact. The value is
 * `ResourceName.RAM`, which is how a record says "this never crossed
 * the network": `OpRecord.isCache` is defined as that string, and
 * every network/cache total derives from it.
 */
function memoryAnswered(report: OpReport | undefined, moved: number | null = null): void {
  report?.served(ResourceName.RAM, moved)
}

export class Dispatcher {
  private readonly namespace: Namespace
  private readonly cache: FileCache & Resource
  private readonly opsRegistry: OpsRegistry
  private readonly policies: Policies
  // The snapshot drift queue rides along because this is the one door:
  // a strict restore's pending fingerprint checks must run before ANY
  // op can touch a mount, and FUSE and the fs facade reach here
  // without passing Workspace.dispatch.
  private readonly drift: DriftQueue | null
  readonly reconciler: Reconciler

  constructor(
    namespace: Namespace,
    cache: FileCache & Resource,
    opsRegistry: OpsRegistry,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    policies?: Policies,
    drift?: DriftQueue,
  ) {
    this.namespace = namespace
    this.cache = cache
    this.opsRegistry = opsRegistry
    this.policies = policies ?? new Policies()
    this.drift = drift ?? null
    this.reconciler = new Reconciler(cache, namespace, opsRegistry, consistency)
  }

  /**
   * The namespace's own answer for a path no backend serves.
   *
   * Child mounts and symlinks are structure the door owns, so a
   * directory that exists only because a mount or link sits below it
   * still lists and stats. Null for any other op, or when the
   * namespace knows nothing at `virtual`.
   */
  private namespaceResult(opName: string, virtual: string): string[] | FileStat | null {
    if (opName === 'readdir') {
      return namespaceListing(this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    if (opName === 'stat') {
      return namespaceStat(this.namespace.mountPrefixes(), this.namespace, virtual)
    }
    return null
  }

  dispatch: DispatchFn = async (opName, path, args, kwargs, report) => {
    // The caller's own mark on the op, lifted before any gate fires so
    // each one is told whose op it judges.
    const [issuer, stripped] = takeIssuer(kwargs)
    kwargs = stripped
    await this.namespace.ensureLoaded()
    // Pending fingerprint checks from a strict snapshot restore run
    // before the op can touch a mount, whichever surface called: FUSE
    // and the fs facade come straight here, so a drain that lived any
    // higher would let a first write clobber drifted state. drain()
    // clears pending before it stats, so its own probes cannot recurse
    // into it.
    if (this.drift?.pending === true) {
      await this.drift.drain(this.namespace, async (p) => {
        const [stat] = await this.dispatch('stat', PathSpec.fromStrPath(p))
        return stat
      })
    }
    // Hidden paths answer before anything else can: the typed path is
    // checked so a link inside hidden space cannot be followed out of
    // it, the followed path is re-checked so a visible link cannot
    // lead in, and a rename destination is a create.
    if (!pathAllowed(path.virtual)) {
      throw hiddenRefusal(opName, path.virtual)
    }
    const dstArg = args?.[0]
    if (opName === 'rename' && dstArg instanceof PathSpec && !pathAllowed(dstArg.virtual)) {
      throw eacces(dstArg.virtual)
    }
    if (opName === 'rename' && dstArg instanceof PathSpec) {
      // A rename re-anchors everything below its source while the hides
      // stay where they are written, so hidden content would land at
      // paths the session can see. Destroying hidden content is silent
      // (rmR, the remnant rmdir below); relocating it into view is
      // refused. Only a directory has anything below it to re-anchor,
      // so a file source passes.
      for (const sess of liveSessions()) {
        if (
          moveReveals(sess.hiddenPaths, sess.shownPaths, path.virtual, dstArg.virtual) &&
          (await this.movedSourceIsDir(path, issuer))
        ) {
          throw eacces(path.virtual)
        }
      }
    }
    if (this.tableAnswers(opName, path.virtual, kwargs)) {
      return [
        await this.namespaceTableOp(opName, path, args ?? [], kwargs ?? {}, report, issuer),
        new IOResult(),
      ]
    }
    // `nofollow` is the caller's AT_SYMLINK_NOFOLLOW: an op that acts on
    // a link entry itself (chown -h writing the link's own attrs) keeps
    // the typed path. Consumed here, never forwarded.
    const nofollow = kwargs?.nofollow === true
    if (nofollow) {
      const rest = { ...kwargs }
      delete rest.nofollow
      kwargs = rest
    }
    let p = path
    if (!NO_FOLLOW_OPS.has(opName) && !nofollow) {
      const followed = this.namespace.follow(path.virtual)
      if (followed !== path.virtual) {
        p = PathSpec.fromStrPath(followed)
        if (!pathAllowed(p.virtual)) throw hiddenRefusal(opName, p.virtual)
      }
    }
    const resolvedOwner = this.namespace.tryMountFor(p.virtual)
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(p.virtual, false)
    } catch (err) {
      // No mount serves the path, but the namespace may still know a
      // directory there (a deeper mount, a link). No mount means no
      // cache to keep straight and no owning prefix (the gates see ''),
      // but admission still fires: a policy that bounds readdir or stat
      // by path must cover the synthetic answer too. A real but
      // ungranted mount is the same case: a granted mount below it
      // already put this path's name in a listing, so walking down to
      // the grant must answer, and the merged names are
      // session-filtered individually, so nothing of the mount's own
      // content leaks.
      // A setattr with no owning mount lands in the overlay (a link
      // above every mount still takes chown -h), gated exactly like
      // the mounted overlay write; an ungranted mount is not that
      // case and keeps the canonical denial.
      if (opName === 'setattr' && isMissingPath(err)) {
        await preOpsGate(this.policies, opName, p, true, '', sessionId(), issuer)
        requireTurfWritable(null, p)
        const stored = await this.overlaySetattr(p, kwargs ?? {})
        memoryAnswered(report)
        await postOpsGate(this.policies, opName, p, true, '', stored)
        return [stored, new IOResult()]
      }
      const eligible = isMissingPath(err)
      let fallback = eligible ? this.namespaceResult(opName, p.virtual) : null
      if (fallback === null) throw err
      if (opName === 'readdir' && Array.isArray(fallback)) {
        fallback = visibleEntries(fallback, p.virtual)
      }
      const fallbackWrite = POLICY_WRITE_OPS.has(opName)
      await preOpsGate(this.policies, opName, p, fallbackWrite, '', sessionId(), issuer)
      // A synthetic namespace answer (a directory that exists only
      // because a mount or a link sits below it) contacts nothing, so
      // attributing it to the mount that lexically owns the path would
      // invent a network op against that backend. Stamped before the
      // gate and the cap, so whatever they throw cannot erase it.
      memoryAnswered(report)
      const fallbackBound = await postOpsGate(this.policies, opName, p, fallbackWrite, '', fallback)
      const gated = fallbackBound !== null ? await applyOpLimit(fallback, fallbackBound) : fallback
      return [gated, new IOResult()]
    }
    const [resource, scope, mode] = resolved
    // resolve() above already threw for a path outside every mount, so
    // this lookup cannot miss.
    const mount = this.namespace.mountFor(p.virtual)
    if (mount !== resolvedOwner) throw ebusy(p.virtual)
    const mountPrefix = mount.prefix
    // Admission policies fire at the door, before the warm-cache early
    // return below: a cached read must be refused exactly like a cold
    // one, or the cache becomes a policy bypass. This dispatcher is the
    // one door in TypeScript: shell internals, programmatic access, the
    // fs facade, and FUSE all end up here.
    const opWrite = POLICY_WRITE_OPS.has(opName)
    await preOpsGate(this.policies, opName, p, opWrite, mountPrefix, sessionId(), issuer)
    // A rename's destination is a create there: it passes the same gate
    // as the source, so a path rule holds against moving into a
    // protected scope (or onto the directory that holds one) the way it
    // holds against writing there.
    if (opName === 'rename' && dstArg instanceof PathSpec) {
      await preOpsGate(this.policies, opName, dstArg, true, mountPrefix, sessionId(), issuer)
    }
    const caches = cachesReads(resource)
    // The file cache is keyed on the path alone, and what a command put
    // there is the rendered read. A raw read asks for a different value
    // under the same key, so it must not be served from that cache;
    // nothing populates it from here, so skipping the probe is the
    // whole fix. Mirrors Python's Dispatcher.dispatch.
    await mount.ensureReady()
    const raw = kwargs?.filetype === null
    if (caches && !raw && DISPATCH_READ_OPS.has(opName)) {
      const cached = await this.cache.get(p.virtual)
      if (
        cached !== null &&
        (await this.reconciler.mayServeCached(mount, p.virtual)) &&
        !mount.retiring &&
        this.namespace.tryMountFor(p.virtual) === mount
      ) {
        // The cache holds the whole object, so a ranged read is answered
        // by slicing it, never by handing back the whole file: the
        // window is what the caller asked for instead of the file, and
        // git reads pack indexes this way. sliceWindow is the same
        // helper the ranged read op falls back to, so warm and cold
        // agree. Mirrors Python's Dispatcher.dispatch.
        const [offset, size] = readWindow(kwargs)
        const window = sliceWindow(cached, offset, size)
        // Nothing crossed the network, and neither a gate nor a hard
        // cap leaves the caller able to tell: without the stamp a
        // refused warm read is recorded against the backend and counted
        // as traffic that never happened.
        memoryAnswered(report, window.byteLength)
        const warmBound = await postOpsGate(this.policies, opName, p, opWrite, mountPrefix, window)
        const served = (
          warmBound !== null ? await applyOpLimit(window, warmBound) : window
        ) as Uint8Array
        return [served, new IOResult({ reads: { [p.virtual]: served } })]
      }
    }
    if (this.opsRegistry.find(opName, resource)?.write === true) {
      if (effectivePathMode(p.virtual, mountPrefix, mode) === MountMode.READ) {
        throw erofsReadOnly(`mount at '${p.virtual}' is read-only`, p)
      }
      // A rename mutates its destination too, so both endpoints answer.
      const wDst = opName === 'rename' && args?.[0] instanceof PathSpec ? args[0] : null
      if (wDst !== null && effectivePathMode(wDst.virtual, mountPrefix, mode) === MountMode.READ) {
        throw erofsReadOnly(`mount at '${wDst.virtual}' is read-only`, wDst)
      }
    }
    // Ops registered under a rendered filetype (gdocs/gsheets/gslides/
    // gmail reads) resolve by the path's extension; Python reaches them
    // because its dispatcher routes through Mount.execute_op, which
    // stamps the filetype. Stamp it here the same way.
    const filetype = getExtension(p.virtual)
    const fullKwargs: OpKwargs = {
      ...(kwargs ?? {}),
      ...(kwargs?.index === undefined ? this.indexKwargs(mount) : {}),
      ...(filetype !== null && kwargs?.filetype === undefined ? { filetype } : {}),
    }
    let fullArgs = args ?? []
    const renameDst = opName === 'rename' && fullArgs[0] instanceof PathSpec ? fullArgs[0] : null
    if (renameDst !== null) {
      // Ops.rename addresses both endpoints against the source's mount,
      // mirroring the Python dispatcher: a caller-supplied dst built
      // from the virtual path alone would otherwise reach the backend
      // untranslated.
      fullArgs = [
        new PathSpec({
          virtual: renameDst.virtual,
          directory: renameDst.virtual.slice(0, renameDst.virtual.lastIndexOf('/')) || '/',
          resourcePath: mountKey(renameDst.virtual, rstripSlash(mountPrefix)),
        }),
        ...fullArgs.slice(1),
      ]
    }
    // Per-op command limits bind to the executing (post-follow)
    // mount, and the timeout window covers only the backend op — cache
    // probes and post-write invalidation stay outside the budget —
    // mirroring Python's Mount.execute_op.
    const opOverride = mount.commandLimits.get(opName) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    let result
    // Backends name their records against the mount-relative key, so the
    // prefix has to be active while the op runs or the record loses the
    // mount it belongs to. Mirrors Python's Ops._call.
    try {
      result = await mount.use(async () => {
        const answer = await runWithMountPrefix(
          rstripSlash(mountPrefix),
          () =>
            runWithRevisions(mount.revisions.size > 0 ? mount.revisions : null, async () =>
              runWithTimeout(
                Promise.resolve(
                  opName === 'setattr'
                    ? this.applySetattr(resource, scope, p, fullKwargs)
                    : this.opsRegistry.call(
                        opName,
                        resource,
                        resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
                        scope,
                        fullArgs,
                        fullKwargs,
                      ),
                ),
                opTimeout,
                opName,
              ),
            ),
          mount.mountId,
        )
        return wrapOpStream(answer, rstripSlash(mountPrefix), mount.mountId, mount.activity)
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (opName === 'rmdir' && (code === 'ENOTEMPTY' || code === 'EEXIST')) {
        await this.rmdirRemnants(resource, scope, mountPrefix, mode, err, issuer)
        result = null
      } else {
        const fallback = isMissingPath(err) ? this.namespaceResult(opName, p.virtual) : null
        if (fallback === null) {
          await this.reconciler.onOpMissing(opName, p.virtual, err)
          throw err
        }
        result = fallback
        memoryAnswered(report)
      }
    }
    // The op ran, whatever invalidation, the post gate, or an output
    // cap do next: stamped here so a failure in any of them cannot
    // erase a transfer the backend already made.
    if (!report?.completed) {
      report?.served(null, result instanceof Uint8Array ? result.byteLength : null)
    }
    if (opName === 'readdir' && Array.isArray(result)) {
      result = visibleEntries(
        mergeReaddir(result, this.namespace.mountPrefixes(), this.namespace, p.virtual),
        p.virtual,
      )
    }
    if (DISPATCH_WRITE_OPS.has(opName)) {
      const observed = STAMP_WRITE_OPS.has(opName) ? Date.now() / 1000 : null
      await this.invalidateAfterWriteByPath(p.virtual, observed)
      if (renameDst !== null) {
        await this.invalidateAfterWriteByPath(renameDst.virtual)
        // rename(2) replaces the destination, so a node the table holds
        // at that name does not survive the move. A link left there
        // shadowed the file that had just landed: the listing showed the
        // new file, every read followed the old link, and the moved
        // content was reachable under no name at all.
        await this.namespace.unlink(renameDst.virtual)
      }
    }
    if (opName === 'stat' && result instanceof FileStat) {
      result = mergeOverlayStat(this.namespace.metaFor(p.virtual), result)
    }
    const bound = await postOpsGate(this.policies, opName, p, opWrite, mountPrefix, result)
    if (bound !== null) {
      // The transfer already happened, so the limit changes what the
      // caller receives, not what the backend moved; the report above
      // already carries the moved count.
      result = await applyOpLimit(result, bound)
    }
    return [result, new IOResult()]
  }

  /**
   * Whether the node table answers this op instead of a backend.
   *
   * `symlink` and `readlink` always, because a link exists nowhere else.
   * The rest only when the path itself is a link, and then for the same
   * reason the create and the read are the door's: forwarding reaches a
   * backend that has never heard of the name. A no-follow stat is the
   * read half of that fact (lstat asks for the link's own row, which
   * only the table holds); a following stat never arrives here, since
   * the follow below rewrote it to the target. Mirrors Python's
   * Dispatcher._table_answers.
   */
  /**
   * The index kwargs normal dispatch stamps on every registered op, for
   * the door's own raw registry calls: an indexed backend cannot
   * resolve a nested path without it.
   */
  private indexKwargs(mount: MountEntry | null): OpKwargs {
    const index = mount?.index
    return index !== undefined ? { index } : {}
  }

  /**
   * The door's own channel for internal walks: the TS twin of Python's
   * Mount.execute_op plus the dispatcher-side duties around it. The
   * same mode fence, index stamping and mount-prefix context normal
   * dispatch applies, plus the pre-ops admission for writes (Python
   * spells this on the channel as `_admit_cascade`) and the
   * dispatcher's own write invalidation, because raw registry calls
   * run outside the cache context dispatch establishes, so the cores'
   * invalidation cannot land. Invalidation runs even when the op
   * fails: a missing-path failure means the tree changed under the
   * walk, and the walk's own earlier listing is exactly the entry that
   * must not survive. Only the visibility filter stays off, which is
   * what lets a remnant walk see hidden entries. Every internal
   * registry call in this class routes through here; a bare
   * opsRegistry.call outside dispatch is a bug.
   */
  private async fencedCall(
    resource: Resource,
    mountPrefix: string,
    mode: MountMode,
    opName: string,
    spec: PathSpec,
    issuer?: symbol,
  ): Promise<unknown> {
    const mount = this.namespace.mountFor(spec.virtual)
    const write = this.opsRegistry.find(opName, resource)?.write === true
    if (write) {
      // The same pre-ops admission a dispatched op answers, with the
      // walk's own child path: the gate that admitted the rmdir judged
      // the directory, not what the cascade found under it, and a
      // policy that protects one of those paths must refuse its
      // deletion exactly as it would refuse a first-class op. The
      // caller folds the denial into its original refusal, so a
      // policy's protection of a hidden path never surfaces as its own
      // denial.
      await preOpsGate(this.policies, opName, spec, true, mountPrefix, sessionId(), issuer)
      if (effectivePathMode(spec.virtual, mountPrefix, mode) === MountMode.READ) {
        throw erofsReadOnly(`mount at '${spec.virtual}' is read-only`, spec)
      }
    }
    // The fence reruns backend ops outside `dispatch`, so the revision
    // pins have to ride here as on the main path above, or a cascade
    // read answers from the wrong version of a revision-pinned mount.
    // Python's twin gets both bindings from `Mount.execute_op`.
    await mount.ensureReady()
    try {
      return await mount.use(async () => {
        const answer = await runWithMountPrefix(
          rstripSlash(mountPrefix),
          () =>
            runWithRevisions(mount.revisions.size > 0 ? mount.revisions : null, () =>
              this.opsRegistry.call(
                opName,
                resource,
                resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
                spec,
                [],
                this.indexKwargs(mount),
              ),
            ),
          mount.mountId,
        )
        return wrapOpStream(answer, rstripSlash(mountPrefix), mount.mountId, mount.activity)
      })
    } finally {
      if (write) await this.invalidateAfterWriteByPath(spec.virtual)
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
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(path.virtual, false)
    } catch {
      // No mount to ask; classification fails toward refusal.
      return true
    }
    const [resource, scope, mode] = resolved
    let row: unknown
    try {
      row = await this.fencedCall(
        resource,
        this.namespace.mountFor(path.virtual).prefix,
        mode,
        'stat',
        scope,
        issuer,
      )
    } catch (err) {
      // An absent source moves nothing; the rename itself reports it.
      if (isMissingPath(err)) return false
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
   * the door's own readdir pipeline: backend entries merged with the
   * namespace's children (nested mounts, links) and judged by
   * visibility, so a visible child no backend can see keeps the
   * refusal instead of reporting a successful rmdir while the mounted
   * child remains. The namespace's own hidden nodes under the subtree
   * (links, attr overlays) are purged with it, so the removed tree
   * cannot resurface from the node table once the hide lifts.
   */
  private async rmdirRemnants(
    resource: Resource,
    path: PathSpec,
    mountPrefix: string,
    mode: MountMode,
    refusal: unknown,
    issuer?: symbol,
  ): Promise<void> {
    if (!hiddenPathsIntersect(path.virtual)) throw refusal
    let entries: unknown
    try {
      entries = await this.fencedCall(resource, mountPrefix, mode, 'readdir', path, issuer)
    } catch {
      // A backend that cannot list (or later, remove) the remnants
      // keeps the original refusal: the door has no way to take them.
      throw refusal
    }
    if (!Array.isArray(entries)) throw refusal
    const names = entries.map(String)
    const merged = mergeReaddir(names, this.namespace.mountPrefixes(), this.namespace, path.virtual)
    if (names.length === 0 || visibleBelow(path.virtual, merged, pathAllowed)) throw refusal
    const channel: RemnantChannel = {
      readdir: async (at) => {
        const listed = await this.fencedCall(resource, mountPrefix, mode, 'readdir', at, issuer)
        return Array.isArray(listed) ? listed.map(String) : []
      },
      stat: (at) => this.fencedCall(resource, mountPrefix, mode, 'stat', at, issuer),
      unlink: async (at) => {
        await this.fencedCall(resource, mountPrefix, mode, 'unlink', at, issuer)
      },
      rmdir: async (at) => {
        await this.fencedCall(resource, mountPrefix, mode, 'rmdir', at, issuer)
      },
    }
    try {
      await removeRemnants(channel, pathAllowed, path)
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
      if (link.startsWith(base) && pathAllowed(link)) throw refusal
    }
    await this.namespace.purgeUnder(path.virtual)
  }

  private tableAnswers(
    opName: string,
    virtual: string,
    kwargs: Record<string, unknown> | undefined,
  ): boolean {
    if (NAMESPACE_TABLE_OPS.has(opName)) return true
    if (!LINK_ENTRY_OPS.has(opName)) return false
    if (opName === 'stat' && kwargs?.nofollow !== true) return false
    return this.namespace.isLink(virtual)
  }

  /**
   * Answer a node-table op at the door itself, gated like a backend.
   *
   * A symlink is namespace state with no backend behind it, so the door
   * owns every verb that names one. Admission still fires exactly as for
   * a backend write: the link's turf is the longest mount prefix above it
   * (the same ownership rule the link read filter uses), session grants
   * and both gates run, and the write leaves an OpRecord — a scoped
   * kernel mount refuses exactly like a scoped shell. The turf's mode
   * gates the write too (`requireTurfWritable`), so a read-only mount
   * or grant answers EROFS for a link exactly as for a file; a link
   * above every mount is bare namespace structure, gated with an empty
   * prefix and governed by `/` (see `lineage.ts`). A rename's
   * destination is judged on its own turf, since the endpoints need not
   * share one. Also answers the `unlink`, `rename` and no-follow
   * `stat` of a path the node table holds a link for. Mirrors Python's
   * Dispatcher._namespace_table_op.
   */
  private async namespaceTableOp(
    opName: string,
    path: PathSpec,
    args: readonly unknown[],
    kwargs: OpKwargs,
    report: OpReport | undefined,
    issuer?: symbol,
  ): Promise<string | FileStat | null> {
    const timer = startOp()
    const mount = this.namespace.tryMountFor(path.virtual)
    const owner = mount?.prefix ?? null
    const write = POLICY_WRITE_OPS.has(opName)
    await preOpsGate(this.policies, opName, path, write, owner ?? '', sessionId(), issuer)
    if (write) requireTurfWritable(mount, path)
    let target: string
    let result: string | FileStat | null = null
    if (opName === 'unlink') {
      target = this.namespace.readlink(path.virtual) ?? ''
      await this.namespace.unlink(path.virtual)
    } else if (opName === 'rename') {
      target = this.namespace.readlink(path.virtual) ?? ''
      const dst = args[0]
      if (!(dst instanceof PathSpec)) throw new Error('rename op requires dst')
      // The destination is a create there, gated like the source and on
      // its own turf, the way the backend path gates both ends of a
      // rename. It is then replaced as rename(2) replaces it: any node
      // the table holds at that name (a link, an attr overlay) goes.
      const dstMount = this.namespace.tryMountFor(dst.virtual)
      await preOpsGate(
        this.policies,
        opName,
        dst,
        true,
        dstMount?.prefix ?? '',
        sessionId(),
        issuer,
      )
      requireTurfWritable(dstMount, dst)
      await this.namespace.unlink(dst.virtual)
      await this.namespace.rename(path.virtual, dst.virtual)
    } else if (opName === 'symlink') {
      target = String(kwargs.target)
      // symlink(2) refuses an occupied name, and the door is the only
      // place that can tell: the node table sees a link, and a probe
      // sees the file or directory a backend holds. Left unchecked, the
      // new node shadowed live data (the bytes stayed, the name read as
      // a link) and could bury a mount root, which is the one name a
      // deployment configured.
      if (await this.pathPresent(path, issuer)) throw eexist(path)
      await this.namespace.symlink(path.virtual, target, Date.now() / 1000)
    } else if (opName === 'stat') {
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
    record(
      opName,
      path.virtual,
      ResourceName.RAM,
      new TextEncoder().encode(target).byteLength,
      timer,
    )
    memoryAnswered(report)
    const bound = await postOpsGate(this.policies, opName, path, write, owner ?? '', result)
    if (bound !== null) return (await applyOpLimit(result, bound)) as string | null
    return result
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
    return (await this.pathPresent(path, issuer)) ? einval(path) : enoent(path)
  }

  /**
   * Whether anything at all is at `path`.
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
   * Cannot reuse `resolvePathStat`: that dispatches, and the door is
   * what dispatch is inside of. Mirrors Python's
   * Dispatcher._path_present.
   */
  private async pathPresent(path: PathSpec, issuer?: symbol): Promise<boolean> {
    if (this.namespace.isLink(path.virtual)) return true
    if (namespaceStat(this.namespace.mountPrefixes(), this.namespace, path.virtual) !== null) {
      return true
    }
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(path.virtual, false)
    } catch {
      // No mount serves the path and the namespace knows no structure
      // there, which is exactly the absence being probed for.
      return false
    }
    const mount = this.namespace.tryMountFor(path.virtual)
    if (mount !== null && normDir(mount.prefix) === normDir(path.virtual)) return true
    try {
      const row = (await this.probeOp('stat', resolved, issuer)) as FileStat | null
      if (row !== null && row.type !== FileType.DIRECTORY) return true
      return await this.listedByParent(path, issuer)
    } catch (err) {
      if (!(err instanceof PolicyDenied) && !(err instanceof PolicyError)) throw err
      // A channel that refuses to answer is not evidence of absence.
      // Reporting "present" keeps the answer at the EINVAL every miss
      // gave before the split, which asserts nothing the policy is
      // withholding; reporting absence would assert a fact this door was
      // not allowed to check.
      return true
    }
  }

  /**
   * Whether the path's own name is in its parent's listing.
   *
   * Compared on the final segment, because backends disagree on entry
   * shape: bare names, a trailing slash to mark a directory, or full
   * paths. The same normalization `mergeReaddir` dedupes on. Mirrors
   * Python's Dispatcher._listed_by_parent.
   */
  private async listedByParent(path: PathSpec, issuer?: symbol): Promise<boolean> {
    const trimmed = rstripSlash(path.virtual)
    const cut = trimmed.lastIndexOf('/')
    const name = trimmed.slice(cut + 1)
    if (cut < 0 || name === '') return false
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.namespace.resolve(trimmed.slice(0, cut) || '/', false)
    } catch {
      return false
    }
    const entries = await this.probeOp('readdir', resolved, issuer)
    if (!Array.isArray(entries)) return false
    return entries.some((entry) => {
      const segments = rstripSlash(String(entry)).split('/')
      return segments[segments.length - 1] === name
    })
  }

  /**
   * Run one read op for a probe, or null when it found nothing.
   *
   * The probe reads on the caller's behalf but not at its request, so it
   * passes the same admission gate the op would at the door: a policy
   * that denies `stat` must not be reachable through a readlink. That
   * refusal is raised, not swallowed, because only the caller knows what
   * to answer when a channel goes dark.
   *
   * The index and the path's filetype are the two kwargs that decide
   * which registered op answers, so a probe that omitted them would ask
   * a different question than the door does and report a rendered path
   * as absent. Python needs no twin of that half: its dispatcher routes
   * through `Mount.execute_op`, which stamps both itself.
   *
   * Args:
   *   opName: the op to run, `stat` or `readdir`.
   *   resolved: what the namespace resolved the path to.
   *   issuer: the mark on the op being served, carried to the probe's
   *     gate so the probe is judged as its caller's.
   */
  private async probeOp(
    opName: string,
    resolved: [Resource, PathSpec, MountMode],
    issuer?: symbol,
  ): Promise<unknown> {
    const [resource, scope] = resolved
    const mount = this.namespace.tryMountFor(scope.virtual)
    await preOpsGate(this.policies, opName, scope, false, mount?.prefix ?? '', sessionId(), issuer)
    await mount?.ensureReady()
    const filetype = getExtension(scope.virtual)
    try {
      const call = () =>
        this.opsRegistry.call(
          opName,
          resource,
          resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
          scope,
          [],
          {
            ...this.indexKwargs(mount),
            ...(filetype !== null ? { filetype } : {}),
          },
        )
      return await (mount === null ? call() : mount.use(call))
    } catch (err) {
      // The "nothing here" set exactly, plus a backend with no such op:
      // a miss on one channel is not absence on its own, so the caller
      // tries the other.
      if (isMissError(err) || isMissingOp(err, opName)) return null
      throw err
    }
  }

  /**
   * Apply attributes natively where the backend can, overlay the rest.
   *
   * A resource with a registered setattr op applies what it can and
   * returns the residual; residual fields go to the overlay and
   * natively applied ones are dropped from it, so a stale overlay never
   * shadows a fresh backend value. A resource without the op, and a
   * link path (which has no backend inode), overlay everything. The
   * overlay half is the door's own write, so it runs inside the same
   * gates as the native half. Mirrors Python's Dispatcher._apply_setattr.
   */
  private async applySetattr(
    resource: Resource,
    scope: PathSpec,
    p: PathSpec,
    kwargs: OpKwargs,
  ): Promise<Record<string, number | string>> {
    if (this.namespace.isLink(p.virtual) || this.opsRegistry.find('setattr', resource) === null) {
      return this.overlaySetattr(p, kwargs)
    }
    const raw = await this.opsRegistry.call(
      'setattr',
      resource,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      scope,
      [],
      kwargs,
    )
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
    record('setattr', p.virtual, ResourceName.RAM, 0, timer)
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

  async invalidateAfterWriteByPath(rawPath: string, observed: number | null = null): Promise<void> {
    // Directory writes (mkdir/rmdir via tree copies) arrive with a
    // trailing slash; normalize so the parent computation below does not
    // invalidate the written directory itself instead of its parent
    // (Python normalizes the same way via PathSpec.mount_path).
    const path = rstripSlash(rawPath) || '/'
    const mount = this.namespace.tryMountFor(path)
    if (mount === null) return
    await this.namespace.clearTimes(path, observed)
    // One manager for both halves, as Python's invalidate_after_write
    // does: it is what knows the file cache is keyed mount-absolute while
    // the index may not be, and evicting the index inline here spelled
    // the key the other way and missed.
    const manager =
      mount.cacheManager ??
      new CacheManager(
        this.cache,
        mount.resource.index ?? null,
        mount.prefix,
        cachesReads(mount.resource),
      )
    await manager.invalidateAfterWrite(path)
    await manager.invalidateAncestors(path)
  }

  // The file cache only holds paths for read-caching mounts, mirroring
  // Python's is_cacheable_path gate; without it every backend's reads
  // land in the cache and provision reports phantom cache hits.
  isCacheablePath = (path: string): boolean => {
    const mount = this.namespace.tryMountFor(path)
    if (mount === null) return false
    return !mount.retiring && cachesReads(mount.resource)
  }

  /** Bind deferred command results to the mounts that produced them. */
  captureCacheablePaths(): (path: string) => boolean {
    const mounts = new Map(
      this.namespace.mountPrefixes().map((p) => [p, this.namespace.mountFor(p)]),
    )
    return (path) => {
      const prefix = ownerPrefix(mounts.keys(), path)
      const original = prefix === null ? null : mounts.get(prefix)
      const mount = this.namespace.tryMountFor(path)
      return mount !== null && original === mount && !mount.retiring && cachesReads(mount.resource)
    }
  }

  async applyIo(
    io: IOResult,
    records?: readonly OpRecord[],
    isCacheable: (path: string) => boolean = this.isCacheablePath,
  ): Promise<void> {
    await applyIo(this.cache, io, isCacheable, records)
  }
}

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
import { applyOpLimit, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { getExtension } from '../../commands/resolve.ts'
import { IOResult, type OpReport } from '../../io/types.ts'
import { eacces, eaccesReadOnly, einval, enoent } from '../../utils/errors.ts'
import { Policies, postOpsGate, preOpsGate } from '../../policy/index.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { ownerPrefix, rstripSlash } from '../../utils/slash.ts'
import { record, runWithMountPrefix, runWithRevisions } from '../../observe/context.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import { type OpKwargs } from '../../ops/registry.ts'
import { NO_FOLLOW_OPS, STAMP_WRITE_OPS } from '../../ops/config.ts'
import { mergeReaddir, namespaceListing, namespaceStat } from '../../ops/namespace_view.ts'
import { isMissingPath } from '../../utils/errors.ts'
import { cachesReads, type Resource } from '../../resource/base.ts'
import { ConsistencyPolicy, FileStat, MountMode, PathSpec, ResourceName } from '../../types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import { mergeOverlayStat } from '../mount/namespace/overlay.ts'
import { Reconciler } from '../reconcile.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import {
  DISPATCH_READ_OPS,
  DISPATCH_WRITE_OPS,
  HIDDEN_CREATE_OPS,
  NAMESPACE_TABLE_OPS,
  POLICY_WRITE_OPS,
  SETATTR_KEYS,
} from './constants.ts'
import {
  assertMountAllowed,
  effectiveMountMode,
  MountNotAllowedError,
  pathAllowed,
} from '../../context/session_context.ts'

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
    // An unlink of a link is the removal half of `symlink`, and the door owns
    // both: a link has no backend entry, so forwarding it reaches a backend
    // that has never heard of the name and answers ENOENT with the link still
    // there. An unlink of anything else is an ordinary backend write.
    if (
      NAMESPACE_TABLE_OPS.has(opName) ||
      (opName === 'unlink' && this.namespace.isLink(path.virtual))
    ) {
      return [await this.namespaceTableOp(opName, path, kwargs ?? {}, report), new IOResult()]
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
        await preOpsGate(this.policies, opName, p, true, '')
        const stored = await this.overlaySetattr(p, kwargs ?? {})
        memoryAnswered(report)
        await postOpsGate(this.policies, opName, p, true, '', stored)
        return [stored, new IOResult()]
      }
      const eligible = isMissingPath(err) || err instanceof MountNotAllowedError
      let fallback = eligible ? this.namespaceResult(opName, p.virtual) : null
      if (fallback === null) throw err
      if (opName === 'readdir' && Array.isArray(fallback)) {
        fallback = visibleEntries(fallback, p.virtual)
      }
      const fallbackWrite = POLICY_WRITE_OPS.has(opName)
      await preOpsGate(this.policies, opName, p, fallbackWrite, '')
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
    const mountPrefix = mount.prefix
    // Admission policies fire at the door, before the warm-cache early
    // return below: a cached read must be refused exactly like a cold
    // one, or the cache becomes a policy bypass. This dispatcher is the
    // one door in TypeScript: shell internals, programmatic access, the
    // fs facade, and FUSE all end up here.
    const opWrite = POLICY_WRITE_OPS.has(opName)
    await preOpsGate(this.policies, opName, p, opWrite, mountPrefix)
    const caches = cachesReads(resource)
    // The file cache is keyed on the path alone, and what a command put
    // there is the rendered read. A raw read asks for a different value
    // under the same key, so it must not be served from that cache;
    // nothing populates it from here, so skipping the probe is the
    // whole fix. Mirrors Python's Dispatcher.dispatch.
    const raw = kwargs?.filetype === null
    if (caches && !raw && DISPATCH_READ_OPS.has(opName)) {
      const cached = await this.cache.get(p.virtual)
      if (cached !== null && (await this.reconciler.mayServeCached(mount, p.virtual))) {
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
    if (
      effectiveMountMode(mountPrefix, mode) === MountMode.READ &&
      this.opsRegistry.find(opName, resource.kind)?.write === true
    ) {
      throw eaccesReadOnly(`mount at '${p.virtual}' is read-only`, p)
    }
    // Ops registered under a rendered filetype (gdocs/gsheets/gslides/
    // gmail reads) resolve by the path's extension; Python reaches them
    // because its dispatcher routes through Mount.execute_op, which
    // stamps the filetype. Stamp it here the same way.
    const filetype = getExtension(p.virtual)
    const fullKwargs: OpKwargs = {
      ...(kwargs ?? {}),
      ...(kwargs?.index === undefined && resource.index !== undefined
        ? { index: resource.index }
        : {}),
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
      result = await runWithMountPrefix(rstripSlash(mountPrefix), () =>
        runWithRevisions(mount.revisions.size > 0 ? mount.revisions : null, async () =>
          runWithTimeout(
            Promise.resolve(
              opName === 'setattr'
                ? this.applySetattr(resource, scope, p, fullKwargs)
                : this.opsRegistry.call(
                    opName,
                    resource.kind,
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
      )
    } catch (err) {
      const fallback = isMissingPath(err) ? this.namespaceResult(opName, p.virtual) : null
      if (fallback === null) {
        await this.reconciler.onOpMissing(opName, p.virtual, err)
        throw err
      }
      result = fallback
      memoryAnswered(report)
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
   * Answer a node-table op at the door itself, gated like a backend.
   *
   * A symlink is namespace state with no backend behind it, so the door
   * owns both directions. Admission still fires exactly as for a
   * backend write: the link's turf is the longest mount prefix above it
   * (the same ownership rule the link read filter uses), session grants
   * and both gates run, and the write leaves an OpRecord — a scoped
   * kernel mount refuses exactly like a scoped shell. A link above
   * every mount is bare namespace structure and clears the gates with
   * an empty prefix. Also answers the `unlink` of a path the node table holds
   * a link for. Mirrors Python's Dispatcher._namespace_table_op.
   */
  private async namespaceTableOp(
    opName: string,
    path: PathSpec,
    kwargs: OpKwargs,
    report: OpReport | undefined,
  ): Promise<string | null> {
    const start = performance.now()
    const owner = ownerPrefix(this.namespace.mountPrefixes(), path.virtual)
    if (owner !== null) assertMountAllowed(owner)
    const write = POLICY_WRITE_OPS.has(opName)
    await preOpsGate(this.policies, opName, path, write, owner ?? '')
    let target: string
    let result: string | null
    if (opName === 'unlink') {
      target = this.namespace.readlink(path.virtual) ?? ''
      await this.namespace.unlink(path.virtual)
      result = null
    } else if (opName === 'symlink') {
      target = String(kwargs.target)
      await this.namespace.symlink(path.virtual, target, Date.now() / 1000)
      result = null
    } else {
      const found = this.namespace.readlink(path.virtual)
      if (found === null) throw einval(path)
      target = found
      result = found
    }
    record(
      opName,
      path.virtual,
      ResourceName.RAM,
      new TextEncoder().encode(target).byteLength,
      start,
    )
    memoryAnswered(report)
    const bound = await postOpsGate(this.policies, opName, path, write, owner ?? '', result)
    if (bound !== null) return (await applyOpLimit(result, bound)) as string | null
    return result
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
    if (
      this.namespace.isLink(p.virtual) ||
      this.opsRegistry.find('setattr', resource.kind) === null
    ) {
      return this.overlaySetattr(p, kwargs)
    }
    const raw = await this.opsRegistry.call(
      'setattr',
      resource.kind,
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
    const start = performance.now()
    const overlay: Record<string, number | string> = {}
    for (const key of SETATTR_KEYS) {
      const value = kwargs[key]
      if (value !== undefined && value !== null) overlay[key] = value as number | string
    }
    await this.writeOverlay(p.virtual, overlay)
    record('setattr', p.virtual, ResourceName.RAM, 0, start)
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
    if (cachesReads(mount.resource)) {
      await this.cache.remove(path)
    }
    const idx = mount.resource.index
    if (idx !== undefined) {
      const slash = path.lastIndexOf('/')
      const parent = slash <= 0 ? '/' : path.slice(0, slash)
      await idx.invalidateDir(parent)
      await idx.invalidateDir(parent + '/')
    }
  }

  // The file cache only holds paths for read-caching mounts, mirroring
  // Python's is_cacheable_path gate; without it every backend's reads
  // land in the cache and provision reports phantom cache hits.
  isCacheablePath = (path: string): boolean => {
    const mount = this.namespace.tryMountFor(path)
    if (mount === null) return false
    return cachesReads(mount.resource)
  }

  async applyIo(io: IOResult, records?: readonly OpRecord[]): Promise<void> {
    await applyIo(this.cache, io, this.isCacheablePath, records)
  }
}

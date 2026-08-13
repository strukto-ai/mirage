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

import { NOOPAccessor } from '../accessor/base.ts'
import { applyIo } from '../cache/file/io.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import { applyOpLimit, runWithTimeout } from '../commands/builtin/utils/limit.ts'
import { getExtension } from '../commands/resolve.ts'
import { IOResult, type OpReport } from '../io/types.ts'
import { eaccesReadOnly } from '../utils/errors.ts'
import { Policies, postOpsGate, preOpsGate } from '../policy/index.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import { runWithMountPrefix, runWithRevisions } from '../observe/context.ts'
import type { OpRecord } from '../observe/record.ts'
import type { OpsRegistry } from '../ops/registry.ts'
import { type OpKwargs } from '../ops/registry.ts'
import { NO_FOLLOW_OPS, STAMP_WRITE_OPS } from '../ops/config.ts'
import { mergeReaddir, namespaceListing, namespaceStat } from '../ops/namespace_view.ts'
import { isMissingPath } from '../utils/errors.ts'
import { cachesReads, type Resource } from '../resource/base.ts'
import { ConsistencyPolicy, FileStat, MountMode, PathSpec, ResourceName } from '../types.ts'
import type { DispatchFn } from '../runtime/types.ts'
import type { DriftQueue } from './snapshot/drift.ts'
import type { Namespace } from './mount/namespace/namespace.ts'
import { mergeOverlayStat } from './mount/namespace/overlay.ts'
import { Reconciler } from './reconcile.ts'
import { sliceWindow } from '../utils/ranges.ts'
import { effectiveMountMode, MountNotAllowedError } from '../context/session_context.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()
const DISPATCH_READ_OPS = new Set(['read', 'read_bytes'])

/** The byte window a read asked for, whole file when it asked none. */
function readWindow(kwargs: OpKwargs | undefined): [number, number | null] {
  return [
    typeof kwargs?.offset === 'number' ? kwargs.offset : 0,
    typeof kwargs?.size === 'number' ? kwargs.size : null,
  ]
}
const DISPATCH_WRITE_OPS = new Set([
  'write',
  'write_bytes',
  'append',
  'unlink',
  'create',
  'truncate',
  'mkdir',
  'rmdir',
  'rename',
])
// setattr mutates the mount but keeps its own overlay bookkeeping in
// the metadata builtin, so it is a write for policy admission without
// joining the dispatcher's post-write invalidation path.
const POLICY_WRITE_OPS = new Set([...DISPATCH_WRITE_OPS, 'setattr'])

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
    let p = path
    if (!NO_FOLLOW_OPS.has(opName)) {
      const followed = this.namespace.follow(path.virtual)
      if (followed !== path.virtual) p = PathSpec.fromStrPath(followed)
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
      const eligible = isMissingPath(err) || err instanceof MountNotAllowedError
      const fallback = eligible ? this.namespaceResult(opName, p.virtual) : null
      if (fallback === null) throw err
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
    const mount = this.namespace.mountFor(p.virtual)
    const mountPrefix = mount?.prefix ?? '/'
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
    if (caches && !raw && mount !== null && DISPATCH_READ_OPS.has(opName)) {
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
    const opOverride = mount?.commandLimits.get(opName) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    let result
    // Backends name their records against the mount-relative key, so the
    // prefix has to be active while the op runs or the record loses the
    // mount it belongs to. Mirrors Python's Ops._call.
    try {
      result = await runWithMountPrefix(rstripSlash(mountPrefix), () =>
        runWithRevisions(
          mount !== null && mount.revisions.size > 0 ? mount.revisions : null,
          async () =>
            runWithTimeout(
              Promise.resolve(
                this.opsRegistry.call(
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
      result = mergeReaddir(result, this.namespace.mountPrefixes(), this.namespace, p.virtual)
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
    const mount = this.namespace.mountFor(path)
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
    const mount = this.namespace.mountFor(path)
    if (mount === null) return false
    return cachesReads(mount.resource)
  }

  async applyIo(io: IOResult, records?: readonly OpRecord[]): Promise<void> {
    await applyIo(this.cache, io, this.isCacheablePath, records)
  }
}

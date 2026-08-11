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
import { IOResult } from '../io/types.ts'
import { eaccesReadOnly } from '../utils/errors.ts'
import { Policies, PolicyDenied, postOpsGate, preOpsGate } from '../policy/index.ts'
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
import type { DispatchFn } from './executor/cross_mount.ts'
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

export class Dispatcher {
  private readonly namespace: Namespace
  private readonly cache: FileCache & Resource
  private readonly opsRegistry: OpsRegistry
  private readonly policies: Policies
  readonly reconciler: Reconciler

  constructor(
    namespace: Namespace,
    cache: FileCache & Resource,
    opsRegistry: OpsRegistry,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    policies?: Policies,
  ) {
    this.namespace = namespace
    this.cache = cache
    this.opsRegistry = opsRegistry
    this.policies = policies ?? new Policies()
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

  dispatch: DispatchFn = async (opName, path, args, kwargs) => {
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
      const fallbackBound = await postOpsGate(this.policies, opName, p, fallbackWrite, '', fallback)
      const gated = fallbackBound !== null ? await applyOpLimit(fallback, fallbackBound) : fallback
      // A synthetic namespace answer (a directory that exists only
      // because a mount or a link sits below it) contacts nothing, so
      // attributing it to the mount that lexically owns the path would
      // invent a network op against that backend.
      return [gated, new IOResult({ opSource: ResourceName.RAM })]
    }
    const [resource, scope, mode] = resolved
    const mount = this.namespace.mountFor(p.virtual)
    const mountPrefix = mount?.prefix ?? '/'
    // Admission policies fire at the door, before the warm-cache early
    // return below: a cached read must be refused exactly like a cold
    // one, or the cache becomes a policy bypass. This dispatcher is the
    // one door in TypeScript: shell internals, programmatic access, and
    // FUSE all route through Workspace.dispatch.
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
        let warmBound
        try {
          warmBound = await postOpsGate(this.policies, opName, p, opWrite, mountPrefix, window)
        } catch (err) {
          // Nothing crossed the network, and the caller cannot tell from
          // the exception alone: without this a denied warm read is
          // recorded against the backend and counted as traffic that
          // never happened.
          if (err instanceof PolicyDenied) err.fromCache = true
          throw err
        }
        const moved = window.byteLength
        const served =
          warmBound !== null ? ((await applyOpLimit(window, warmBound)) as Uint8Array) : window
        return [
          served,
          new IOResult({
            reads: { [p.virtual]: served },
            opSource: ResourceName.RAM,
            opBytes: moved,
          }),
        ]
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
    if (bound === null) return [result, new IOResult()]
    // The transfer already happened, so the limit changes what the
    // caller receives, not what the backend moved. Report both.
    const moved = result instanceof Uint8Array ? result.byteLength : null
    result = await applyOpLimit(result, bound)
    return [result, new IOResult({ opBytes: moved })]
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

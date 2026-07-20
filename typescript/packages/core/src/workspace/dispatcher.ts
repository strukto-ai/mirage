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
import { applyOpSafeguard, runWithTimeout } from '../commands/builtin/utils/safeguard.ts'
import { getExtension } from '../commands/resolve.ts'
import { IOResult } from '../io/types.ts'
import { eaccesReadOnly } from '../utils/errors.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import { runWithRevisions } from '../observe/context.ts'
import type { OpRecord } from '../observe/record.ts'
import type { OpsRegistry } from '../ops/registry.ts'
import { type OpKwargs } from '../ops/registry.ts'
import { NO_FOLLOW_OPS } from '../ops/config.ts'
import { cachesReads, type Resource } from '../resource/base.ts'
import { ConsistencyPolicy, FileStat, MountMode, PathSpec } from '../types.ts'
import type { DispatchFn } from './executor/cross_mount.ts'
import type { Namespace } from './mount/namespace/namespace.ts'
import { mergeOverlayStat } from './mount/namespace/overlay.ts'
import { Reconciler } from './reconcile.ts'
import { effectiveMountMode } from '../context/session_context.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()
const DISPATCH_READ_OPS = new Set(['read', 'read_bytes'])
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

export type ResolveFn = (path: string) => Promise<[Resource, PathSpec, MountMode]>

export class Dispatcher {
  private readonly namespace: Namespace
  private readonly cache: FileCache & Resource
  private readonly opsRegistry: OpsRegistry
  readonly reconciler: Reconciler

  constructor(
    namespace: Namespace,
    cache: FileCache & Resource,
    opsRegistry: OpsRegistry,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
  ) {
    this.namespace = namespace
    this.cache = cache
    this.opsRegistry = opsRegistry
    this.reconciler = new Reconciler(cache, namespace, opsRegistry, consistency)
  }

  dispatch: DispatchFn = async (opName, path, args, kwargs) => {
    let p = path
    if (!NO_FOLLOW_OPS.has(opName)) {
      const followed = this.namespace.follow(path.virtual)
      if (followed !== path.virtual) p = PathSpec.fromStrPath(followed)
    }
    const [resource, scope, mode] = await this.namespace.resolve(p.virtual, false)
    const mount = this.namespace.mountFor(p.virtual)
    const caches = cachesReads(resource)
    if (caches && mount !== null && DISPATCH_READ_OPS.has(opName)) {
      const cached = await this.cache.get(p.virtual)
      if (cached !== null && (await this.reconciler.mayServeCached(mount, p.virtual))) {
        return [cached, new IOResult({ reads: { [p.virtual]: cached } })]
      }
    }
    const mountPrefix = mount?.prefix ?? '/'
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
    // Per-op command safeguards bind to the executing (post-follow)
    // mount, and the timeout window covers only the backend op — cache
    // probes and post-write invalidation stay outside the budget —
    // mirroring Python's Mount.execute_op.
    const opOverride = mount?.commandSafeguards.get(opName) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    let result
    try {
      result = await runWithRevisions(
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
      )
    } catch (err) {
      await this.reconciler.onOpMissing(opName, p.virtual, err)
      throw err
    }
    result = await applyOpSafeguard(result, opOverride)
    if (DISPATCH_WRITE_OPS.has(opName)) {
      await this.invalidateAfterWriteByPath(p.virtual)
      if (renameDst !== null) {
        await this.invalidateAfterWriteByPath(renameDst.virtual)
      }
    }
    if (opName === 'stat' && result instanceof FileStat) {
      return [mergeOverlayStat(this.namespace.metaFor(p.virtual), result), new IOResult()]
    }
    return [result, new IOResult()]
  }

  async invalidateAfterWriteByPath(rawPath: string): Promise<void> {
    // Directory writes (mkdir/rmdir via tree copies) arrive with a
    // trailing slash; normalize so the parent computation below does not
    // invalidate the written directory itself instead of its parent
    // (Python normalizes the same way via PathSpec.mount_path).
    const path = rstripSlash(rawPath) || '/'
    const mount = this.namespace.mountFor(path)
    if (mount === null) return
    await this.namespace.clearTimes(path)
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

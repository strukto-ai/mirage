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
import { IOResult } from '../io/types.ts'
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
])

export type ResolveFn = (path: string) => Promise<[Resource, PathSpec, MountMode]>

export class Dispatcher {
  private readonly namespace: Namespace
  private readonly cache: FileCache & Resource
  private readonly opsRegistry: OpsRegistry
  private readonly consistency: ConsistencyPolicy

  constructor(
    namespace: Namespace,
    cache: FileCache & Resource,
    opsRegistry: OpsRegistry,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
  ) {
    this.namespace = namespace
    this.cache = cache
    this.opsRegistry = opsRegistry
    this.consistency = consistency
  }

  dispatch: DispatchFn = async (opName, path, args, kwargs) => {
    let p = path
    if (!NO_FOLLOW_OPS.has(opName)) {
      const followed = this.namespace.follow(path.virtual)
      if (followed !== path.virtual) p = PathSpec.fromStrPath(followed)
    }
    const [resource, scope, mode] = await this.namespace.resolve(p.virtual, false)
    const caches = cachesReads(resource)
    if (caches && DISPATCH_READ_OPS.has(opName)) {
      let cached = await this.cache.get(p.virtual)
      if (
        cached !== null &&
        this.consistency === ConsistencyPolicy.ALWAYS &&
        resource.fingerprint !== undefined
      ) {
        let remoteFp: string | null = null
        try {
          remoteFp = await resource.fingerprint(scope)
        } catch {
          remoteFp = null
        }
        if (remoteFp !== null && !(await this.cache.isFresh(p.virtual, remoteFp))) {
          await this.cache.remove(p.virtual)
          cached = null
        }
      }
      if (cached !== null) {
        return [cached, new IOResult({ reads: { [p.virtual]: cached } })]
      }
    }
    const mountPrefix = this.namespace.mountFor(p.virtual)?.prefix ?? '/'
    if (
      effectiveMountMode(mountPrefix, mode) === MountMode.READ &&
      this.opsRegistry.find(opName, resource.kind)?.write === true
    ) {
      throw new Error(`mount at '${p.virtual}' is read-only`)
    }
    const fullKwargs: OpKwargs =
      kwargs?.index === undefined && resource.index !== undefined
        ? { ...(kwargs ?? {}), index: resource.index }
        : (kwargs ?? {})
    const mount = this.namespace.mountFor(p.virtual)
    const result = await runWithRevisions(
      mount !== null && mount.revisions.size > 0 ? mount.revisions : null,
      async () =>
        this.opsRegistry.call(
          opName,
          resource.kind,
          resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
          scope,
          args ?? [],
          fullKwargs,
        ),
    )
    if (DISPATCH_WRITE_OPS.has(opName)) {
      await this.invalidateAfterWriteByPath(p.virtual)
    }
    if (opName === 'stat' && result instanceof FileStat) {
      return [mergeOverlayStat(this.namespace.metaFor(p.virtual), result), new IOResult()]
    }
    return [result, new IOResult()]
  }

  async invalidateAfterWriteByPath(path: string): Promise<void> {
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

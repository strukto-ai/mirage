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

import type { Accessor } from '../accessor/base.ts'
import { IndexType, type IndexConfig, type RedisIndexConfig } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { RedisIndexCacheStore } from '../cache/index/redis.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { PredNode } from '../commands/builtin/findEval.ts'
import type { RegisteredCommand } from '../commands/config.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import type { CapacityResult, FileStat, PathSpec } from '../types.ts'
import { CapacityState } from '../types.ts'

export interface FindOptions {
  name?: string | null
  type?: 'f' | 'd' | null
  minSize?: number | null
  maxSize?: number | null
  maxDepth?: number | null
  minDepth?: number | null
  nameExclude?: string | null
  orNames?: string[] | null
  iname?: string | null
  pathPattern?: string | null
  empty?: boolean | null
  tree?: PredNode | null
  mtimeMin?: number | null
  mtimeMax?: number | null
}

export interface Resource {
  readonly kind: string
  readonly prompt?: string
  readonly writePrompt?: string
  readonly indexTtl?: number
  /**
   * Whether reads of this resource may be served from / written to the
   * local file cache. Defaults to false. A network-backed resource whose
   * content is read-mostly (e.g. object storage) sets this to true so
   * reads can be cached; a resource whose content is live (e.g. a
   * database collection) leaves it false so reads always hit the backend
   * and live follows (`tail -f`) are not masked by a cached snapshot.
   */
  readonly cachesReads?: boolean
  /**
   * Whether this resource carries enough version information for
   * snapshot+replay drift detection. When true, the resource's
   * {@link Resource.stat} must populate {@link FileStat.fingerprint}
   * (and optionally {@link FileStat.revision}) with stable per-path
   * markers. When false (the default), reads are treated as live-only
   * at replay time: no fingerprint is captured at snapshot, no drift
   * check fires at load.
   */
  readonly supportsSnapshot?: boolean
  readonly index?: IndexCacheStore
  readonly accessor?: Accessor
  readonly opsMap?: Record<string, unknown>
  setIndex?(config?: IndexConfig): void
  open(): Promise<void>
  close(): Promise<void>
  ops?(): readonly RegisteredOp[]
  commands?(): readonly RegisteredCommand[]

  streamPath?(path: PathSpec): AsyncIterable<Uint8Array>
  readFile?(path: PathSpec): Promise<Uint8Array>
  writeFile?(path: PathSpec, data: Uint8Array): Promise<void>
  appendFile?(path: PathSpec, data: Uint8Array): Promise<void>
  readdir?(path: PathSpec): Promise<string[]>
  stat?(path: PathSpec): Promise<FileStat>
  exists?(path: PathSpec): Promise<boolean>
  mkdir?(path: PathSpec, options?: { recursive?: boolean }): Promise<void>
  rmdir?(path: PathSpec): Promise<void>
  unlink?(path: PathSpec): Promise<void>
  rename?(src: PathSpec, dst: PathSpec): Promise<void>
  truncate?(path: PathSpec, length: number): Promise<void>
  copy?(src: PathSpec, dst: PathSpec): Promise<void>
  rmR?(path: PathSpec): Promise<void>
  du?(path: PathSpec): Promise<number>
  find?(path: PathSpec, options?: FindOptions): Promise<string[]>
  glob?(paths: readonly PathSpec[], prefix?: string): Promise<PathSpec[]>
  // Capacity for df. Absent -> treated as UNKNOWN (rendered `-`). Implement
  // only where a truthful number exists (a real filesystem, or a provider
  // quota); never fabricate a total.
  statfs?(): Promise<CapacityResult>
}

export function throwUnsupported(op: string): never {
  throw new Error(`resource has no ${op} support`)
}

export function cachesReads(resource: Resource): boolean {
  return resource.cachesReads === true
}

export abstract class BaseResource {
  readonly indexTtl: number = 600
  protected _index?: IndexCacheStore

  get index(): IndexCacheStore {
    let store = this._index
    if (store === undefined) {
      store = this.makeIndex()
      this._index = store
    }
    return store
  }

  setIndex(config?: IndexConfig): void {
    this._index = this.makeIndex(config)
  }

  private makeIndex(config?: IndexConfig): IndexCacheStore {
    if (config?.type === IndexType.REDIS) {
      const redis = config as RedisIndexConfig
      return new RedisIndexCacheStore({
        ttl: redis.ttl ?? 600,
        ...(redis.url !== undefined ? { url: redis.url } : {}),
        ...(redis.keyPrefix !== undefined ? { keyPrefix: redis.keyPrefix } : {}),
      })
    }
    const ttl = config === undefined ? this.indexTtl : (config.ttl ?? 600)
    return new RAMIndexCacheStore({ ttl })
  }

  // Default df capacity: UNKNOWN (rendered `-`). Backends that can report
  // truthfully — a real filesystem, or a provider quota — override this.
  statfs(): Promise<CapacityResult> {
    return Promise.resolve({ state: CapacityState.UNKNOWN })
  }
}

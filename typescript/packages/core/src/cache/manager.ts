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

import { PathSpec } from '../types.ts'
import { rstripSlash } from '../utils/slash.ts'
import type { FileCache } from './file/mixin.ts'
import type { IndexCacheStore } from './index/store.ts'

/**
 * Post-mutation cache coherence for one mount.
 *
 * A backend mutation has two cache consequences: the file-cache entry
 * for the path is stale, and the parent directory listing in the index
 * cache (including negative knowledge that the path does not exist) is
 * stale. This class discharges both, synchronously, at the mutation
 * site: core backend mutators report through `cache/context.ts` so
 * invalidation happens before the next command in a pipeline runs
 * instead of after the whole command tree.
 */
export class CacheManager {
  private readonly fileCache: FileCache | null
  private readonly index: IndexCacheStore | null
  private readonly prefix: string
  private readonly cachesReads: boolean

  constructor(
    fileCache: FileCache | null,
    index: IndexCacheStore | null,
    prefix: string,
    cachesReads: boolean,
  ) {
    this.fileCache = fileCache
    this.index = index
    this.prefix = rstripSlash(prefix)
    this.cachesReads = cachesReads
  }

  private virtual(path: string | PathSpec): string {
    let p = path instanceof PathSpec ? path.mountPath : path
    if (!p.startsWith('/')) p = '/' + p
    if (this.prefix !== '' && !p.startsWith(this.prefix)) {
      return this.prefix + p
    }
    return p
  }

  /**
   * Return cached bytes for `path` if present, else null.
   *
   * Lookup only, never fetches from the backend. The single read-cache
   * check the shared read-through wrappers (`cache/read_through.ts`) read
   * through, so warm reads are served from the file cache without the
   * command knowing about it. No-op for local or non-caching mounts.
   */
  async cachedBytes(path: PathSpec): Promise<Uint8Array | null> {
    if (!this.cachesReads || this.fileCache === null) return null
    const virtual = this.virtual(path)
    if (await this.fileCache.exists(virtual)) {
      return this.fileCache.get(virtual)
    }
    return null
  }

  /** Invalidate caches after a write to `path` (resource-relative). */
  async invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    const virtual = this.virtual(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(virtual)
    }
    await this.invalidateParent(virtual)
  }

  /** Invalidate caches after a deletion of `path` (resource-relative). */
  async invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    const virtual = this.virtual(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(virtual)
    }
    if (this.index !== null) {
      await this.index.invalidateDir(virtual)
      await this.index.invalidateDir(virtual + '/')
    }
    await this.invalidateParent(virtual)
  }

  private async invalidateParent(virtual: string): Promise<void> {
    if (this.index === null) return
    const lastSlash = virtual.lastIndexOf('/')
    const parent = lastSlash > 0 ? virtual.slice(0, lastSlash) : '/'
    await this.index.invalidateDir(parent)
    await this.index.invalidateDir(parent + '/')
  }
}

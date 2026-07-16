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

import type { FileCache } from '../cache/file/mixin.ts'
import type { Resource } from '../resource/base.ts'
import { ConsistencyPolicy, type PathSpec } from '../types.ts'
import type { Namespace } from './mount/namespace/namespace.ts'

const REVALIDATE_OPS = new Set(['read', 'read_bytes', 'stat'])

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown }).code === 'ENOENT'
}

/**
 * Keep the local view honest against backend truth.
 *
 * Owns the single reconcile concern the dispatcher used to smear across its
 * hot path: under ALWAYS consistency, a re-check detects when a cached entry
 * is stale (fingerprint mismatch) or gone (deletion). One deletion signal
 * feeds both consumers with separate reactions: the file cache evicts and the
 * namespace GCs any orphaned attribute overlay. Reconcile state follows each
 * consumer's store (RAM local, Redis shared across runtimes), so this is a
 * thin coordinator holding references, not config.
 */
export class Reconciler {
  private readonly cache: FileCache & Resource
  private readonly namespace: Namespace
  private readonly consistency: ConsistencyPolicy

  constructor(
    cache: FileCache & Resource,
    namespace: Namespace,
    consistency: ConsistencyPolicy,
  ) {
    this.cache = cache
    this.namespace = namespace
    this.consistency = consistency
  }

  // Gate a cached read: is the cached copy still valid to serve? Under LAZY
  // the cache is trusted. Under ALWAYS the backend fingerprint is re-checked:
  // a mismatch evicts (return false, fall back to a real read); a missing path
  // GCs and re-throws. A transient fingerprint error serves the cache.
  async mayServeCached(resource: Resource, scope: PathSpec, path: string): Promise<boolean> {
    if (this.consistency !== ConsistencyPolicy.ALWAYS) return true
    if (resource.fingerprint === undefined) return true
    let remoteFp: string | null = null
    try {
      remoteFp = await resource.fingerprint(scope)
    } catch (err) {
      if (isEnoent(err)) {
        await this.onMissing(path)
        throw err
      }
      return true
    }
    if (remoteFp !== null && !(await this.cache.isFresh(path, remoteFp))) {
      await this.cache.remove(path)
      return false
    }
    return true
  }

  // React to a read/stat op that the backend reported gone (ENOENT).
  async onOpMissing(opName: string, path: string, err: unknown): Promise<void> {
    if (
      this.consistency === ConsistencyPolicy.ALWAYS &&
      REVALIDATE_OPS.has(opName) &&
      isEnoent(err)
    ) {
      await this.onMissing(path)
    }
  }

  // Apply the deletion reaction: evict cache + GC orphaned overlay. An
  // authoritative symlink node is left intact (dropOverlay skips it).
  private async onMissing(path: string): Promise<void> {
    await this.cache.remove(path)
    await this.namespace.dropOverlay(path)
  }
}

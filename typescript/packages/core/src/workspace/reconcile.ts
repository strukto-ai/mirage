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
import type { FileCache } from '../cache/file/mixin.ts'
import type { OpsRegistry } from '../ops/registry.ts'
import type { Resource } from '../resource/base.ts'
import { ConsistencyPolicy, FileStat, PathSpec } from '../types.ts'
import { enoent } from '../utils/errors.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import type { MountEntry } from './mount/mount.ts'
import type { Namespace } from './mount/namespace/namespace.ts'

const NOOP_ACCESSOR = new NOOPAccessor()
const REVALIDATE_OPS = new Set(['read', 'read_bytes', 'stat'])

enum Verdict {
  FRESH = 'fresh',
  STALE = 'stale',
  GONE = 'gone',
  UNKNOWN = 'unknown',
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown }).code === 'ENOENT'
}

/**
 * Keep the local view honest against backend truth.
 *
 * The single reconcile point every read path shares. Under ALWAYS a backend
 * re-stat classifies a path as fresh, stale (fingerprint mismatch), gone
 * (deletion), or unknown (no fingerprint to compare). One deletion signal
 * feeds both consumers with separate reactions: the file cache evicts and the
 * namespace GCs any orphaned attribute overlay.
 *
 * Three read paths call in: the dispatcher's cached-read gate
 * (mayServeCached) and its main-op catch (onOpMissing) for cross-mount and
 * programmatic reads, and the mount registry's per-command reconcile
 * (reconcileRead) for single-mount shell reads. The re-stat goes through the
 * ops registry (not mount.executeOp, whose op set omits stat). Reconcile
 * state follows each consumer's store (RAM local, Redis shared across
 * runtimes), so this is a thin coordinator holding references, not config.
 */
export class Reconciler {
  private readonly cache: FileCache & Resource
  private readonly namespace: Namespace
  private readonly opsRegistry: OpsRegistry
  private readonly consistency: ConsistencyPolicy

  constructor(
    cache: FileCache & Resource,
    namespace: Namespace,
    opsRegistry: OpsRegistry,
    consistency: ConsistencyPolicy,
  ) {
    this.cache = cache
    this.namespace = namespace
    this.opsRegistry = opsRegistry
    this.consistency = consistency
  }

  // Re-stat the backend and apply the matching cache/overlay reaction. A
  // missing path GCs (evict cache + drop overlay); a fingerprint mismatch
  // evicts the stale cache entry. Non-ENOENT errors propagate.
  private async probe(mount: MountEntry, path: string): Promise<Verdict> {
    const resource = mount.resource
    const lastSlash = path.lastIndexOf('/')
    const scope = new PathSpec({
      virtual: path,
      directory: lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/',
      resourcePath: mountKey(path, rstripSlash(mount.prefix)),
    })
    let remoteStat: unknown
    try {
      remoteStat = await this.opsRegistry.call(
        'stat',
        resource.kind,
        resource.accessor ?? NOOP_ACCESSOR,
        scope,
      )
    } catch (err) {
      if (isEnoent(err)) {
        await this.onMissing(path)
        return Verdict.GONE
      }
      throw err
    }
    const fp = remoteStat instanceof FileStat ? remoteStat.fingerprint : null
    if (fp === null) return Verdict.UNKNOWN
    if (!(await this.cache.isFresh(path, fp))) {
      await this.cache.remove(path)
      return Verdict.STALE
    }
    return Verdict.FRESH
  }

  // Gate a cached read: is the cached copy still valid to serve? Under LAZY
  // the cache is trusted. Under ALWAYS: a backend that carries a fingerprint
  // is re-stated and served only when fresh (a mismatch evicts, a missing
  // path GCs and re-throws); a backend with no fingerprint cannot be cheaply
  // verified, so the cached copy is dropped and the caller re-reads (the
  // fresh read also surfaces a remote delete via its own ENOENT).
  async mayServeCached(mount: MountEntry, path: string): Promise<boolean> {
    if (this.consistency !== ConsistencyPolicy.ALWAYS) return true
    if (mount.resource.supportsSnapshot !== true) {
      await this.cache.remove(path)
      return false
    }
    const verdict = await this.probe(mount, path)
    if (verdict === Verdict.GONE) throw enoent(path)
    return verdict !== Verdict.STALE
  }

  // Reconcile a single-mount shell read before the command runs.
  // cat/ls/stat on one mount resolve here (not through the dispatcher), so
  // this is where their reads reconcile against backend truth. Only paths
  // that carry an overlay or a cached copy are probed (a plain read pays
  // nothing); a remote delete then evicts the cache AND GCs the orphaned
  // overlay, and a stale entry is dropped. Best-effort: a transient probe
  // error is swallowed so the command still runs.
  async reconcileRead(mount: MountEntry, path: string): Promise<void> {
    if (this.consistency !== ConsistencyPolicy.ALWAYS) return
    if (this.namespace.metaFor(path) === null && !(await this.cache.exists(path))) return
    try {
      await this.probe(mount, path)
    } catch {
      // transient probe error: let the command read the backend directly
    }
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

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

import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { NOOPAccessor } from '../accessor/base.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import type { OpsRegistry } from '../ops/registry.ts'
import type { VFS } from '../vfs/base.ts'
import { ConsistencyPolicy, FileStat, PathSpec } from '../types.ts'
import { enoent, isEnoent, isMissingOp } from '../utils/errors.ts'
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

/**
 * Keep the local view honest against backend truth.
 *
 * The single reconcile point every read path shares. Under ALWAYS a backend
 * re-stat classifies a path as fresh, stale (fingerprint mismatch), gone
 * (deletion), or unknown (no fingerprint to compare). One deletion signal
 * feeds both consumers with separate reactions: the file cache evicts and the
 * namespace GCs any orphaned attribute overlay.
 *
 * Three read paths call in: the cached-read gate (mayServeCached), which the
 * dispatcher and the file cache's own door both run, its main-op catch
 * (onOpMissing) for cross-mount and programmatic reads, and the mount
 * registry's per-command reconcile (reconcileRead) for single-mount shell
 * reads. The re-stat goes through the ops registry (not mount.executeOp,
 * whose op set omits stat). Reconcile state follows each consumer's store
 * (RAM local, Redis shared across runtimes), so this is a thin coordinator
 * holding references, not config.
 *
 * The gate and reconcileRead divide the work rather than duplicating it: the
 * gate owns the freshness of cached *bytes*, wherever they are served from,
 * and reconcileRead owns orphaned-overlay GC plus the metadata freshness of
 * commands that never read bytes at all (ls, stat, du, find).
 */
export class Reconciler {
  private readonly cache: FileCache & VFS
  private readonly namespace: Namespace
  private readonly opsRegistry: OpsRegistry
  private readonly consistency: ConsistencyPolicy

  constructor(
    cache: FileCache & VFS,
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
    const vfs = mount.vfs
    const lastSlash = path.lastIndexOf('/')
    const scope = new PathSpec({
      virtual: path,
      directory: lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/',
      vfsPath: mountKey(path, rstripSlash(mount.prefix)),
    })
    let remoteStat: unknown
    try {
      remoteStat = await this.opsRegistry.call(
        'stat',
        vfs,
        vfs.accessor ?? NOOP_ACCESSOR,
        scope,
        [],
        { index: new RAMIndexCacheStore() },
      )
    } catch (err) {
      if (isEnoent(err)) {
        await this.onMissing(path)
        await mount.index?.clear()
        return Verdict.GONE
      }
      // A backend that registers no stat op cannot be revalidated at all.
      // probeOrUnknown would reach the same verdict, but it would also log
      // every read: this is a permanent capability of the mount, not an
      // anomaly worth a warning each time. isMissingOp, not a bare ENOTSUP
      // check: python catches OperationNotSupportedError, which only the op
      // door raises, and `stat` is the only op probed here -- so a backend
      // that stamps ENOTSUP itself takes the logged path on both sides.
      if (isMissingOp(err, 'stat')) {
        await this.cache.remove(path)
        await mount.index?.clear()
        return Verdict.UNKNOWN
      }
      throw err
    }
    const fp = remoteStat instanceof FileStat ? remoteStat.fingerprint : null
    if (fp === null) {
      await this.cache.remove(path)
      await mount.index?.clear()
      return Verdict.UNKNOWN
    }
    if (!(await this.cache.isFresh(path, fp))) {
      await this.cache.remove(path)
      await mount.index?.clear()
      return Verdict.STALE
    }
    return Verdict.FRESH
  }

  // Probe, treating a failed probe as "cannot verify". A backend that cannot
  // answer right now is the same situation as one that answers without a
  // fingerprint: the copy cannot be verified, so it is dropped and the caller
  // reads cold. Throwing instead would be strictly worse -- it serves nothing
  // and protects nothing further, and inside a recursive walk one transient
  // stat would abort the whole traversal rather than the one file.
  private async probeOrUnknown(mount: MountEntry, path: string): Promise<Verdict> {
    try {
      return await this.probe(mount, path)
    } catch (err) {
      if (isEnoent(err)) throw err
      // A backend that cannot answer is one thing; a bug in the probe path
      // is another, and degrading it to "cannot verify" would hide it behind
      // a warning and a lifetime of cold reads.
      if (err instanceof TypeError || err instanceof ReferenceError) throw err
      await this.cache.remove(path)
      await mount.index?.clear()
      console.warn(`probe failed for ${path}: ${String(err)}`)
      return Verdict.UNKNOWN
    }
  }

  // Gate a cached read: is the cached copy still valid to serve? Under LAZY
  // the cache is trusted. Under ALWAYS the backend is re-stated: a matching
  // fingerprint serves the cached copy, a mismatch evicts it, a path the
  // backend no longer has GCs and throws, and a backend that answers no
  // fingerprint at all -- or no stat at all -- cannot be verified, so the
  // copy is dropped and the caller re-reads.
  //
  // supportsSnapshot deliberately does not appear here. It used to
  // short-circuit this function, dropping every cached copy on a resource
  // that declares it false. That is a proxy for "the stat carries no content
  // token", and it is the wrong one: box and dropbox stamp a fingerprint
  // without setting the flag (as do ssh and github on the python side, whose
  // rosters differ here), so the shortcut threw away entries this probe can
  // verify. The backends that really cannot be checked are answered by
  // probe's own UNKNOWN arm, one stat later.
  async mayServeCached(mount: MountEntry, path: string): Promise<boolean> {
    if (this.consistency !== ConsistencyPolicy.ALWAYS) return true
    const verdict = await this.probeOrUnknown(mount, path)
    if (verdict === Verdict.GONE) throw enoent(path)
    return verdict === Verdict.FRESH
  }

  // Reconcile a single-mount shell read before the command runs.
  // ls/stat on one mount resolve here (not through the dispatcher), so this
  // is where their reads reconcile against backend truth. Only paths that
  // carry an overlay or a cached copy are probed (a plain read pays
  // nothing); a remote delete then evicts the cache AND GCs the orphaned
  // overlay, and a stale entry is dropped.
  //
  // A probe failure drops the entry and lets the command run, the same answer
  // the gate gives: what cannot be verified is not served, and the backend
  // read that follows reports any real failure in the command's own voice.
  // Throwing from here would be worse than from the gate, because this runs
  // during routing rather than inside a handler.
  //
  // cachedGated says the command about to run reads its bytes through the
  // cache gate, which probes the same path itself; then only an overlay is
  // worth probing for here, or one warm read would stat twice.
  async reconcileRead(mount: MountEntry, path: string, cachedGated = false): Promise<void> {
    if (this.consistency !== ConsistencyPolicy.ALWAYS) return
    const hasOverlay = this.namespace.metaFor(path) !== null
    if (!hasOverlay && (cachedGated || !(await this.cache.exists(path)))) return
    await this.probeOrUnknown(mount, path)
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

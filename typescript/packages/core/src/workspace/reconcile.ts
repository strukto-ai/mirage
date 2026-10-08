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

import type { Evicted } from '../cache/index/config.ts'
import { ListingCheckStore } from '../cache/index/ram.ts'
import type { FileCache } from '../cache/file/mixin.ts'
import type { BaseVFS } from '../vfs/base.ts'
import { FileStat, ListingVersion, PathSpec, ReadPolicy } from '../types.ts'
import { enoent, isEnoent, isEnotdir, isMissingOp } from '../errors/fs.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import { ancestors } from '../utils/path.ts'
import type { MountEntry } from './mount/mount.ts'
import type { Namespace } from './mount/namespace/namespace.ts'

const REVALIDATE_OPS = new Set(['read', 'read_bytes', 'stat'])

// The spec a backend op sees for an absolute virtual path on `mount`.
function scopeOf(mount: MountEntry, path: string): PathSpec {
  const lastSlash = path.lastIndexOf('/')
  return new PathSpec({
    virtual: path,
    directory: lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/',
    vfsPath: mountKey(path, rstripSlash(mount.prefix)),
  })
}

enum Verdict {
  FRESH = 'fresh',
  STALE = 'stale',
  GONE = 'gone',
  UNKNOWN = 'unknown',
}

/**
 * Keep the local view honest against backend truth.
 *
 * The single reconcile point every read path shares. Under a mount's
 * `read: fresh` a backend re-stat classifies a path as fresh, stale
 * (fingerprint mismatch), gone
 * (deletion), or unknown (no fingerprint to compare). One deletion signal
 * feeds both consumers with separate reactions: the file cache evicts and the
 * namespace GCs any orphaned attribute overlay.
 *
 * Three read paths call in: the cached-read gate (mayServeCached), which the
 * dispatcher and the file cache's own door both run, its main-op catch
 * (onEnoent) for cross-mount and programmatic reads, and the mount
 * registry's per-command reconcile (reconcileRead) for single-mount shell
 * reads. The re-stat goes through the ops registry (not mount.call,
 * whose op set omits stat). Reconcile state follows each consumer's store
 * (RAM local, Redis shared across runtimes), so this is a thin coordinator
 * holding references, not config.
 *
 * The gate and reconcileRead both run for a warm named operand, once at
 * routing and again at the gate, and they share one scope: the command. The
 * first probe's backend answer is kept on the mount's CacheManager for the
 * rest of the command, so the gate, and the command's own stat of the
 * operand, reuse it instead of asking again. A write in the command, the
 * clear after an external program, or a re-list that finds the path gone
 * retires it, and a read outside any command (FUSE, the op door) never sees
 * it.
 */
export class Reconciler {
  private readonly cache: FileCache & BaseVFS
  private readonly namespace: Namespace

  constructor(cache: FileCache & BaseVFS, namespace: Namespace) {
    this.cache = cache
    this.namespace = namespace
  }

  // Re-stat the backend and apply the matching cache/overlay reaction. A
  // missing path GCs (evict cache + drop overlay); a fingerprint mismatch
  // evicts the stale cache entry. Non-ENOENT errors propagate.
  //
  // Inside a command, what an earlier probe of the same command got from the
  // backend is reused (CacheManager.probedStat) until a write lands: the
  // verdict and its reactions still run, only the round trip is skipped.
  private async probe(mount: MountEntry, path: string): Promise<Verdict> {
    const scope = scopeOf(mount, path)
    const manager = mount.cacheManager
    let remoteStat: unknown = manager?.probedStat(scope) ?? null
    let scratch: ListingCheckStore | null = null
    const generation = manager?.generation
    if (remoteStat === null) {
      scratch = new ListingCheckStore({ hints: mount.index })
      try {
        // No cached row answers; the mount's rows ride along as hints.
        remoteStat = await mount.callKeyed('stat', scope, [], { index: scratch })
      } catch (err) {
        if (isEnoent(err) || isEnotdir(err)) {
          await this.onMissing(path)
          await mount.index.clear()
          return Verdict.GONE
        }
        // A backend that registers no stat op cannot be revalidated at all.
        // probeOrUnknown would reach the same verdict, but it would also log
        // every read: this is a permanent capability of the mount, not an
        // anomaly worth a log line each time. isMissingOp, not a bare ENOTSUP
        // check: python catches OperationNotSupportedError, which only the op
        // door raises, and `stat` is the only op probed here -- so a backend
        // that stamps ENOTSUP itself takes the logged path on both sides.
        if (isMissingOp(err, 'stat')) {
          await this.cache.remove(path)
          await mount.index.clear()
          return Verdict.UNKNOWN
        }
        throw err
      }
      if (manager !== null && manager.generation === generation && remoteStat instanceof FileStat) {
        manager.noteProbed(scope, remoteStat)
      }
    }
    const fp = remoteStat instanceof FileStat ? remoteStat.fingerprint : null
    if (fp === null) {
      await this.cache.remove(path)
      await mount.index.clear()
      return Verdict.UNKNOWN
    }
    if (!(await this.cache.isFresh(path, fp))) {
      await this.cache.remove(path)
      await mount.index.clear()
      return Verdict.STALE
    }
    const predecessor = scratch?.hintedRows.get(path)
    if (
      scratch !== null &&
      predecessor !== undefined &&
      manager !== null &&
      generation !== undefined
    ) {
      const confirmed = (await scratch.get(path)).entry
      if (confirmed != null)
        await manager.retainResolvedEntry(scope, generation, predecessor, confirmed)
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
      if (isEnoent(err) || isEnotdir(err)) throw err
      // A backend that cannot answer is one thing; a bug in the probe path
      // is another, and degrading it to "cannot verify" would hide it behind
      // a log line and a lifetime of cold reads.
      if (err instanceof TypeError || err instanceof ReferenceError) throw err
      await this.cache.remove(path)
      await mount.index.clear()
      console.warn(`probe failed for ${path}: ${String(err)}`)
      return Verdict.UNKNOWN
    }
  }

  // Gate a cached read: is the cached copy still valid to serve? Under
  // `bounded` the cache is trusted within its bound. Under `fresh` the
  // backend probe (reused within its command until a write) supplies the
  // fingerprint: a match serves the cached copy, a mismatch evicts it, a path the
  // backend no longer has GCs and throws, and a backend that answers no
  // fingerprint at all -- or no stat at all -- cannot be verified, so the
  // copy is dropped and the caller re-reads.
  //
  // supportsSnapshot deliberately does not appear here. It used to
  // short-circuit this function, dropping every cached copy on a resource
  // that declares it false. That is a proxy for "the stat carries no content
  // token", and it is the wrong one: box and dropbox stamp a fingerprint
  // without setting the flag (as does ssh on the python side, whose roster
  // differs here), so the shortcut threw away entries this probe can
  // verify. The backends that really cannot be checked are answered by
  // probe's own UNKNOWN arm, one stat later.
  async mayServeCached(mount: MountEntry, path: string): Promise<boolean> {
    if (mount.read.policy !== ReadPolicy.FRESH) {
      // Bounded: the store expires the entry on its own, except for one
      // population it cannot. Nothing stamped a ttl before this policy
      // existed, and setCachedLocked short-circuits a warm read rather
      // than re-setting it, so a bound-less entry would never acquire one
      // and never expire. Removing it -- not merely declining to serve it
      // -- is what makes the cold read that follows stamp the bound;
      // refusing alone would leave the entry in place and refetch on
      // every read forever.
      if (await this.cache.isUnbounded(path)) {
        await this.cache.remove(path)
        return false
      }
      return true
    }
    const verdict = await this.probeOrUnknown(mount, path)
    if (verdict === Verdict.GONE) throw enoent(path)
    return verdict === Verdict.FRESH
  }

  /**
   * Gate a cached listing: may it be served without re-listing?
   *
   * Under `bounded` the listing is trusted within its bound. Under `fresh` a
   * listing the running command wrote itself is served (a read outside any
   * command trusts one written within the last `LISTING_TRUST_WINDOW`
   * seconds instead, `CacheManager.listingTrusted`). Past that, a listing
   * stored at the mount's pin is served without asking: github pins a
   * full-sha ref and serves its listing unchecked when the stored version
   * equals that sha. It names a commit: github.com refuses a 40- or 64-hex
   * branch or tag name, and a GitHub Enterprise host is assumed to as well
   * (`pinOf` in vfs/github/github.ts). A mount that declares a
   * `listingVersion` then has its stored `version` checked against a stat of
   * the mount root (MOUNT) or of the folder (FOLDER), sent through a
   * throwaway index so no cached row answers it. One check answers for a
   * whole command, and concurrent callers share it
   * (`CacheManager.checkedVersion`).
   *
   * A match serves the listing. Anything else answers EXPIRED and keeps the
   * listing stored for the re-list to diff: a moved version, a path the
   * backend no longer has, a stat with no fingerprint, a mount with no stat
   * at all, and a backend that cannot answer, which is logged. The index is
   * never cleared here. A programming error propagates.
   */
  async mayServeListing(
    mount: MountEntry,
    folder: string,
    version: string | null,
  ): Promise<boolean> {
    if (mount.read.policy !== ReadPolicy.FRESH) return true
    const manager = mount.cacheManager
    if (manager === null) return false
    if (manager.listingTrusted(folder)) return true
    const vfs = mount.vfs
    if (vfs.listingsPin !== null && version === vfs.listingsPin) return true
    if (vfs.listingVersion === ListingVersion.NONE || version === null) return false
    const key =
      vfs.listingVersion === ListingVersion.FOLDER ? folder : rstripSlash(mount.prefix) || '/'
    let remote: string | null
    try {
      remote = await manager.checkedVersion(key, version, () => this.listingFingerprint(mount, key))
    } catch (err) {
      if (isEnoent(err) || isEnotdir(err) || isMissingOp(err, 'stat')) return false
      if (err instanceof TypeError || err instanceof ReferenceError) throw err
      console.warn(`listing check failed for ${key}: ${String(err)}`)
      return false
    }
    return remote === version
  }

  // Ask the backend for the version a listing check compares: the mount root
  // or the folder the version covers.
  private async listingFingerprint(mount: MountEntry, path: string): Promise<string | null> {
    const remote = await mount.callKeyed('stat', scopeOf(mount, path), [], {
      index: new ListingCheckStore(),
    })
    return remote instanceof FileStat ? remote.fingerprint : null
  }

  // Reconcile a single-mount shell read before the command runs.
  // cat/ls/stat on one mount resolve here (not through the dispatcher), so
  // this is where their reads reconcile against backend truth. Only paths
  // that carry an overlay or a cached copy are probed (a plain read pays
  // nothing); a remote delete then evicts the cache AND GCs the orphaned
  // overlay, and a stale entry is dropped.
  //
  // Nothing escapes. This runs during routing, before any handler exists, so
  // an exception here does not fail one command -- it takes the whole line,
  // later pipeline stages and `;` chains included, and reports itself with no
  // operand to name. probeOrUnknown still rethrows a programming error for
  // the gate's benefit, which is correct there because the gate runs inside a
  // handler; here that same throw is only a way to lose output.
  async reconcileRead(mount: MountEntry, path: string): Promise<void> {
    if (mount.read.policy !== ReadPolicy.FRESH) return
    if (this.namespace.metaFor(path) === null && !(await this.cache.exists(path))) return
    try {
      await this.probeOrUnknown(mount, path)
    } catch (err) {
      await this.cache.remove(path)
      await mount.index.clear()
      console.warn(`reconcile probe failed for ${path}: ${String(err)}`)
    }
  }

  // React to a read/stat op that the backend reported gone (ENOENT).
  //
  // Keyed on the mount's policy rather than fired unconditionally, and
  // that is deliberate. An ENOENT here is not proof the backend said so:
  // object-store `stat` answers a miss straight out of a live index
  // listing, and so do the box, gdrive, dropbox, hierarchy and hf_hub
  // reads. Reacting to one of those would drop an attribute overlay --
  // which no backend stores, so nothing can put it back -- on the
  // strength of cached negative knowledge.
  //
  // `isEnoent` is load-bearing and stays: the call site is a generic
  // catch, so without it a 500, a timeout or an auth failure would GC.
  async onEnoent(mount: MountEntry, name: string, path: string, err: unknown): Promise<void> {
    if (
      mount.read.policy === ReadPolicy.FRESH &&
      REVALIDATE_OPS.has(name) &&
      (isEnoent(err) || isEnotdir(err))
    ) {
      await this.onMissing(path)
    }
  }

  async onGone(gone: readonly Evicted[], excluded: readonly string[] = []): Promise<void> {
    const paths = new Set(gone.map((child) => rstripSlash(child.path) || '/'))
    const folders = new Set(
      gone.filter((child) => child.folder).map((child) => rstripSlash(child.path) || '/'),
    )
    for (const path of paths) {
      const parents = [...ancestors(path), ...(path === '/' ? [] : ['/'])]
      if (parents.some((parent) => folders.has(parent))) continue
      await this.cache.remove(path)
      if (folders.has(path)) await this.cache.evictPrefix(rstripSlash(path) + '/', excluded)
    }
    if (paths.size > 0) await this.namespace.dropOverlaysUnder([...paths], excluded)
  }

  // Apply the deletion reaction: evict cache + GC orphaned overlay. An
  // authoritative symlink node is left intact (dropOverlay skips it).
  private async onMissing(path: string): Promise<void> {
    await this.cache.remove(path)
    await this.namespace.dropOverlay(path)
  }
}

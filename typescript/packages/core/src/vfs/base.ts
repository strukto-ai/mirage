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
import type { PredNode } from '../commands/builtin/find_eval.ts'
import type { RegisteredCommand } from '../commands/config.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import type { CapacityResult, FileStat, PathSpec } from '../types.ts'
import { CapacityState } from '../types.ts'
import type { DeltaHook } from '../watch/base.ts'

export interface FindOptions {
  name?: string | null
  type?: string | null
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

/**
 * The two keys the snapshot machinery reads out of a VFS's state.
 *
 * `type` is the registry name, and it is what rebuilds the VFS:
 * Python's `_vfs_class_for` looks it up in the registry first and
 * only falls back to the mount's `vfs_class` import path when it
 * misses. `config` is what `vfsStateRequiresOverride` scans for the
 * `<REDACTED>` marker, which is what makes load demand a fresh config
 * instead of silently substituting an empty mount.
 *
 * This lived as a private interface in `workspace/snapshot/types.ts`,
 * where `VFSState` still widens it with each backend's own keys; it
 * moved here so the `VFS` contract and the snapshot format name one
 * shape rather than two identical ones. Python needs no such type —
 * `get_state` is annotated `dict[str, Any]` — but a TS interface is not
 * assignable to `Record<string, unknown>` (no implicit index signature),
 * so the literal twin would reject every named `XVFSState`.
 */
export interface VFSStateBase {
  type: string
  config?: unknown
  // Set by a backend whose mount cannot be rebuilt from this state alone,
  // so `Workspace.load` asks for the live VFS back instead of
  // rebuilding one. See `vfsStateRequiresOverride`.
  needs_override?: boolean
}

// The `vfs:` value the registry built an instance from: a name
// (`s3`, `wiki`) or a code reference (`./wiki.mjs:WikiVFS`). Python
// keeps this on `BaseVFS.vfs_ref`; `VFS` is an interface
// here, so the fact lives beside it. A snapshot records it so the loader
// can rebuild the mount through the same door config used, which is the
// only door that knows a class loaded from a script file.
const VFS_REFS = new WeakMap<object, string>()

export function recordVfsRef(vfs: VFS, ref: string): void {
  VFS_REFS.set(vfs, ref)
}

export function vfsRefOf(vfs: VFS): string | null {
  return VFS_REFS.get(vfs) ?? null
}

export interface VFS {
  /** Closed VFS instances cannot be mounted again. */
  readonly isClosed?: boolean
  readonly kind: string
  readonly prompt?: string
  readonly writePrompt?: string
  readonly indexTtl?: number
  /**
   * Whether reads of this VFS may be served from / written to the
   * local file cache. Defaults to false. A network-backed VFS whose
   * content is read-mostly (e.g. object storage) sets this to true so
   * reads can be cached; a VFS whose content is live (e.g. a
   * database collection) leaves it false so reads always hit the backend
   * and live follows (`tail -f`) are not masked by a cached snapshot.
   */
  readonly cachesReads?: boolean
  /**
   * Whether this VFS carries enough version information for
   * snapshot+replay drift detection. When true, the VFS's
   * {@link VFS.stat} must populate {@link FileStat.fingerprint}
   * (and optionally {@link FileStat.revision}) with stable per-path
   * markers. When false (the default), reads are treated as live-only
   * at replay time: no fingerprint is captured at snapshot, no drift
   * check fires at load.
   */
  readonly supportsSnapshot?: boolean
  /**
   * Whether {@link VFS.stat} can size every regular file without
   * fetching its content, i.e. {@link FileStat.size} is null only for
   * directories. True for byte stores that keep a length in their
   * metadata (ram, disk, redis, s3, gridfs); false for mounts that
   * render content on read, where the size is unknowable until the bytes
   * exist (slack, gmail, notion, postgres rows.jsonl, dify documents).
   *
   * FUSE does not need this: direct_io + attrTimeout '0' + hydrate-on-open
   * make size-unknown files read correctly anyway. FSKit has no direct_io
   * equivalent, so a mount there is driven entirely by the reported size
   * and a false VFS would serve silent empty files. Mirrors Python's
   * `BaseVFS.SIZES_ALWAYS_KNOWN`.
   */
  readonly sizesAlwaysKnown?: boolean
  /**
   * Whether a `read: fresh` mount can actually be revalidated against this
   * backend: {@link VFS.stat} and the read record must stamp the *same kind*
   * of content token, so the gate can compare them with `===`. False (the
   * default) is refused at mount time rather than degraded, because a mount
   * that declares fresh and silently serves bounded is the bug the policy
   * exists to prevent.
   *
   * Distinct from {@link VFS.supportsSnapshot}, which asks whether a token
   * exists at all: gdrive stamps one on both sides and still cannot honour
   * fresh, because stat returns a timestamp where read returns an md5.
   * Distinct from {@link VFS.cachesReads}, which asks whether the gate can
   * fire.
   *
   * onedrive and sharepoint look like they qualify and do not: both stamp
   * a cTag on stat and on read, so on token kind alone the refusal reads
   * as unnecessary. It is correct for a second reason this flag does not
   * name -- both label the read record with the slashless `vfsPath`, so
   * the record key comes out malformed (`/oda/b.txt` rather than
   * `/od/a/b.txt`) and the cTag can never be matched against the cache
   * entry. The backends that do qualify pass the mount path instead.
   * gdrive carries the same slashless label on top of its token-kind
   * mismatch. Fix the label before reconsidering the flag.
   *
   * Mirrors Python's `BaseVFS.READ_REVALIDATABLE`.
   */
  readonly readRevalidatable?: boolean
  readonly index?: IndexCacheStore
  readonly accessor?: Accessor
  readonly opsMap?: Record<string, unknown>
  setIndex?(config?: IndexConfig): void
  open(): Promise<void>
  close(): Promise<void>
  // Non-optional on purpose: `toStateDict` calls both on every mount, so an
  // absent one is a `Workspace.save()` crash rather than a missing feature.
  // BaseVFS supplies the bare `{type}` default, as Python's does; a
  // VFS holding config overrides it to carry that config too.
  getState(): VFSStateBase | Promise<VFSStateBase>
  loadState(state: VFSStateBase): void | Promise<void>
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
  // Identity of the storage behind this VFS, so cp/mv can tell two
  // prefixes over one store from two genuinely separate ones. Absent ->
  // every mount is treated as its own storage, which only preserves the
  // pre-existing behavior; see BaseVFS.storageId.
  storageId?(): string
  deltaHook?(): DeltaHook
}

export function cachesReads(vfs: VFS): boolean {
  return vfs.cachesReads === true
}

export function sizesAlwaysKnown(vfs: VFS): boolean {
  return vfs.sizesAlwaysKnown === true
}

export function readRevalidatable(vfs: VFS): boolean {
  return vfs.readRevalidatable === true
}

export abstract class BaseVFS {
  // Named here rather than only on the VFS interface so the state
  // defaults below can spell themselves, mirroring Python's
  // `BaseVFS.name`.
  abstract readonly kind: string
  readonly indexTtl: number = 600
  protected _index?: IndexCacheStore
  // JS has no object-identity primitive, so the default storageId hands
  // each instance a serial number the first time it is asked.
  static #storageCounter = 0
  #storageSeq?: number
  #closed = false

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

  // Identity of the storage this VFS reads and writes. Two mounts
  // whose mounts return the same value address the same bytes, so a
  // move between them must refuse rather than copy the object onto itself
  // and then unlink the source. The default treats every instance as its
  // own storage, which is the safe direction to be wrong in: a false
  // "different" only keeps the pre-existing behavior, while a false "same"
  // would refuse a legitimate move. Backends whose config pins the storage
  // (a disk root, a bucket and key prefix) override this so two separately
  // constructed instances pointing at one target still compare equal.
  storageId(): string {
    this.#storageSeq ??= ++BaseVFS.#storageCounter
    // The serial is what makes this unique; the class name only makes the
    // value readable when it shows up while debugging.
    return `${this.constructor.name}:${String(this.#storageSeq)}`
  }

  // Default df capacity: UNKNOWN (rendered `-`). Backends that can report
  // truthfully — a real filesystem, or a provider quota — override this.
  statfs(): Promise<CapacityResult> {
    return Promise.resolve({ state: CapacityState.UNKNOWN })
  }

  /**
   * The snapshot state of a VFS that holds nothing of its own: the
   * class name, so `Workspace.load` can rebuild it. Storage-backed
   * mounts override this to carry their bytes, config-backed ones to
   * carry their (redacted) config. Mirrors Python
   * `BaseVFS.get_state`.
   */
  getState(): VFSStateBase | Promise<VFSStateBase> {
    return { type: this.kind }
  }

  /**
   * Take back what {@link BaseVFS.getState} put out. A no-op by
   * default, because the bare `{type}` carries nothing to restore.
   * Mirrors Python `BaseVFS.load_state`.
   */
  loadState(_state: VFSStateBase): void | Promise<void> {
    // Nothing to take back.
  }

  get isClosed(): boolean {
    return this.#closed
  }

  /**
   * Release what this VFS owns, exactly once. The base teardown is
   * the index store: a mount configured `index: {type: redis}` holds a
   * client that nothing else closes, so without this a Node process
   * stays alive after `closeWorkspace`.
   *
   * A backend with its own handles (a db pool, an ssh channel) overrides
   * this and calls `super.close()` — its accessor is its own to close,
   * since the Accessor seam carries no lifecycle of its own.
   *
   * Mirrors Python `BaseVFS.close` (`VFS/base.py`).
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Deliberately `_index`, not the `index` getter: reading the getter
    // would build a store for a VFS that never used one, only to
    // close it.
    await this._index?.close()
  }
}

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

import type { OpRecord } from '../../observe/record.ts'
import type { FileStat } from '../../types.ts'
import { DriftPolicy } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'

/**
 * Raised at load time when a remote resource's live fingerprint differs
 * from what was recorded in the snapshot.
 *
 * Indicates the underlying source has been modified since the snapshot
 * was taken, so reading current bytes would silently diverge from what
 * the original agent saw. Surface to the caller rather than mask.
 */
export class ContentDriftError extends Error {
  readonly path: string
  readonly snapshotFingerprint: string
  readonly liveFingerprint: string | null

  constructor(path: string, snapshotFingerprint: string, liveFingerprint: string | null) {
    const liveRepr = liveFingerprint === null ? '<missing>' : JSON.stringify(liveFingerprint)
    super(
      `${path}: snapshot fingerprint ${JSON.stringify(snapshotFingerprint)}, live ${liveRepr}; ` +
        'data on the underlying source has changed since the snapshot was taken',
    )
    this.name = 'ContentDriftError'
    this.path = path
    this.snapshotFingerprint = snapshotFingerprint
    this.liveFingerprint = liveFingerprint
  }
}

export interface FingerprintEntry {
  path: string
  mount_prefix: string
  fingerprint?: string | null
  revision?: string | null
}

interface RegistryLike {
  tryMountFor(path: string): MountEntry | null
  allMounts(): readonly MountEntry[]
}

// The drain needs only path-to-mount resolution, so the door can pass
// its namespace (which answers tryMountFor) without holding the
// registry. The try variant: a snapshot path the live workspace no
// longer mounts is skipped, never an error.
export interface MountLookup {
  tryMountFor(path: string): MountEntry | null
}

/**
 * Fingerprint checks a load queued, drained on the first async op.
 *
 * `Workspace.load` records one entry per read whose snapshot manifest
 * carried a fingerprint but no stable revision (a pinned read needs no
 * check: the pin guarantees the bytes). The first `dispatch` or
 * `execute` drains them, so downstream code can rely on consistent
 * state. Mirrors the Python `DriftQueue` in `snapshot/drift.py`.
 */
export class DriftQueue {
  private entries: { path: string; fingerprint: string; mountId: string | null }[] = []
  private isPending = false

  get pending(): boolean {
    return this.isPending
  }

  /** Paths still queued for a check (audit surface). */
  get paths(): string[] {
    return this.entries.map((e) => e.path)
  }

  /** Drop any queued state (a re-install starts fresh). */
  clear(): void {
    this.entries = []
    this.isPending = false
  }

  queue(path: string, fingerprint: string, mountId: string | null = null): void {
    this.entries.push({ path, fingerprint, mountId })
    this.isPending = true
  }

  /**
   * Stat every queued path in parallel; throw on the first drift.
   * Subsequent calls are no-ops. Stats run concurrently so first-op
   * latency does not scale linearly with the number of recorded reads.
   */
  async drain(registry: MountLookup, statFn: (path: string) => Promise<unknown>): Promise<void> {
    this.isPending = false
    if (this.entries.length === 0) return
    const pending = this.entries
    this.entries = []
    const results = await Promise.allSettled(
      pending.map((p) => checkDrift(registry, statFn, p.path, p.fingerprint, p.mountId)),
    )
    for (const r of results) {
      if (r.status === 'rejected') throw r.reason as Error
    }
  }
}

/**
 * Walk a loaded snapshot's fingerprint manifest. For entries with a
 * revision, install the pin on the owning mount so replay reads pin to
 * that revision. For fingerprint-only entries, queue the path on the
 * drift queue. OFF skips the checks and evicts the snapshot cache for
 * fingerprinted paths so reads serve current state.
 *
 * Idempotent: clears queued state before installing. Called from
 * `Workspace.fromState`.
 */
export function installDriftState(
  registry: RegistryLike,
  cache: { evictPaths(paths: Iterable<string>): void },
  drift: DriftQueue,
  state: { fingerprints?: FingerprintEntry[]; live_only_mounts?: string[] },
  policy: DriftPolicy,
): void {
  drift.clear()
  const entries = state.fingerprints ?? []
  if (entries.length === 0) return
  if (policy === DriftPolicy.OFF) {
    // Synchronously: this function returns into a sync `fromState`, so
    // a fire-and-forget `remove()` would let the very next read be
    // served the snapshot bytes OFF exists to bypass.
    cache.evictPaths(entries.map((e) => e.path))
    return
  }
  for (const e of entries) {
    const mount = registry.tryMountFor(e.path)
    if (mount === null) continue
    if (e.revision !== undefined && e.revision !== null) {
      mount.revisions.set(e.path, e.revision)
      continue
    }
    if (e.fingerprint !== undefined && e.fingerprint !== null) {
      drift.queue(e.path, e.fingerprint, mount.mountId)
    }
  }
  const liveOnly = state.live_only_mounts ?? []
  if (liveOnly.length > 0) {
    console.warn(
      `Workspace.load: ${String(liveOnly.length)} mount(s) opt out of snapshot replay; ` +
        `reads against them will serve current state with no drift detection: ` +
        liveOnly.join(', '),
    )
  }
}

/**
 * Walk recorded ops and emit one entry per distinct read on a
 * snapshot-capable mount.
 *
 * Pure aggregation over `records`. Each read carries the `fingerprint`
 * and/or `revision` the backend returned at the moment the agent read
 * the bytes (populated from the GET response, not a fresh stat at
 * snapshot time). This avoids the race where the upstream changes
 * between read and snapshot.
 *
 * Skips paths whose owning mount has `supportsSnapshot=false` (live-only
 * backends like Gmail/Slack/Linear) and reads where the backend returned
 * neither marker.
 */
export function captureFingerprints(
  records: readonly OpRecord[],
  registry: RegistryLike,
): FingerprintEntry[] {
  const seen = new Set<string>()
  const out: FingerprintEntry[] = []
  for (const rec of records) {
    if (rec.op !== 'read' || seen.has(rec.path)) continue
    if (rec.fingerprint === null && rec.revision === null) continue
    const mount = registry.tryMountFor(rec.path)
    if (mount === null || (rec.mountId !== null && rec.mountId !== mount.mountId)) continue
    seen.add(rec.path)
    if (mount.resource.supportsSnapshot !== true) continue
    const entry: FingerprintEntry = { path: rec.path, mount_prefix: mount.prefix }
    if (rec.fingerprint !== null) entry.fingerprint = rec.fingerprint
    if (rec.revision !== null) entry.revision = rec.revision
    out.push(entry)
  }
  return out
}

/**
 * Return mount prefixes whose resource opts out of snapshot replay.
 *
 * These mounts will serve current state at load time with no drift
 * detection. Surfaced in the snapshot manifest so the load layer can
 * log them and so users can audit which paths are non-replayable.
 */
export function liveOnlyMountPrefixes(registry: RegistryLike): string[] {
  const out: string[] = []
  for (const m of registry.allMounts()) {
    if (m.prefix === '/dev/' || m.prefix === '/.bash_history/') continue
    if (m.resource.supportsSnapshot !== true) out.push(m.prefix)
  }
  return out
}

/**
 * Stat `path` and throw {@link ContentDriftError} if the live fingerprint
 * does not match `recorded`. No-op if the mount cannot be resolved or the
 * resource cannot fingerprint.
 *
 * The caller provides `statFn` (typically a thin wrapper over
 * {@link Workspace.dispatch}) so that drift.ts stays decoupled from the
 * workspace's op-resolution machinery.
 */
export async function checkDrift(
  registry: MountLookup,
  statFn: (path: string) => Promise<unknown>,
  path: string,
  recorded: string,
  mountId: string | null = null,
): Promise<void> {
  const mount = registry.tryMountFor(path)
  if (mount === null || (mountId !== null && mount.mountId !== mountId)) return
  if (mount.resource.supportsSnapshot !== true) return
  let stat: FileStat
  try {
    stat = (await statFn(path)) as FileStat
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') {
      if (registry.tryMountFor(path) !== mount) return
      throw new ContentDriftError(path, recorded, null)
    }
    throw err
  }
  if (registry.tryMountFor(path) !== mount) return
  const live = stat.fingerprint
  if (live === null) return
  if (live !== recorded) throw new ContentDriftError(path, recorded, live)
}

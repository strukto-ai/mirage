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
import type { Mount } from '../mount/mount.ts'

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
  mountPrefix: string
  fingerprint?: string | null
  revision?: string | null
}

interface RegistryLike {
  mountFor(path: string): Mount | null
  allMounts(): readonly Mount[]
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
    seen.add(rec.path)
    const mount = registry.mountFor(rec.path)
    if (mount === null) continue
    if (mount.resource.supportsSnapshot !== true) continue
    const entry: FingerprintEntry = { path: rec.path, mountPrefix: mount.prefix }
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
    if (m.prefix === '/dev/' || m.prefix === '/.sessions/') continue
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
  registry: RegistryLike,
  statFn: (path: string) => Promise<unknown>,
  path: string,
  recorded: string,
): Promise<void> {
  const mount = registry.mountFor(path)
  if (mount === null) return
  if (mount.resource.supportsSnapshot !== true) return
  let stat: FileStat
  try {
    stat = (await statFn(path)) as FileStat
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') {
      throw new ContentDriftError(path, recorded, null)
    }
    throw err
  }
  const live = stat.fingerprint
  if (live === null) return
  if (live !== recorded) throw new ContentDriftError(path, recorded, live)
}

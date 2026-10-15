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

import {
  Delta,
  FileChangeKind,
  FileEvent,
  FileMetadata,
  PathSpec,
  type WalkEntry,
  type WalkFn,
} from '../types.ts'
import { rstripSlash, stripSlash } from '../utils/slash.ts'
import type { DeltaHook } from './base.ts'
import { DIR_FINGERPRINT } from './constants.ts'
import { compareCodePoints } from '../utils/sort.ts'

export function specFor(root: PathSpec, virtual: string): PathSpec {
  const cut = rstripSlash(root.virtual).length - root.vfsPath.length
  return PathSpec.fromStrPath(virtual, stripSlash(virtual.slice(cut)))
}

/**
 * The changes a watch on `root` reports: each at or below it as itself, and
 * each at a directory above it as the root's own, since that directory removed
 * removes the root, and any other change to it may have moved the root
 * (UNKNOWN). Mirrors Python `changes_under`.
 */
export function changesUnder(
  root: PathSpec,
  changes: Iterable<readonly [FileChangeKind, string]>,
  observed: Date,
): FileEvent[] {
  const top = rstripSlash(root.virtual)
  const events: FileEvent[] = []
  for (const [kind, virtual] of changes) {
    if (virtual === top || virtual.startsWith(`${top}/`)) {
      events.push(new FileEvent({ kind, path: specFor(root, virtual), timestamp: observed }))
    } else if (top.startsWith(`${rstripSlash(virtual)}/`)) {
      const gone = kind === FileChangeKind.DELETE
      events.push(
        new FileEvent({
          kind: gone ? kind : FileChangeKind.UNKNOWN,
          path: root,
          timestamp: observed,
        }),
      )
    }
  }
  return events
}

/**
 * Classify two `{virtual: fingerprint}` snapshots as changes.
 *
 * A key only in `current` is a CREATE, one only in `previous` a DELETE, and a
 * changed fingerprint an UPDATE. A file change that is not a DELETE carries
 * the metadata of its row in `entries`, when there is one.
 *
 * Mirrors Python `diff_snapshots` (`watch/delta.py`).
 */
export function diffSnapshots(
  root: PathSpec,
  previous: Record<string, string>,
  current: Record<string, string>,
  entries: ReadonlyMap<string, WalkEntry>,
  observed: Date,
): FileEvent[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(previous)])].sort(
    compareCodePoints,
  )
  const changes: FileEvent[] = []
  for (const virtual of keys) {
    const old = previous[virtual]
    const next = current[virtual]
    if (old === next) continue
    const kind =
      old === undefined
        ? FileChangeKind.CREATE
        : next === undefined
          ? FileChangeKind.DELETE
          : FileChangeKind.UPDATE
    const entry = entries.get(virtual)
    const metadata =
      entry !== undefined && !entry.isDir && kind !== FileChangeKind.DELETE
        ? new FileMetadata({
            fingerprint: entry.fingerprint,
            size: entry.size ?? null,
            modified: entry.modified ?? null,
          })
        : null
    changes.push(
      new FileEvent({ kind, path: specFor(root, virtual), timestamp: observed, metadata }),
    )
  }
  return changes
}

export class ListingDeltaHook implements DeltaHook {
  private readonly walk: WalkFn

  constructor(walk: WalkFn) {
    this.walk = walk
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const snapshot: Record<string, string> = {}
    const entries = new Map<string, WalkEntry>()
    for await (const entry of this.walk(root)) {
      entries.set(entry.virtual, entry)
      snapshot[entry.virtual] = entry.isDir ? DIR_FINGERPRINT : (entry.fingerprint ?? '')
    }
    const serialized = JSON.stringify(snapshot, Object.keys(snapshot).sort(compareCodePoints))
    if (checkpoint === null) return new Delta({ changes: [], checkpoint: serialized })
    const previous = JSON.parse(checkpoint) as Record<string, string>
    return new Delta({
      changes: diffSnapshots(root, previous, snapshot, entries, new Date()),
      checkpoint: serialized,
    })
  }
}

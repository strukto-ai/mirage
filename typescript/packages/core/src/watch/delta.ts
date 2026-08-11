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

export function specFor(root: PathSpec, virtual: string): PathSpec {
  const cut = rstripSlash(root.virtual).length - root.resourcePath.length
  return PathSpec.fromStrPath(virtual, stripSlash(virtual.slice(cut)))
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
    const serialized = JSON.stringify(snapshot, Object.keys(snapshot).sort())
    if (checkpoint === null) return new Delta({ changes: [], checkpoint: serialized })
    const previous = JSON.parse(checkpoint) as Record<string, string>
    const observed = new Date()
    const changes: FileEvent[] = []
    const paths = [...new Set([...Object.keys(snapshot), ...Object.keys(previous)])].sort()
    for (const virtual of paths) {
      const oldFingerprint = previous[virtual]
      const newFingerprint = snapshot[virtual]
      if (oldFingerprint === newFingerprint) continue
      let kind: FileChangeKind
      if (oldFingerprint === undefined && newFingerprint !== undefined) {
        kind = FileChangeKind.CREATE
      } else if (newFingerprint === undefined) {
        kind = FileChangeKind.DELETE
      } else {
        kind = FileChangeKind.UPDATE
      }
      const current = entries.get(virtual)
      const metadata =
        current !== undefined && !current.isDir
          ? new FileMetadata({
              fingerprint: current.fingerprint,
              size: current.size ?? null,
              modified: current.modified ?? null,
            })
          : null
      changes.push(
        new FileEvent({
          kind,
          path: specFor(root, virtual),
          timestamp: observed,
          metadata,
        }),
      )
    }
    return new Delta({ changes, checkpoint: serialized })
  }
}

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

import type { RecentChanges } from '../../mount/changes.ts'

// The most bytes a read-ahead fetches for one file, as its listing sizes it,
// and the most one held batch holds. A larger file is left to the read that
// names it, and so is a file the listing does not size, unless its store reads
// a batch (`readMany`), which leaves out what passes this itself.
export const READ_AHEAD_BYTES = 1 << 20

/**
 * A file a read-ahead read for its caller: the virtual path the read reached,
 * links followed, and the file's stored bytes. Mirrors Python's `HeldFile`.
 */
export interface HeldFile {
  readonly followed: string
  readonly data: Uint8Array
}

/**
 * What a read-ahead (`read_many`) answers.
 *
 * On a mount that keeps reads it warms the read cache, and `kept` says so. On
 * one that holds its data locally it reads the files for the caller instead,
 * past each one's checks, `holds` says so, and it holds them here: each is
 * handed out once, while no change has reached it since `count`, as the
 * workspace's changes numbered them before the reads. A file the batch left
 * out is read on its own. Mirrors Python's `ReadBatch`.
 */
export class ReadBatch {
  /** A file of the batch is on a mount that keeps reads. */
  readonly kept: boolean
  /**
   * A file of the batch is on a mount that holds its data locally, which
   * reads it for the caller, whether or not it was held.
   */
  readonly holds: boolean
  /** The files read, by the virtual path the caller named. */
  readonly held: Map<string, HeldFile>
  /** The workspace's changes; null while nothing is held. */
  readonly changes: RecentChanges | null
  /** How many changes it had noted before the reads. */
  readonly count: number

  constructor(
    fields: {
      kept?: boolean
      holds?: boolean
      held?: Map<string, HeldFile>
      changes?: RecentChanges | null
      count?: number
    } = {},
  ) {
    this.kept = fields.kept ?? false
    this.holds = fields.holds ?? false
    this.held = fields.held ?? new Map<string, HeldFile>()
    this.changes = fields.changes ?? null
    this.count = fields.count ?? 0
  }

  /**
   * The bytes held for `virtual`, handed out once; null when none are held or
   * a change has reached the file since they were read.
   *
   * @param virtual the path as the caller names it.
   */
  take(virtual: string): Uint8Array | null {
    const held = this.held.get(virtual)
    this.held.delete(virtual)
    if (held === undefined || this.changes === null) return null
    if (this.changes.reachedSince(this.count, [virtual, held.followed])) return null
    return held.data
  }
}

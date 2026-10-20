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

import type { ByteSource } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { PathSpec } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { TreeEntry } from './tree.ts'
import type { RepoLocation } from './types.ts'

/** One comparison: the old side's entries, then the new side's. */
export type Side = readonly [Map<string, TreeEntry>, Map<string, TreeEntry>]

/**
 * One path a comparison changed, as the row git hands over.
 *
 * Unpaired: a rename is the delete of its source and the add of its
 * destination, two rows each naming its own path, so a hide drops either side
 * alone and the renderer pairs only what is left. Mirrors Python's `Delta`.
 */
export interface Delta {
  /** Where the entry sits in the session's tree. */
  readonly path: PathSpec
  /** Git's repository-relative name. */
  readonly name: string
  /** The entry before; null when added. */
  readonly old: TreeEntry | null
  /** The entry after; null when deleted. */
  readonly new: TreeEntry | null
  /** Which of the command's comparisons it belongs to. */
  readonly side: number
}

/** Where a repository entry sits in the session's tree. */
export function entryPath(location: RepoLocation, name: string): PathSpec {
  return location.worktree.join(name)
}

/**
 * The paths each comparison changed, one row per path and side.
 *
 * A path both sides hold alike is no row: no format prints it, and a rename
 * is only ever found among changed paths. `first` is the number the first
 * comparison takes, for a command that makes its comparisons in batches.
 */
export function deltas(location: RepoLocation, sides: readonly Side[], first = 0): Delta[] {
  const rows: Delta[] = []
  sides.forEach(([before, after], index) => {
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints)) {
      const old = before.get(name) ?? null
      const fresh = after.get(name) ?? null
      if (old?.oid === fresh?.oid && old?.mode === fresh?.mode) continue
      rows.push({ path: entryPath(location, name), name, old, new: fresh, side: first + index })
    }
  })
  return rows
}

/**
 * The comparisons again, holding only the rows the session sees. A
 * comparison whose every row was dropped comes back empty, which the formats
 * read as "does not differ".
 */
export function shownSides(shown: readonly Delta[], count: number): Side[] {
  const sides: Side[] = Array.from({ length: count }, () => [new Map(), new Map()])
  for (const row of shown) {
    const side = sides[row.side]
    if (side === undefined) continue
    if (row.old !== null) side[0].set(row.name, row.old)
    if (row.new !== null) side[1].set(row.name, row.new)
  }
  return sides
}

/** One line a listing prints, and the entry it names. Mirrors Python's `Line`. */
export interface Line {
  /** Where the entry sits in the session's tree. */
  readonly path: PathSpec
  /** The line as printed, terminator included. */
  readonly text: string
}

/** A listing's lines, those the session sees, in order. */
export function printed(shown: Line[]): Promise<ByteSource | null> {
  const text = shown.map((row) => row.text).join('')
  return Promise.resolve(text === '' ? null : encodeText(text))
}

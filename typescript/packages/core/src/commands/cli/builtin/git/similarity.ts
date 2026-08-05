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

// A block ends at a newline or at this many bytes, whichever comes first, so a
// long line without newlines still splits into comparable pieces.
const BLOCK_SIZE = 64
const MAX_SCORE = 100

const DEC = new TextDecoder('latin1')

/**
 * How many bytes of each distinct block a blob holds.
 *
 * Keyed by the block's bytes read as latin1, which round-trips every byte value
 * to a distinct string, so two blocks collide as keys exactly when they are
 * equal.
 */
function countBlocks(data: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>()
  let start = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x0a && i - start + 1 < BLOCK_SIZE) continue
    const key = DEC.decode(data.subarray(start, i + 1))
    counts.set(key, (counts.get(key) ?? 0) + key.length)
    start = i + 1
  }
  if (start < data.length) {
    const key = DEC.decode(data.subarray(start))
    counts.set(key, (counts.get(key) ?? 0) + key.length)
  }
  return counts
}

/** How many bytes two blobs hold in blocks they share. */
function commonBytes(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let total = 0
  for (const [key, count] of small) {
    const other = large.get(key)
    if (other !== undefined) total += Math.min(count, other)
  }
  return total
}

/**
 * How alike two blobs are, 0 to 100, matching dulwich's own score.
 *
 * The two implementations have to agree digit for digit or rename detection
 * diverges between the languages at the 60% threshold: a move-plus-edit would
 * read as one rename on one side and as an add beside a delete on the other.
 *
 * Two empty blobs are perfectly alike, which is the one case a ratio cannot
 * express.
 */
export function similarityScore(a: Uint8Array, b: Uint8Array): number {
  const maxSize = Math.max(a.length, b.length)
  if (maxSize === 0) return MAX_SCORE
  return Math.floor((commonBytes(countBlocks(a), countBlocks(b)) * MAX_SCORE) / maxSize)
}

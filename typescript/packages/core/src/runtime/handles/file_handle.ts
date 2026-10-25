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

import { concat } from '../../utils/bytes.ts'
import { spliceWindow } from '../../utils/ranges.ts'

/**
 * Buffered (offset, payload) writes as the fewest pwrites that leave a file
 * as the writes did, in arrival order.
 *
 * The kernel adapters buffer each write on its handle and owe the mount the
 * lot at flush. A write that starts inside the last run, or right at its
 * end, folds into it, so a sequential stream is one run. Any other starts a
 * run of its own; the runs apply in order, so a later run still overwrites
 * what it overlaps of an earlier one.
 *
 * Args:
 *   writes: the buffered writes, in arrival order.
 */
export function writeRuns(writes: readonly [number, Uint8Array][]): [number, Uint8Array][] {
  const runs: { start: number; parts: Uint8Array[]; length: number }[] = []
  for (const [offset, chunk] of writes) {
    const last = runs.at(-1)
    if (last !== undefined && last.start <= offset && offset <= last.start + last.length) {
      const at = offset - last.start
      if (at === last.length) {
        last.parts.push(chunk.slice())
        last.length += chunk.byteLength
        continue
      }
      const merged = spliceWindow(concat(last.parts), at, chunk)
      last.parts = [merged]
      last.length = merged.byteLength
      continue
    }
    runs.push({ start: offset, parts: [chunk.slice()], length: chunk.byteLength })
  }
  return runs.map((run): [number, Uint8Array] => [run.start, concat(run.parts)])
}

/**
 * A read window with a handle's buffered writes laid over it.
 *
 * The kernel adapters keep a handle's writes until flush; a read through that
 * handle sees them, as a read after write(2) does. They apply in arrival
 * order, so a later write wins where it overlaps, and a gap a write grew the
 * file across reads as zeros. Mirrors Python's `overlaid`.
 *
 * Args:
 *   stored: the stored bytes from `offset`, short where the stored file ends.
 *   offset: where the window starts.
 *   size: the window's length.
 *   writes: the buffered writes, in arrival order.
 */
export function overlaid(
  stored: Uint8Array,
  offset: number,
  size: number,
  writes: readonly [number, Uint8Array][],
): Uint8Array {
  let reach = offset + stored.byteLength
  for (const [start, data] of writes) reach = Math.max(reach, start + data.byteLength)
  const end = Math.min(offset + size, reach)
  if (end <= offset) return new Uint8Array()
  const out = new Uint8Array(end - offset)
  out.set(stored.subarray(0, end - offset))
  for (const [start, data] of writes) {
    const low = Math.max(start, offset)
    const high = Math.min(start + data.byteLength, end)
    if (low < high) out.set(data.subarray(low - start, high - start), low - offset)
  }
  return out
}

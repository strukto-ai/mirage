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

import { ByteSlice, MEMORY_LIMIT, type ByteSpool } from '../../io/spool.ts'
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

/**
 * Buffered writes in the groups `writeRuns` folds into one run each,
 * unfolded, for a buffer some of whose writes wait in a spool. Mirrors
 * Python's `run_groups`.
 *
 * Args:
 *   writes: the buffered writes, in arrival order.
 */
export function runGroups(
  writes: readonly [number, Uint8Array | ByteSlice][],
): [number, Uint8Array | ByteSlice][][] {
  const groups: [number, Uint8Array | ByteSlice][][] = []
  let start = 0
  let end = 0
  for (const [offset, chunk] of writes) {
    const last = groups.at(-1)
    if (last !== undefined && start <= offset && offset <= end) {
      last.push([offset, chunk])
      end = Math.max(end, offset + chunk.byteLength)
      continue
    }
    groups.push([[offset, chunk]])
    start = offset
    end = offset + chunk.byteLength
  }
  return groups
}

/**
 * Buffered writes as `overlaid` lays them over a read window: a write
 * waiting in a spool is read for the part of the window it covers, and past
 * that keeps only where it ends, so the read still reaches as far as the
 * file does. Each spool stays open until the window is read, so a handle
 * that lands and goes meanwhile still shows what it held to a read that took
 * its writes. Mirrors Python's `window_writes`.
 *
 * Args:
 *   writes: the buffered writes, in arrival order.
 *   offset: where the window starts.
 *   size: the window's length.
 */
export async function windowWrites(
  writes: readonly [number, Uint8Array | ByteSlice][],
  offset: number,
  size: number,
): Promise<[number, Uint8Array][]> {
  const spools = new Set<ByteSpool>()
  for (const [, run] of writes) if (run instanceof ByteSlice) spools.add(run.source)
  for (const spool of spools) spool.hold()
  try {
    const out: [number, Uint8Array][] = []
    for (const [at, run] of writes) {
      if (!(run instanceof ByteSlice)) {
        out.push([at, run])
        continue
      }
      const low = Math.max(at, offset)
      const high = Math.min(at + run.size, offset + size)
      if (low < high) out.push([low, await run.source.read(run.offset + low - at, high - low)])
      out.push([at + run.size, new Uint8Array()])
    }
    return out
  } finally {
    for (const spool of spools) await spool.unhold()
  }
}

/**
 * The bytes one group of buffered writes leaves, from where it starts to
 * where it reaches, a window at a time. Each window lays only the writes
 * that reach it, so a flush costs the writes plus the windows, however many
 * small edits a large file has. Mirrors Python's `run_stream`.
 *
 * Args:
 *   group: one of `runGroups`.
 */
export async function* runStream(
  group: readonly [number, Uint8Array | ByteSlice][],
): AsyncGenerator<Uint8Array> {
  const first = group[0]
  if (first === undefined) return
  const start = first[0]
  let end = start
  for (const [at, run] of group) end = Math.max(end, at + run.byteLength)
  const windows = Array.from(
    { length: Math.ceil((end - start) / MEMORY_LIMIT) },
    (): [number, Uint8Array | ByteSlice][] => [],
  )
  for (const write of group) {
    const [at, run] = write
    const last = Math.floor((at + run.byteLength - 1 - start) / MEMORY_LIMIT)
    for (let index = Math.floor((at - start) / MEMORY_LIMIT); index <= last; index++)
      windows[index]?.push(write)
  }
  for (const [index, writes] of windows.entries()) {
    const offset = start + index * MEMORY_LIMIT
    const size = Math.min(MEMORY_LIMIT, end - offset)
    yield overlaid(new Uint8Array(), offset, size, await windowWrites(writes, offset, size))
  }
}

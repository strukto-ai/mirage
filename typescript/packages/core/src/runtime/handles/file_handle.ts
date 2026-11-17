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

/** Where the file ends after the buffered writes. Mirrors Python's `write_end`. */
export function writeEnd(
  writes: readonly [number, Uint8Array | ByteSlice][],
  stored: number,
): number {
  let end = stored
  for (const [offset, chunk] of writes) end = Math.max(end, offset + chunk.byteLength)
  return end
}

/**
 * Merge each run into one pwrite payload for flush. Apply edits in arrival
 * order so the latest write wins wherever two overlap.
 *
 * Args:
 *   writes: the buffered writes, in arrival order.
 */
export function writeRuns(writes: readonly [number, Uint8Array][]): [number, Uint8Array][] {
  const runs: [number, Uint8Array][] = []
  for (const { start, end, parts } of grouped(writes)) {
    const buf = new Uint8Array(end - start)
    for (const [offset, chunk] of parts) buf.set(chunk, offset - start)
    runs.push([start, buf])
  }
  return runs
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
  const end = Math.min(offset + size, writeEnd(writes, offset + stored.byteLength))
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
 * A write inside the current run or at its end joins it. A gap or a write
 * before its start opens another run. Mirrors Python's `_grouped`.
 */
function* grouped<T extends Uint8Array | ByteSlice>(writes: readonly [number, T][]) {
  let group: { start: number; end: number; parts: [number, T][] } | undefined
  for (const [offset, chunk] of writes) {
    if (group === undefined || offset < group.start || offset > group.end) {
      if (group !== undefined) yield group
      group = { start: offset, end: offset, parts: [] }
    }
    group.parts.push([offset, chunk])
    group.end = Math.max(group.end, offset + chunk.byteLength)
  }
  if (group !== undefined) yield group
}

/** Keep each run's original writes for a streamed flush or a retry. Mirrors Python's `run_groups`. */
export function runGroups<T extends Uint8Array | ByteSlice>(
  writes: readonly [number, T][],
): [number, T][][] {
  return Array.from(grouped(writes), (group) => group.parts)
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
  const end = writeEnd(group, start)
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

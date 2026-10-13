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

import type { FlushStep } from './types.ts'

/**
 * The ops that leave the mount holding what a closing handle holds.
 *
 * A handle keeps what it wrote as byte ranges, so it owes the mount those
 * ranges and nothing it only read: another writer's bytes between them
 * stay, a file the open created or emptied included. A cut goes first,
 * then the ranges, then any growth past them. What an append-mode handle
 * wrote goes as an append, which lands at the mount's own end; any other
 * range keeps its offset, since another writer may have moved the end
 * since this handle last saw it. Mirrors Python's `plan_flush`.
 *
 * Args:
 *   baseLen: the file's length when the handle opened it.
 *   runs: the written ranges as [offset, bytes], sorted and disjoint.
 *   cut: the shortest length a truncate left the stored bytes at, or null
 *     when nothing was truncated away.
 *   size: the file's length as the handle holds it.
 *   appending: the handle was opened in append mode.
 */
export function planFlush(facts: {
  baseLen: number
  runs: readonly (readonly [number, Uint8Array])[]
  cut: number | null
  size: number
  appending: boolean
}): FlushStep[] {
  const { baseLen, runs, cut, size, appending } = facts
  const steps: FlushStep[] = []
  let end = baseLen
  if (cut !== null) {
    steps.push({ kind: 'truncate', length: cut })
    end = cut
  }
  const only = runs.length === 1 ? runs[0] : undefined
  if (appending && only?.[0] === end) {
    steps.push({ kind: 'append', data: only[1] })
    end += only[1].length
  } else {
    for (const [offset, data] of runs) {
      steps.push({ kind: 'pwrite', data, offset })
      end = Math.max(end, offset + data.length)
    }
  }
  if (size > end) steps.push({ kind: 'truncate', length: size })
  return steps
}

/**
 * The bytes a file holds once `steps` land on `data`, as a mount takes a
 * closing handle's plan: only what the handle changed, so what another
 * handle landed between its ranges stays. Mirrors Python's `apply_flush`.
 */
export function applyFlush(data: Uint8Array, steps: readonly FlushStep[]): Uint8Array {
  // One buffer for every step, grown by doubling: a copy of the whole file
  // per range would cost the file's size times the ranges a handle wrote.
  let out = data.slice()
  let length = out.length
  const reserve = (size: number): void => {
    if (size <= out.length) return
    const grown = new Uint8Array(Math.max(size, out.length * 2))
    grown.set(out.subarray(0, length))
    out = grown
  }
  // Bytes past `length` may be left from a longer past, so growth zeroes
  // them as a file's growth reads zeros.
  const extend = (size: number): void => {
    reserve(size)
    if (size > length) out.fill(0, length, size)
  }
  for (const step of steps) {
    const bytes = step.data ?? new Uint8Array()
    if (step.kind === 'write') {
      out = bytes.slice()
      length = out.length
    } else if (step.kind === 'append') {
      extend(length + bytes.length)
      out.set(bytes, length)
      length += bytes.length
    } else if (step.kind === 'pwrite') {
      const offset = step.offset ?? 0
      const end = offset + bytes.length
      if (end > length) {
        extend(end)
        length = end
      }
      out.set(bytes, offset)
    } else {
      const size = step.length ?? 0
      extend(size)
      length = size
    }
  }
  // Right-sized, so a cut does not keep the old file's whole allocation.
  return length === out.length ? out : out.slice(0, length)
}

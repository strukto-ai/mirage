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

import { encodeLine, lineOffsets, prefixOf } from './grep_offsets.ts'

const SEPARATOR = new TextEncoder().encode('--\n')

/**
 * Render selected lines with their context, GNU's separators included.
 *
 * `byteOffsets` is -b: every line carries the byte offset of its own start, a
 * context line renders it with `-` like every other field, and the `--` group
 * separator carries no fields at all. The offsets are derived from the lines
 * because this renderer is handed text rather than bytes, which is exact only
 * for text that came through `decodeLine` -- so that is what a caller must
 * hand over. The rendered line is put back with `encodeLine`, so a byte that
 * is not valid UTF-8 prints as GNU prints it rather than as U+FFFD.
 */
export function grepContextLines(
  lines: readonly string[],
  pat: RegExp,
  invert: boolean,
  lineNumbers: boolean,
  maxCount: number | null,
  afterContext: number,
  beforeContext: number,
  byteOffsets = false,
): Uint8Array[] {
  if (maxCount === 0) {
    // GNU selects no line at all under -m0, context and all, so there is
    // nothing to group and nothing to print. Read before the scan because
    // `matchIndices.length >= 0` is already true, so the check below would
    // keep the first selected line. `grepInput` and both scans in
    // `grep_scan` take the same early return.
    return []
  }
  const total = lines.length
  const offsets = byteOffsets ? lineOffsets(lines) : []
  const matchIndices: number[] = []
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? ''
    const found = pat.test(line)
    const hit = invert ? !found : found
    if (hit) {
      matchIndices.push(idx)
      if (maxCount !== null && matchIndices.length >= maxCount) break
    }
    pat.lastIndex = 0
  }
  if (matchIndices.length === 0) return []

  const printed = new Set<number>()
  const groups: number[][] = []
  let currentGroup: number[] = []

  for (const mi of matchIndices) {
    const start = Math.max(0, mi - beforeContext)
    const end = Math.min(total - 1, mi + afterContext)
    const range: number[] = []
    for (let k = start; k <= end; k++) range.push(k)
    const last = currentGroup.length > 0 ? currentGroup[currentGroup.length - 1] : undefined
    if (
      currentGroup.length > 0 &&
      last !== undefined &&
      range[0] !== undefined &&
      range[0] <= last + 1
    ) {
      for (const ln of range) {
        if (!printed.has(ln)) {
          currentGroup.push(ln)
          printed.add(ln)
        }
      }
    } else {
      if (currentGroup.length > 0) groups.push(currentGroup)
      currentGroup = []
      for (const ln of range) {
        printed.add(ln)
        currentGroup.push(ln)
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  const matchSet = new Set(matchIndices)
  const result: Uint8Array[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) result.push(SEPARATOR)
    const group = groups[gi] ?? []
    for (const ln of group) {
      const line = lines[ln] ?? ''
      const fields = prefixOf(
        lineNumbers ? ln + 1 : null,
        byteOffsets ? (offsets[ln] ?? 0) : null,
        matchSet.has(ln),
      )
      result.push(encodeLine(`${fields}${line}\n`))
    }
  }
  return result
}

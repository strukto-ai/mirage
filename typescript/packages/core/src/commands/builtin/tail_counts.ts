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

import { sizeSuffixes } from './utils/size_suffix.ts'
import { strtodDouble, strtodWhole } from './utils/strtod.ts'
import { quoteText } from '../quote.ts'

const BYTE_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  ...sizeSuffixes('bkKMGTPEZYRQ'),
}

// `tail -s`'s value, exactly as C `strtod` reads it, or null.
//
// GNU refuses the value when `xstrtod` does not consume all of it or when
// `0 <= s` is false, so the grammar and the range are two separate
// answers: `inf` is ACCEPTED (`0 <= inf`) while `nan` is refused
// (`0 <= nan` is false), and both were measured on coreutils 9.4. This
// returns the number the grammar names and leaves the range test to the
// caller, which is where GNU puts it too.
//
// `parse_seconds` in tail_counts.py is the twin.
export function parseSeconds(raw: string): number | null {
  const found = strtodWhole(raw)
  return found === null ? null : strtodDouble(found)
}

export function parseByteCount(raw: string): number {
  const match = /^([+-]?)([0-9]+)([A-Za-z]*)$/.exec(raw)
  if (match === null) throw new Error(raw)
  const sign = match[1] ?? ''
  const digits = match[2]
  const suffix = match[3] ?? ''
  const multiplier = BYTE_UNITS[suffix]
  if (digits === undefined || multiplier === undefined) throw new Error(raw)
  const count = Number.parseInt(digits, 10) * multiplier
  return sign === '-' ? -count : count
}

export function parseN(n: string | null): [number, boolean] {
  if (n === null) return [10, false]
  if (n.startsWith('+')) return [Number.parseInt(n.slice(1), 10), true]
  return [Number.parseInt(n, 10), false]
}

export interface TailCounts {
  lines: number | null
  fromLine: number | null
  byteCount: number | null
  fromByte: number | null
}

/**
 * Fill in whatever a caller left off a `TailCounts`.
 *
 * The struct is a plain object, so a caller that omits a field — or a
 * JavaScript one that passes something else entirely — supplies undefined,
 * and a bare `!== null` test waves that straight into the first branch,
 * where `slice(NaN)` quietly returns the whole input. Python's twin is a
 * dataclass whose four fields all default to None and has no such hole;
 * reading every field through `?? null` gives this side the same floor.
 */
export function normalizeCounts(counts: TailCounts): TailCounts {
  return {
    lines: counts.lines ?? null,
    fromLine: counts.fromLine ?? null,
    byteCount: counts.byteCount ?? null,
    fromByte: counts.fromByte ?? null,
  }
}

/**
 * Split tail's `-n`/`-c` values by which end they count from.
 *
 * GNU gives both flags the same sign grammar: a leading `+` counts forward
 * from the start of the input, 1-indexed, so `+0` and `+1` both mean the
 * whole thing; any other spelling counts back from the end. Every caller
 * used to apply that grammar to `-n` and take the absolute value of `-c`,
 * which silently turned `tail -c +3` into the last three bytes — so the
 * split lives here, once, beside the parser it is built from. Mirrors
 * Python's `parse_counts`.
 */
export function parseCounts(nRaw: string | null, cRaw: string | null): TailCounts {
  const counts: TailCounts = { lines: null, fromLine: null, byteCount: null, fromByte: null }
  if (nRaw !== null) {
    const [count, plusMode] = parseN(nRaw)
    if (plusMode) counts.fromLine = count
    else counts.lines = count
  }
  if (cRaw !== null) {
    const count = parseByteCount(cRaw)
    const plusMode = cRaw.startsWith('+')
    if (plusMode) counts.fromByte = count
    else counts.byteCount = count
  }
  return counts
}

// GNU-style validation for head/tail -n/-c. Mirrors Python's int() raising on
// a non-numeric value; returns the error line (with the bad value) or null.
export function numberFlagError(
  cmd: string,
  nRaw: string | null,
  cRaw: string | null,
): string | null {
  if (nRaw !== null && !/^[+-]?\d+$/.test(nRaw)) {
    return `${cmd}: invalid number of lines: '${quoteText(nRaw)}'\n`
  }
  if (cRaw !== null) {
    try {
      parseByteCount(cRaw)
    } catch {
      return `${cmd}: invalid number of bytes: '${quoteText(cRaw)}'\n`
    }
  }
  return null
}

export function tailBytes(data: Uint8Array, rawCounts: TailCounts): Uint8Array {
  const counts = normalizeCounts(rawCounts)
  if (counts.fromByte !== null) {
    // GNU counts `-c +N` from byte N, 1-indexed, so +0 and +1 both mean the
    // whole input.
    return data.slice(Math.max(0, counts.fromByte - 1))
  }
  if (counts.byteCount !== null) {
    const targetBytes = Math.abs(counts.byteCount)
    if (targetBytes === 0) return new Uint8Array(0)
    const start = Math.max(0, data.byteLength - targetBytes)
    return data.slice(start)
  }
  const parts = splitLines(data)
  const trimmed =
    parts.length > 0 && parts[parts.length - 1]?.byteLength === 0 ? parts.slice(0, -1) : parts
  let selected: Uint8Array[]
  if (counts.fromLine !== null) {
    selected = trimmed.slice(Math.max(0, counts.fromLine - 1))
  } else {
    const targetLines = Math.abs(counts.lines ?? 10)
    if (targetLines === 0) return new Uint8Array(0)
    selected = trimmed.slice(-targetLines)
  }
  if (selected.length === 0) return new Uint8Array(0)
  const result = joinWith(selected, 0x0a)
  if (data.byteLength > 0 && data[data.byteLength - 1] === 0x0a) {
    const out = new Uint8Array(result.byteLength + 1)
    out.set(result, 0)
    out[result.byteLength] = 0x0a
    return out
  }
  return result
}

function splitLines(data: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0x0a) {
      parts.push(data.subarray(start, i))
      start = i + 1
    }
  }
  parts.push(data.subarray(start))
  return parts
}

function joinWith(parts: readonly Uint8Array[], sep: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0)
  let total = 0
  for (const p of parts) total += p.byteLength
  total += parts.length - 1
  const out = new Uint8Array(total)
  let offset = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === undefined) continue
    out.set(p, offset)
    offset += p.byteLength
    if (i < parts.length - 1) {
      out[offset] = sep
      offset += 1
    }
  }
  return out
}

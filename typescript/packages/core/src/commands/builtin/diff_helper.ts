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

import { DiffOpTag } from './diff_types.ts'

export type Opcode = readonly [DiffOpTag, number, number, number, number]

interface Match {
  a: number
  b: number
  size: number
}

function findLongestMatch(
  a: readonly string[],
  b: readonly string[],
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>,
): Match {
  let besti = alo
  let bestj = blo
  let bestsize = 0
  let j2len = new Map<number, number>()
  for (let i = alo; i < ahi; i++) {
    const newJ2len = new Map<number, number>()
    const indices = b2j.get(a[i] ?? '') ?? []
    for (const j of indices) {
      if (j < blo) continue
      if (j >= bhi) break
      const k = (j2len.get(j - 1) ?? 0) + 1
      newJ2len.set(j, k)
      if (k > bestsize) {
        besti = i - k + 1
        bestj = j - k + 1
        bestsize = k
      }
    }
    j2len = newJ2len
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti -= 1
    bestj -= 1
    bestsize += 1
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize += 1
  }
  return { a: besti, b: bestj, size: bestsize }
}

function getMatchingBlocks(a: readonly string[], b: readonly string[]): Match[] {
  const b2j = new Map<string, number[]>()
  for (let j = 0; j < b.length; j++) {
    const key = b[j] ?? ''
    const arr = b2j.get(key) ?? []
    arr.push(j)
    b2j.set(key, arr)
  }
  const matches: Match[] = []
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]]
  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const [alo, ahi, blo, bhi] = entry
    const m = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j)
    if (m.size > 0) {
      matches.push(m)
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b])
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi])
      }
    }
  }
  matches.sort((x, y) => x.a - y.a || x.b - y.b)
  // merge adjacent matches
  const merged: Match[] = []
  let i = 0
  while (i < matches.length) {
    const cur = matches[i]
    if (cur === undefined) break
    const a1 = cur.a
    const b1 = cur.b
    let size = cur.size
    while (
      i + 1 < matches.length &&
      matches[i + 1]?.a === a1 + size &&
      matches[i + 1]?.b === b1 + size
    ) {
      const nxt = matches[i + 1]
      if (nxt === undefined) break
      size += nxt.size
      i += 1
    }
    merged.push({ a: a1, b: b1, size })
    i += 1
  }
  merged.push({ a: a.length, b: b.length, size: 0 })
  return merged
}

export function getOpcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  const matches = getMatchingBlocks(a, b)
  const opcodes: Opcode[] = []
  let i = 0
  let j = 0
  for (const m of matches) {
    if (i < m.a && j < m.b) opcodes.push([DiffOpTag.REPLACE, i, m.a, j, m.b] as const)
    else if (i < m.a) opcodes.push([DiffOpTag.DELETE, i, m.a, j, m.b] as const)
    else if (j < m.b) opcodes.push([DiffOpTag.INSERT, i, m.a, j, m.b] as const)
    if (m.size > 0) opcodes.push([DiffOpTag.EQUAL, m.a, m.a + m.size, m.b, m.b + m.size] as const)
    i = m.a + m.size
    j = m.b + m.size
  }
  return opcodes
}

// Mirror Python difflib's _format_range_unified: a single-line range collapses
// to just its start, and an empty range begins at the line before it (",0").
function formatRangeUnified(start: number, stop: number): string {
  const beginning = start + 1
  const length = stop - start
  if (length === 1) return String(beginning)
  if (length === 0) return `${String(beginning - 1)},0`
  return `${String(beginning)},${String(length)}`
}

export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  fromFile = '',
  toFile = '',
  n = 3,
): string[] {
  const out: string[] = []
  if (a.length === 0 && b.length === 0) return out
  const opcodes = getOpcodes(a, b)
  if (opcodes.every((op) => op[0] === DiffOpTag.EQUAL)) return out
  out.push(`--- ${fromFile}\n`)
  out.push(`+++ ${toFile}\n`)
  const groups = groupOpcodes(opcodes, n)
  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]
    if (first === undefined || last === undefined) continue
    const i1 = first[1]
    const i2 = last[2]
    const j1 = first[3]
    const j2 = last[4]
    out.push(`@@ -${formatRangeUnified(i1, i2)} +${formatRangeUnified(j1, j2)} @@\n`)
    for (const [tag, ai1, ai2, bj1, bj2] of group) {
      if (tag === DiffOpTag.EQUAL) {
        for (let k = ai1; k < ai2; k++) out.push(' ' + (a[k] ?? ''))
        continue
      }
      if (tag === DiffOpTag.REPLACE || tag === DiffOpTag.DELETE) {
        for (let k = ai1; k < ai2; k++) out.push('-' + (a[k] ?? ''))
      }
      if (tag === DiffOpTag.REPLACE || tag === DiffOpTag.INSERT) {
        for (let k = bj1; k < bj2; k++) out.push('+' + (b[k] ?? ''))
      }
    }
  }
  return out
}

function groupOpcodes(opcodes: readonly Opcode[], n: number): Opcode[][] {
  if (opcodes.length === 0) return []
  const codes = opcodes.map((op) => [...op] as [Opcode[0], number, number, number, number])
  const first = codes[0]
  const last = codes[codes.length - 1]
  if (first?.[0] === DiffOpTag.EQUAL) {
    const [, i1, i2, j1, j2] = first
    first[1] = Math.max(i1, i2 - n)
    first[3] = Math.max(j1, j2 - n)
  }
  if (last?.[0] === DiffOpTag.EQUAL) {
    const [, i1, i2, j1, j2] = last
    last[2] = Math.min(i2, i1 + n)
    last[4] = Math.min(j2, j1 + n)
  }
  const groups: Opcode[][] = []
  let current: Opcode[] = []
  for (const op of codes) {
    const [tag, i1, i2, j1, j2] = op
    if (tag === DiffOpTag.EQUAL && i2 - i1 > 2 * n) {
      current.push([DiffOpTag.EQUAL, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)] as Opcode)
      groups.push(current)
      current = [[DiffOpTag.EQUAL, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2] as Opcode]
      continue
    }
    current.push([tag, i1, i2, j1, j2] as Opcode)
  }
  if (current.length > 0 && !(current.length === 1 && current[0]?.[0] === DiffOpTag.EQUAL)) {
    groups.push(current)
  }
  return groups
}

function addrA(i1: number, i2: number): string {
  return i2 - i1 > 1 ? `${String(i1 + 1)},${String(i2)}` : String(i1 + 1)
}

function addrB(j1: number, j2: number): string {
  if (j2 - j1 > 1) return `${String(j1 + 1)},${String(j2)}`
  if (j2 - j1 === 1) return String(j1 + 1)
  return String(j1)
}

export function normalDiff(a: readonly string[], b: readonly string[]): string[] {
  const opcodes = getOpcodes(a, b)
  const out: string[] = []
  for (const [tag, i1, i2, j1, j2] of opcodes) {
    if (tag === DiffOpTag.EQUAL) continue
    if (tag === DiffOpTag.DELETE) {
      out.push(`${addrA(i1, i2)}d${String(j1)}\n`)
      for (let k = i1; k < i2; k++) {
        const line = a[k] ?? ''
        out.push('< ' + (line.endsWith('\n') ? line : line + '\n'))
      }
    } else if (tag === DiffOpTag.INSERT) {
      out.push(`${String(i1)}a${addrB(j1, j2)}\n`)
      for (let k = j1; k < j2; k++) {
        const line = b[k] ?? ''
        out.push('> ' + (line.endsWith('\n') ? line : line + '\n'))
      }
    } else {
      out.push(`${addrA(i1, i2)}c${addrB(j1, j2)}\n`)
      for (let k = i1; k < i2; k++) {
        const line = a[k] ?? ''
        out.push('< ' + (line.endsWith('\n') ? line : line + '\n'))
      }
      out.push('---\n')
      for (let k = j1; k < j2; k++) {
        const line = b[k] ?? ''
        out.push('> ' + (line.endsWith('\n') ? line : line + '\n'))
      }
    }
  }
  return out
}

export function edScript(aLines: readonly string[], bLines: readonly string[]): string[] {
  const opcodes = getOpcodes(aLines, bLines)
  const edits: string[] = []
  for (let i = opcodes.length - 1; i >= 0; i--) {
    const op = opcodes[i]
    if (op === undefined) continue
    const [tag, i1, i2, j1, j2] = op
    if (tag === DiffOpTag.EQUAL) continue
    if (tag === DiffOpTag.DELETE) {
      const addr = i2 - i1 > 1 ? `${String(i1 + 1)},${String(i2)}` : String(i1 + 1)
      edits.push(`${addr}d\n`)
    } else if (tag === DiffOpTag.INSERT) {
      edits.push(`${String(i1)}a\n`)
      for (let k = j1; k < j2; k++) {
        const line = bLines[k] ?? ''
        edits.push(line.endsWith('\n') ? line : line + '\n')
      }
      edits.push('.\n')
    } else {
      const addr = i2 - i1 > 1 ? `${String(i1 + 1)},${String(i2)}` : String(i1 + 1)
      edits.push(`${addr}c\n`)
      for (let k = j1; k < j2; k++) {
        const line = bLines[k] ?? ''
        edits.push(line.endsWith('\n') ? line : line + '\n')
      }
      edits.push('.\n')
    }
  }
  return edits
}

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

import { openStreamSync } from '../../../../rs/stream.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'

/** A step of a line diff: difflib's tag over a range of each side's lines. */
export type Opcode = readonly [
  'equal' | 'delete' | 'insert' | 'replace',
  number,
  number,
  number,
  number,
]

const DEC = new TextDecoder()

/**
 * The steps from one side's lines to the other's, as git diff takes them:
 * Myers' algorithm, each changed run then placed by git's default
 * indentation heuristic (the `git_diff` stream). Mirrors Python's
 * `line_opcodes`.
 */
export function lineOpcodes(old: readonly string[], fresh: readonly string[]): Opcode[] {
  const before = encodeText(old.join(''))
  const stream = openStreamSync('git_diff', { before: before.byteLength })
  let out: Uint8Array
  try {
    out = concat([stream.feed(before), stream.feed(encodeText(fresh.join(''))), stream.finish()])
  } finally {
    stream.close()
  }
  return DEC.decode(out)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [tag, i1, i2, j1, j2] = line.split(' ')
      return [tag, Number(i1), Number(i2), Number(j1), Number(j2)] as unknown as Opcode
    })
}

/**
 * The hunks a patch prints: the changes with `n` lines of context around
 * each, a run of more than `2n` unchanged lines splitting two. Mirrors
 * Python's `group_opcodes`.
 */
export function groupOpcodes(opcodes: readonly Opcode[], n: number): Opcode[][] {
  if (opcodes.length === 0) return []
  const codes = opcodes.map((op) => [...op] as [Opcode[0], number, number, number, number])
  const first = codes[0]
  const last = codes[codes.length - 1]
  if (first?.[0] === 'equal') {
    const [, i1, i2, j1, j2] = first
    first[1] = Math.max(i1, i2 - n)
    first[3] = Math.max(j1, j2 - n)
  }
  if (last?.[0] === 'equal') {
    const [, i1, i2, j1, j2] = last
    last[2] = Math.min(i2, i1 + n)
    last[4] = Math.min(j2, j1 + n)
  }
  const groups: Opcode[][] = []
  let current: Opcode[] = []
  for (const op of codes) {
    const [tag, i1, i2, j1, j2] = op
    if (tag === 'equal' && i2 - i1 > 2 * n) {
      current.push(['equal', i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)] as Opcode)
      groups.push(current)
      current = [['equal', Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2] as Opcode]
      continue
    }
    current.push([tag, i1, i2, j1, j2] as Opcode)
  }
  if (current.length > 0 && !(current.length === 1 && current[0]?.[0] === 'equal')) {
    groups.push(current)
  }
  return groups
}

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

import { describe, expect, it } from 'vitest'
import { groupOpcodes, lineOpcodes, type Opcode } from './opcodes.ts'

const lines = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/))

describe('lineOpcodes', () => {
  // git 2.47.3: the insertion keeps the old blank line as context and adds
  // the new one after the block, where a longest-block matcher put the blank
  // line first.
  it('puts a new block after the blank line it shares', () => {
    const old = lines('ONE = 1\n\n# Three, the\n# last of\n# them.\nTHREE = 3\n')
    const fresh = lines(
      'ONE = 1\n\n# Two.\nTWO = 2\n\n# Three, the\n# last of\n# them.\nTHREE = 3\n',
    )
    expect(lineOpcodes(old, fresh)).toEqual([
      ['equal', 0, 2, 0, 2],
      ['insert', 2, 2, 2, 5],
      ['equal', 2, 6, 5, 9],
    ])
  })

  it.each<[string, string, Opcode[]]>([
    ['', '', []],
    ['a\n', 'a\n', [['equal', 0, 1, 0, 1]]],
    [
      'a\nb',
      'a\nb\n',
      [
        ['equal', 0, 1, 0, 1],
        ['replace', 1, 2, 1, 2],
      ],
    ],
    [
      'a\nb\n',
      'a\n',
      [
        ['equal', 0, 1, 0, 1],
        ['delete', 1, 2, 1, 1],
      ],
    ],
  ])('names each step of %j to %j', (old, fresh, codes) => {
    expect(lineOpcodes(lines(old), lines(fresh))).toEqual(codes)
  })
})

describe('groupOpcodes', () => {
  it('splits hunks on a long unchanged run', () => {
    const old = Array.from({ length: 20 }, (_, i) => `${String(i)}\n`)
    const fresh = old.filter((line) => line !== '3\n' && line !== '15\n')
    expect(groupOpcodes(lineOpcodes(old, fresh), 3)).toEqual([
      [
        ['equal', 0, 3, 0, 3],
        ['delete', 3, 4, 3, 3],
        ['equal', 4, 7, 3, 6],
      ],
      [
        ['equal', 12, 15, 11, 14],
        ['delete', 15, 16, 14, 14],
        ['equal', 16, 19, 14, 17],
      ],
    ])
    expect(groupOpcodes([['equal', 0, 5, 0, 5]], 3)).toEqual([])
  })
})

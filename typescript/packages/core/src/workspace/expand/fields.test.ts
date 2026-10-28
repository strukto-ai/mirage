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
import { markGlobs } from '../../utils/glob_walk.ts'
import {
  chunksText,
  ifsJoiner,
  joinChunks,
  splatChunks,
  splitFields,
  valuePiece,
} from './fields.ts'
import { fieldBreak, piece } from './types.ts'

describe('ifsJoiner', () => {
  it.each<[string | null, string]>([
    [null, ' '],
    [',', ','],
    [', ', ','],
    ['', ''],
  ])('%j joins with %j', (ifs, joiner) => {
    expect(ifsJoiner(ifs)).toBe(joiner)
  })
})

describe('splitFields', () => {
  it.each<[string, string | null, string[]]>([
    // Unset IFS splits on blank runs and drops them at both ends.
    [' a  b\t\nc ', null, ['a', 'b', 'c']],
    // A non-blank IFS character delimits exactly one field.
    ['a,,b,', ',', ['a', '', 'b']],
    [',a', ',', ['', 'a']],
    // Blanks around a non-blank separator belong to it.
    [' a , b ,,c ', ', ', ['a', 'b', '', 'c']],
    // A blank not in IFS is text.
    ['a\tb c', ' ', ['a\tb', 'c']],
    ['a b\nc', '\n', ['a b', 'c']],
    // An empty IFS splits nothing.
    ['a b', '', ['a b']],
  ])('%j under IFS %j reads as bash reads it', async (text, ifs, fields) => {
    expect(await splitFields([piece(text, true)], ifs)).toEqual(fields)
  })

  it('joins literal text to the split edges', async () => {
    expect(await splitFields([piece('q'), piece(' a ', true), piece('r')], null)).toEqual([
      'q',
      'a',
      'r',
    ])
  })

  it('never splits quoted text', async () => {
    expect(await splitFields([piece('a b'), piece(',c', true)], ',')).toEqual(['a b', 'c'])
  })

  it('reads an empty unquoted value as no word', async () => {
    expect(await splitFields([piece('', true)], null)).toEqual([])
    expect(await splitFields([piece('  ', true)], null)).toEqual([])
  })

  it('reads empty quoted text as an empty word', async () => {
    expect(await splitFields([piece('')], null)).toEqual([''])
    expect(await splitFields([piece(''), piece(' a', true)], null)).toEqual(['', 'a'])
  })

  it('breaks between splat elements', async () => {
    const chunks = [
      piece('x'),
      piece('', true),
      fieldBreak(' '),
      piece('', true),
      fieldBreak(' '),
      piece('b c', true),
    ]
    expect(await splitFields(chunks, '')).toEqual(['x', 'b c'])
  })
})

describe('chunk helpers', () => {
  it('keeps quoted empty splat elements', async () => {
    const chunks = await splatChunks(['', '*'], ' ', true)
    expect(await splitFields(chunks, null)).toEqual(['', markGlobs('*')])
    expect(joinChunks(chunks)).toBe(' ' + markGlobs('*'))
    expect(chunksText(chunks)).toBe(' *')
  })

  it('marks only quoted values', () => {
    expect(valuePiece('a*', true)).toEqual(piece(markGlobs('a*')))
    expect(valuePiece('a*', false)).toEqual(piece('a*', true))
  })

  it('reads each break as its joiner', () => {
    expect(joinChunks([piece('a', true), fieldBreak(','), piece('b', true)])).toBe('a,b')
  })
})

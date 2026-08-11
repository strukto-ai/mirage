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
import { parseOptionWord } from './options.ts'

describe('parseOptionWord', () => {
  it('reads an operand as no option word', () => {
    expect(parseOptionWord('run.sh', null)).toBeNull()
  })

  it('reads the end-of-options markers as no option word', () => {
    expect(parseOptionWord('--', null)).toBeNull()
    expect(parseOptionWord('-', null)).toBeNull()
  })

  it('leaves a long word to the caller', () => {
    expect(parseOptionWord('--norc', null)).toBeNull()
  })

  it('enables on minus and disables on plus', () => {
    expect(parseOptionWord('-x', null)?.settings).toEqual([['xtrace', true]])
    expect(parseOptionWord('+x', null)?.settings).toEqual([['xtrace', false]])
  })

  it('keeps a cluster in written order', () => {
    const word = parseOptionWord('-eux', null)
    expect(word?.settings).toEqual([
      ['errexit', true],
      ['nounset', true],
      ['xtrace', true],
    ])
    expect(word?.other).toBe('')
  })

  it('hands back letters naming no option', () => {
    const word = parseOptionWord('-xc', null)
    expect(word?.settings).toEqual([['xtrace', true]])
    expect(word?.other).toBe('c')
    expect(word?.consumed).toBe(1)
  })

  it('reads the option named by o out of the next word', () => {
    const word = parseOptionWord('-o', 'pipefail')
    expect(word?.settings).toEqual([['pipefail', true]])
    expect(word?.consumed).toBe(2)
  })

  it('disables the option named after plus o', () => {
    expect(parseOptionWord('+o', 'xtrace')?.settings).toEqual([['xtrace', false]])
  })

  it('reads o from anywhere in a cluster', () => {
    const word = parseOptionWord('-xo', 'pipefail')
    expect(word?.settings).toEqual([
      ['xtrace', true],
      ['pipefail', true],
    ])
    expect(word?.consumed).toBe(2)
  })

  it('sets nothing for a trailing o with no following word', () => {
    const word = parseOptionWord('-o', null)
    expect(word?.settings).toEqual([])
    expect(word?.consumed).toBe(1)
  })
})

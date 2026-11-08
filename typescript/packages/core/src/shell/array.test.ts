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
import {
  ShellArray,
  arrayExtent,
  arrayGet,
  arraySet,
  buildAssocLiteral,
  buildIndexedLiteral,
  keyedWord,
  makeArray,
} from './array.ts'

describe('shell array', () => {
  it('makeArray is dense from zero', () => {
    const arr = makeArray(['a', 'b'])
    expect([...arr.elements]).toEqual([
      [0n, 'a'],
      [1n, 'b'],
    ])
    expect([...arr.elements.keys()]).toEqual([0n, 1n])
  })

  it('arraySet holds only the element it assigns', () => {
    const arr = new ShellArray()
    arraySet(arr, 3, 'v')
    expect([...arr.elements]).toEqual([[3n, 'v']])
    // An index no write reached is no element.
    expect(arr.elements.size).toBe(1)
    expect([...arr.elements.values()]).toEqual(['v'])
    expect([...arr.elements.keys()]).toEqual([3n])
    expect(arrayExtent(arr)).toBe(4n)
    expect(arrayGet(arr, 0)).toBe('')
    expect(arr.elements.has(0n)).toBe(false)
    expect(arr.elements.has(3n)).toBe(true)
  })

  it('a hole can be reassigned', () => {
    const arr = new ShellArray(
      new Map([
        [0n, 'x'],
        [2n, 'z'],
      ]),
    )
    arraySet(arr, 1, 'new')
    expect([...arr.elements.values()]).toEqual(['x', 'new', 'z'])
    expect([...arr.elements.keys()]).toEqual([0n, 1n, 2n])
    expect(arr.elements.size).toBe(3)
  })

  it('an empty string is an element, not a hole', () => {
    const arr = makeArray(['', 'y'])
    expect(arr.elements.size).toBe(2)
    expect([...arr.elements.keys()]).toEqual([0n, 1n])
    expect([...arr.elements.values()]).toEqual(['', 'y'])
  })

  it('a far index holds one element', () => {
    const arr = makeArray(['a'])
    arraySet(arr, 1_000_000_000, 'far')
    expect(arr.elements.size).toBe(2)
    expect(arrayExtent(arr)).toBe(1_000_000_001n)
    expect([...arr.elements.keys()]).toEqual([0n, 1_000_000_000n])
  })
})

describe('keyedWord', () => {
  it('splits on the first ]=', () => {
    expect(keyedWord('[a]=1')).toEqual(['a', '1'])
    expect(keyedWord('[two words]=v x')).toEqual(['two words', 'v x'])
    expect(keyedWord('plain')).toBeNull()
    expect(keyedWord('[]=x')).toBeNull()
    expect(keyedWord('[k]=')).toEqual(['k', ''])
    // The split lands on the first `]=`, so a value may hold one.
    expect(keyedWord('[a]=x]=y')).toEqual(['a', 'x]=y'])
  })
})

describe('buildIndexedLiteral', () => {
  it('places subscripted elements and continues from them', async () => {
    const intOf = (t: string) => Promise.resolve(Number(t))
    const built = await buildIndexedLiteral(null, ['[3]=x', 'y', '[1]=z'], false, intOf)
    expect([...built.elements]).toEqual([
      [1n, 'z'],
      [3n, 'x'],
      [4n, 'y'],
    ])
    // `+=` starts the cursor at the extent; last index wins.
    const appended = await buildIndexedLiteral(makeArray(['a']), ['b', '[0]=A'], true, intOf)
    expect([...appended.elements.values()]).toEqual(['A', 'b'])
  })
})

describe('buildAssocLiteral', () => {
  it('keys, pairs, merges, and refuses plain words in keyed form', () => {
    const keyed = buildAssocLiteral(null, ['[a]=1', 'b', '[a]=2'], false)
    expect(keyed.map).toEqual({ a: '2' })
    expect(keyed.badWords).toEqual(['b'])
    const pairs = buildAssocLiteral(null, ['k1', 'v1', '[a]=1'], false)
    expect(pairs.map).toEqual({ k1: 'v1', '[a]=1': '' })
    expect(pairs.badWords).toEqual([])
    expect(buildAssocLiteral({ a: '1' }, ['[b]=2'], true).map).toEqual({ a: '1', b: '2' })
    expect(buildAssocLiteral({ a: '1' }, ['[b]=2'], false).map).toEqual({ b: '2' })
  })
})

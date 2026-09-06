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
  type ShellArray,
  arrayCount,
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayIndices,
  arraySet,
  arraySlice,
  arrayUnset,
  arrayValues,
  buildAssocLiteral,
  buildIndexedLiteral,
  keyedWord,
  makeArray,
} from './array.ts'

describe('shell array', () => {
  it('makeArray is dense from zero', () => {
    const arr = makeArray(['a', 'b'])
    expect(arr).toEqual(['a', 'b'])
    expect(arrayIndices(arr)).toEqual([0, 1])
  })

  it('arraySet pads with holes, not empty strings', () => {
    const arr: ShellArray = []
    arraySet(arr, 3, 'v')
    expect(arr).toEqual([null, null, null, 'v'])
    // The hole is addressable but is not an element.
    expect(arrayCount(arr)).toBe(1)
    expect(arrayValues(arr)).toEqual(['v'])
    expect(arrayIndices(arr)).toEqual([3])
    expect(arrayExtent(arr)).toBe(4)
    expect(arrayGet(arr, 0)).toBe('')
    expect(arrayHas(arr, 0)).toBe(false)
    expect(arrayHas(arr, 3)).toBe(true)
  })

  it('unsetting an interior element keeps the later indices', () => {
    const arr = makeArray(['zero', 'one', 'two'])
    arrayUnset(arr, 1)
    expect(arr).toEqual(['zero', null, 'two'])
    expect(arrayGet(arr, 2)).toBe('two')
    expect(arrayCount(arr)).toBe(2)
    expect(arrayIndices(arr)).toEqual([0, 2])
  })

  it('unsetting a trailing element shrinks the extent', () => {
    const arr = makeArray(['x', 'y', 'z'])
    arrayUnset(arr, 2)
    expect(arr).toEqual(['x', 'y'])
    expect(arrayExtent(arr)).toBe(2)
  })

  it('unsetting a trailing element drops earlier holes too', () => {
    const arr = makeArray(['x', 'y', 'z'])
    arrayUnset(arr, 1)
    arrayUnset(arr, 2)
    expect(arr).toEqual(['x'])
  })

  it('unsetting an out-of-range index is a no-op', () => {
    const arr = makeArray(['x'])
    arrayUnset(arr, 5)
    arrayUnset(arr, -1)
    expect(arr).toEqual(['x'])
  })

  it('a hole can be reassigned', () => {
    const arr = makeArray(['x', 'y', 'z'])
    arrayUnset(arr, 1)
    arraySet(arr, 1, 'new')
    expect(arr).toEqual(['x', 'new', 'z'])
    expect(arrayCount(arr)).toBe(3)
  })

  it('slicing keeps subscripts, not ordinals', () => {
    const arr: ShellArray = []
    arraySet(arr, 1, 'b')
    arraySet(arr, 3, 'd')
    arraySet(arr, 9, 'j')
    // Offset 2 means "index >= 2", not "skip the first two values".
    expect(arraySlice(arr, 2, null)).toEqual(['d', 'j'])
    expect(arraySlice(arr, 0, null)).toEqual(['b', 'd', 'j'])
    expect(arraySlice(arr, 4, null)).toEqual(['j'])
    expect(arraySlice(arr, 20, null)).toEqual([])
  })

  it('slice length counts elements taken', () => {
    const arr: ShellArray = []
    arraySet(arr, 1, 'b')
    arraySet(arr, 3, 'd')
    arraySet(arr, 9, 'j')
    expect(arraySlice(arr, 2, 1)).toEqual(['d'])
    expect(arraySlice(arr, 0, 2)).toEqual(['b', 'd'])
    expect(arraySlice(arr, 0, -1)).toEqual(['b', 'd'])
  })

  it('a negative slice offset counts from the extent', () => {
    const arr: ShellArray = []
    arraySet(arr, 1, 'b')
    arraySet(arr, 9, 'j')
    expect(arraySlice(arr, -1, null)).toEqual(['j'])
    // Still negative after the extent is added: nothing, not everything.
    expect(arraySlice(arr, -20, null)).toEqual([])
    expect(arraySlice(makeArray(['x', 'y', 'z']), -5, null)).toEqual([])
    expect(arraySlice(makeArray(['x', 'y', 'z']), -2, null)).toEqual(['y', 'z'])
  })

  it('an empty string is an element, not a hole', () => {
    const arr = makeArray(['', 'y'])
    expect(arrayCount(arr)).toBe(2)
    expect(arrayIndices(arr)).toEqual([0, 1])
    expect(arrayValues(arr)).toEqual(['', 'y'])
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
    expect(built).toEqual([null, 'z', null, 'x', 'y'])
    // `+=` starts the cursor at the extent; last index wins.
    const appended = await buildIndexedLiteral(['a'], ['b', '[0]=A'], true, intOf)
    expect(appended).toEqual(['A', 'b'])
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

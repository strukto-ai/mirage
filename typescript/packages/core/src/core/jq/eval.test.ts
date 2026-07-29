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
import { hasTopLevelSpread, jqEval } from './eval.ts'
import { JQ_EMPTY } from './format.ts'

describe('jq eval (libjq adapter)', () => {
  it('identity', async () => {
    expect(await jqEval({ a: 1 }, '.')).toEqual({ a: 1 })
  })

  it('dot access', async () => {
    expect(await jqEval({ name: 'alice' }, '.name')).toBe('alice')
  })

  it('nested dot access', async () => {
    expect(await jqEval({ a: { b: { c: 42 } } }, '.a.b.c')).toBe(42)
  })

  it('array index', async () => {
    expect(await jqEval([10, 20, 30], '.[1]')).toBe(20)
  })

  it('array spread with map-like pipe', async () => {
    const data = [{ n: 1 }, { n: 2 }]
    expect(await jqEval(data, '.[] | .n')).toEqual([1, 2])
  })

  it('length', async () => {
    expect(await jqEval([1, 2, 3], 'length')).toBe(3)
    expect(await jqEval('hello', 'length')).toBe(5)
    expect(await jqEval({ a: 1, b: 2 }, 'length')).toBe(2)
  })

  it('keys', async () => {
    expect(await jqEval({ c: 1, a: 2, b: 3 }, 'keys')).toEqual(['a', 'b', 'c'])
  })

  it('map with identity', async () => {
    expect(await jqEval([1, 2, 3], 'map(.)')).toEqual([1, 2, 3])
  })

  it('map with type', async () => {
    expect(await jqEval([1, 'a', null], 'map(type)')).toEqual(['number', 'string', 'null'])
  })

  it('select filters', async () => {
    expect(await jqEval([1, 2, 3, 4], 'map(select(. > 2))')).toEqual([3, 4])
  })

  it('sort_by', async () => {
    const data = [{ n: 3 }, { n: 1 }, { n: 2 }]
    expect(await jqEval(data, 'sort_by(.n)')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('group_by', async () => {
    const data = [
      { kind: 'a', v: 1 },
      { kind: 'b', v: 2 },
      { kind: 'a', v: 3 },
    ]
    expect(await jqEval(data, 'group_by(.kind)')).toEqual([
      [
        { kind: 'a', v: 1 },
        { kind: 'a', v: 3 },
      ],
      [{ kind: 'b', v: 2 }],
    ])
  })

  it('object construction', async () => {
    const data = { name: 'alice', age: 30 }
    expect(await jqEval(data, '{name, age}')).toEqual({ name: 'alice', age: 30 })
  })

  it('has', async () => {
    expect(await jqEval({ a: 1 }, 'has("a")')).toBe(true)
    expect(await jqEval({ a: 1 }, 'has("b")')).toBe(false)
  })

  it('add', async () => {
    expect(await jqEval([1, 2, 3], 'add')).toBe(6)
    expect(await jqEval(['a', 'b'], 'add')).toBe('ab')
  })

  it('unique', async () => {
    expect(await jqEval([1, 2, 2, 3, 1], 'unique')).toEqual([1, 2, 3])
  })

  it('reverse on array', async () => {
    expect(await jqEval([1, 2, 3], 'reverse')).toEqual([3, 2, 1])
  })

  it('reverse on string raises (real jq is strict)', async () => {
    await expect(jqEval('hello', 'reverse')).rejects.toThrow()
  })

  it('string interpolation', async () => {
    expect(await jqEval({ name: 'alice' }, '"hi \\(.name)"')).toBe('hi alice')
  })

  it('comparison', async () => {
    expect(await jqEval({ n: 5 }, '.n > 3')).toBe(true)
    expect(await jqEval({ n: 5 }, '.n == 5')).toBe(true)
  })

  it('pipe chains', async () => {
    expect(await jqEval([{ n: 3 }, { n: 1 }], 'sort_by(.n) | .[0].n')).toBe(1)
  })

  it('alt operator //', async () => {
    expect(await jqEval({ a: null }, '.a // "default"')).toBe('default')
    expect(await jqEval({ a: 'x' }, '.a // "default"')).toBe('x')
  })

  it('if-then-else-end', async () => {
    expect(await jqEval(5, 'if . > 3 then "big" else "small" end')).toBe('big')
    expect(await jqEval(1, 'if . > 3 then "big" else "small" end')).toBe('small')
  })

  it('array slice', async () => {
    expect(await jqEval([1, 2, 3, 4, 5], '.[1:3]')).toEqual([2, 3])
  })

  it('type', async () => {
    expect(await jqEval('s', 'type')).toBe('string')
    expect(await jqEval([], 'type')).toBe('array')
    expect(await jqEval({}, 'type')).toBe('object')
    expect(await jqEval(null, 'type')).toBe('null')
  })

  it('not (real jq: only null and false are falsy)', async () => {
    expect(await jqEval(false, 'not')).toBe(true)
    expect(await jqEval(null, 'not')).toBe(true)
    expect(await jqEval(0, 'not')).toBe(false)
    expect(await jqEval(1, 'not')).toBe(false)
    expect(await jqEval([], 'not')).toBe(false)
  })

  it('empty drops item inside map', async () => {
    expect(await jqEval([1, 2, 3], 'map(if . == 2 then empty else . end)')).toEqual([1, 3])
  })
})

describe('jq eval — libjq-only features (regression suite)', () => {
  it('parens (.x | y)', async () => {
    expect(await jqEval({ items: [1, 2, 3] }, '(.items | length)')).toBe(3)
  })

  it('parens in object value', async () => {
    expect(await jqEval({ items: [1, 2, 3] }, '{n: (.items | length), first: .items[0]}')).toEqual({
      n: 3,
      first: 1,
    })
  })

  it('array construction collects spread outputs', async () => {
    const data = { slides: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    expect(await jqEval(data, '[.slides[].id]')).toEqual(['a', 'b', 'c'])
  })

  it('array construction wraps single value', async () => {
    expect(await jqEval({ x: 5 }, '[.x]')).toEqual([5])
  })

  it('object literal value with comma inside list', async () => {
    expect(await jqEval({}, '{x: 1, y: [1,2,3]}')).toEqual({ x: 1, y: [1, 2, 3] })
  })

  it('nested object construction', async () => {
    expect(await jqEval({ a: 1, b: 2 }, '{outer: {x: .a, y: .b}}')).toEqual({
      outer: { x: 1, y: 2 },
    })
  })

  it('join with separator', async () => {
    expect(await jqEval(['a', 'b', 'c'], 'join("-")')).toBe('a-b-c')
  })

  it('join empty separator', async () => {
    expect(await jqEval(['foo', 'bar'], 'join("")')).toBe('foobar')
  })

  it('array construction then join', async () => {
    const data = { slides: [{ id: 'a' }, { id: 'b' }] }
    expect(await jqEval(data, '[.slides[].id] | join(",")')).toBe('a,b')
  })

  it('recurse (..) with type filter', async () => {
    const data = { a: 1, b: { c: 2, d: { e: 3 } } }
    expect(await jqEval(data, '[.. | numbers] | sort')).toEqual([1, 2, 3])
  })

  it('split / join round trip', async () => {
    expect(await jqEval('a-b-c', 'split("-")')).toEqual(['a', 'b', 'c'])
    expect(await jqEval(['a', 'b', 'c'], 'join("-")')).toBe('a-b-c')
  })

  it('to_entries / from_entries', async () => {
    expect(await jqEval({ a: 1, b: 2 }, 'to_entries')).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ])
    expect(await jqEval([{ key: 'x', value: 9 }], 'from_entries')).toEqual({ x: 9 })
  })

  it('startswith / endswith', async () => {
    expect(await jqEval('foobar', 'startswith("foo")')).toBe(true)
    expect(await jqEval('foobar', 'endswith("bar")')).toBe(true)
    expect(await jqEval('foobar', 'startswith("xyz")')).toBe(false)
  })

  it('test (regex)', async () => {
    expect(await jqEval('hello world', 'test("w.rld")')).toBe(true)
    expect(await jqEval('hello world', 'test("xyz")')).toBe(false)
  })

  it('walk transform', async () => {
    const data = { a: 'FOO', b: ['BAR', 'BAZ'] }
    expect(await jqEval(data, 'walk(if type == "string" then ascii_downcase else . end)')).toEqual({
      a: 'foo',
      b: ['bar', 'baz'],
    })
  })

  it('top-level select that drops everything returns JQ_EMPTY sentinel', async () => {
    expect(await jqEval({ x: 5 }, 'select(.x > 100)')).toBe(JQ_EMPTY)
  })

  it('try / .missing returns null (real jq: missing key is not an error)', async () => {
    expect(await jqEval({}, 'try .missing.x catch "fb"')).toBeNull()
  })

  it('try / catch triggers on real error', async () => {
    expect(await jqEval([1, 2, 3], 'try .name catch "fb"')).toBe('fb')
  })

  it('missing dict key returns null in real jq (no throw)', async () => {
    expect(await jqEval({ a: 1 }, '.b')).toBeNull()
  })

  it('dot key on array raises (real jq is strict)', async () => {
    await expect(jqEval([1, 2, 3], '.name')).rejects.toThrow()
  })
})

describe('jq eval — user expressions that broke the homegrown parser', () => {
  const slidesDoc = () => ({
    title: 'Deck',
    slides: [
      {
        objectId: 's1',
        pageElements: [
          {
            shape: {
              shapeType: 'TITLE',
              text: {
                textElements: [
                  { textRun: { content: 'Hello ' } },
                  { paragraphMarker: {} },
                  { textRun: { content: 'world' } },
                ],
              },
            },
          },
        ],
      },
      {
        objectId: 's2',
        pageElements: [
          {
            shape: {
              shapeType: 'TEXT_BOX',
              text: {
                textElements: [{ textRun: { content: 'Bye' } }],
              },
            },
          },
        ],
      },
    ],
  })

  it('flat select(.textRun != null) then join', async () => {
    const expr =
      '[.slides[].pageElements[].shape.text.textElements[] | select(.textRun != null) | .textRun.content] | join("")'
    expect(await jqEval(slidesDoc(), expr)).toBe('Hello worldBye')
  })

  it('per-slide [content] then join, collected', async () => {
    const expr =
      '[.slides[] | [.pageElements[].shape.text.textElements[].textRun.content] | join("")]'
    expect(await jqEval(slidesDoc(), expr)).toEqual(['Hello world', 'Bye'])
  })

  it('full slides summary object with nested constructions', async () => {
    const expr =
      '{title: .title, slideCount: (.slides | length), slides: [.slides[] | {objectId, elements: [.pageElements[] | select(.shape != null) | {type: .shape.shapeType, text: [.shape.text.textElements[].textRun.content] | join("")}]}]}'
    expect(await jqEval(slidesDoc(), expr)).toEqual({
      title: 'Deck',
      slideCount: 2,
      slides: [
        {
          objectId: 's1',
          elements: [{ type: 'TITLE', text: 'Hello world' }],
        },
        {
          objectId: 's2',
          elements: [{ type: 'TEXT_BOX', text: 'Bye' }],
        },
      ],
    })
  })
})

describe('hasTopLevelSpread', () => {
  it('detects a top-level spread', () => {
    expect(hasTopLevelSpread('.a[]')).toBe(true)
    expect(hasTopLevelSpread('.[] | .name')).toBe(true)
  })

  it('does not treat a spread inside a collector as top level', () => {
    // `[.a[] | .t]` emits ONE array, so the caller must print one line.
    expect(hasTopLevelSpread('[.a[] | .t]')).toBe(false)
    expect(hasTopLevelSpread('[["H"]] + [.[] | [.]]')).toBe(false)
  })

  it('does not treat a spread inside parens as top level', () => {
    expect(hasTopLevelSpread('([.a[]] | length)')).toBe(false)
  })

  it('ignores a bracket pair inside a string literal', () => {
    expect(hasTopLevelSpread('.a | test("[]")')).toBe(false)
  })

  it('does not treat an index or slice as a spread', () => {
    expect(hasTopLevelSpread('.values[1:]')).toBe(false)
    expect(hasTopLevelSpread('.a[0]')).toBe(false)
  })
})

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
import { jqEval, referencesArgs, referencesInputs } from './eval.ts'

/**
 * Evaluate expr and return its single output.
 *
 * jqEval is arity-preserving, so a program that emits one value still comes
 * back as a one-element list. Tests of single-valued programs go through
 * here, which asserts the arity instead of assuming it.
 */
async function evalOne(obj: unknown, expr: string): Promise<unknown> {
  const outputs = await jqEval(obj, expr)
  expect(outputs).toHaveLength(1)
  return outputs[0]
}

describe('jq eval (libjq adapter)', () => {
  it('identity', async () => {
    expect(await evalOne({ a: 1 }, '.')).toEqual({ a: 1 })
  })

  it('dot access', async () => {
    expect(await evalOne({ name: 'alice' }, '.name')).toBe('alice')
  })

  it('nested dot access', async () => {
    expect(await evalOne({ a: { b: { c: 42 } } }, '.a.b.c')).toBe(42)
  })

  it('array index', async () => {
    expect(await evalOne([10, 20, 30], '.[1]')).toBe(20)
  })

  it('array spread with map-like pipe', async () => {
    const data = [{ n: 1 }, { n: 2 }]
    expect(await jqEval(data, '.[] | .n')).toEqual([1, 2])
  })

  it('length', async () => {
    expect(await evalOne([1, 2, 3], 'length')).toBe(3)
    expect(await evalOne('hello', 'length')).toBe(5)
    expect(await evalOne({ a: 1, b: 2 }, 'length')).toBe(2)
  })

  it('keys', async () => {
    expect(await evalOne({ c: 1, a: 2, b: 3 }, 'keys')).toEqual(['a', 'b', 'c'])
  })

  it('map with identity', async () => {
    expect(await evalOne([1, 2, 3], 'map(.)')).toEqual([1, 2, 3])
  })

  it('map with type', async () => {
    expect(await evalOne([1, 'a', null], 'map(type)')).toEqual(['number', 'string', 'null'])
  })

  it('select filters', async () => {
    expect(await evalOne([1, 2, 3, 4], 'map(select(. > 2))')).toEqual([3, 4])
  })

  it('sort_by', async () => {
    const data = [{ n: 3 }, { n: 1 }, { n: 2 }]
    expect(await evalOne(data, 'sort_by(.n)')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('group_by', async () => {
    const data = [
      { kind: 'a', v: 1 },
      { kind: 'b', v: 2 },
      { kind: 'a', v: 3 },
    ]
    expect(await evalOne(data, 'group_by(.kind)')).toEqual([
      [
        { kind: 'a', v: 1 },
        { kind: 'a', v: 3 },
      ],
      [{ kind: 'b', v: 2 }],
    ])
  })

  it('object construction', async () => {
    const data = { name: 'alice', age: 30 }
    expect(await evalOne(data, '{name, age}')).toEqual({ name: 'alice', age: 30 })
  })

  it('has', async () => {
    expect(await evalOne({ a: 1 }, 'has("a")')).toBe(true)
    expect(await evalOne({ a: 1 }, 'has("b")')).toBe(false)
  })

  it('add', async () => {
    expect(await evalOne([1, 2, 3], 'add')).toBe(6)
    expect(await evalOne(['a', 'b'], 'add')).toBe('ab')
  })

  it('unique', async () => {
    expect(await evalOne([1, 2, 2, 3, 1], 'unique')).toEqual([1, 2, 3])
  })

  it('reverse on array', async () => {
    expect(await evalOne([1, 2, 3], 'reverse')).toEqual([3, 2, 1])
  })

  it('reverse on string raises (real jq is strict)', async () => {
    await expect(jqEval('hello', 'reverse')).rejects.toThrow()
  })

  it('string interpolation', async () => {
    expect(await evalOne({ name: 'alice' }, '"hi \\(.name)"')).toBe('hi alice')
  })

  it('comparison', async () => {
    expect(await evalOne({ n: 5 }, '.n > 3')).toBe(true)
    expect(await evalOne({ n: 5 }, '.n == 5')).toBe(true)
  })

  it('pipe chains', async () => {
    expect(await evalOne([{ n: 3 }, { n: 1 }], 'sort_by(.n) | .[0].n')).toBe(1)
  })

  it('alt operator //', async () => {
    expect(await evalOne({ a: null }, '.a // "default"')).toBe('default')
    expect(await evalOne({ a: 'x' }, '.a // "default"')).toBe('x')
  })

  it('if-then-else-end', async () => {
    expect(await evalOne(5, 'if . > 3 then "big" else "small" end')).toBe('big')
    expect(await evalOne(1, 'if . > 3 then "big" else "small" end')).toBe('small')
  })

  it('array slice', async () => {
    expect(await evalOne([1, 2, 3, 4, 5], '.[1:3]')).toEqual([2, 3])
  })

  it('type', async () => {
    expect(await evalOne('s', 'type')).toBe('string')
    expect(await evalOne([], 'type')).toBe('array')
    expect(await evalOne({}, 'type')).toBe('object')
    expect(await evalOne(null, 'type')).toBe('null')
  })

  it('not (real jq: only null and false are falsy)', async () => {
    expect(await evalOne(false, 'not')).toBe(true)
    expect(await evalOne(null, 'not')).toBe(true)
    expect(await evalOne(0, 'not')).toBe(false)
    expect(await evalOne(1, 'not')).toBe(false)
    expect(await evalOne([], 'not')).toBe(false)
  })

  it('empty drops item inside map', async () => {
    expect(await evalOne([1, 2, 3], 'map(if . == 2 then empty else . end)')).toEqual([1, 3])
  })

  it('empty produces no output at the top level', async () => {
    expect(await jqEval({}, 'empty')).toEqual([])
  })
})

describe('jq eval — libjq-only features (regression suite)', () => {
  it('parens (.x | y)', async () => {
    expect(await evalOne({ items: [1, 2, 3] }, '(.items | length)')).toBe(3)
  })

  it('parens in object value', async () => {
    expect(await evalOne({ items: [1, 2, 3] }, '{n: (.items | length), first: .items[0]}')).toEqual(
      {
        n: 3,
        first: 1,
      },
    )
  })

  it('array construction collects spread outputs', async () => {
    const data = { slides: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    expect(await evalOne(data, '[.slides[].id]')).toEqual(['a', 'b', 'c'])
  })

  it('array construction wraps single value', async () => {
    expect(await evalOne({ x: 5 }, '[.x]')).toEqual([5])
  })

  it('object literal value with comma inside list', async () => {
    expect(await evalOne({}, '{x: 1, y: [1,2,3]}')).toEqual({ x: 1, y: [1, 2, 3] })
  })

  it('nested object construction', async () => {
    expect(await evalOne({ a: 1, b: 2 }, '{outer: {x: .a, y: .b}}')).toEqual({
      outer: { x: 1, y: 2 },
    })
  })

  it('join with separator', async () => {
    expect(await evalOne(['a', 'b', 'c'], 'join("-")')).toBe('a-b-c')
  })

  it('join empty separator', async () => {
    expect(await evalOne(['foo', 'bar'], 'join("")')).toBe('foobar')
  })

  it('array construction then join', async () => {
    const data = { slides: [{ id: 'a' }, { id: 'b' }] }
    expect(await evalOne(data, '[.slides[].id] | join(",")')).toBe('a,b')
  })

  it('recurse (..) with type filter', async () => {
    const data = { a: 1, b: { c: 2, d: { e: 3 } } }
    expect(await evalOne(data, '[.. | numbers] | sort')).toEqual([1, 2, 3])
  })

  it('split / join round trip', async () => {
    expect(await evalOne('a-b-c', 'split("-")')).toEqual(['a', 'b', 'c'])
    expect(await evalOne(['a', 'b', 'c'], 'join("-")')).toBe('a-b-c')
  })

  it('to_entries / from_entries', async () => {
    expect(await evalOne({ a: 1, b: 2 }, 'to_entries')).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ])
    expect(await evalOne([{ key: 'x', value: 9 }], 'from_entries')).toEqual({ x: 9 })
  })

  it('startswith / endswith', async () => {
    expect(await evalOne('foobar', 'startswith("foo")')).toBe(true)
    expect(await evalOne('foobar', 'endswith("bar")')).toBe(true)
    expect(await evalOne('foobar', 'startswith("xyz")')).toBe(false)
  })

  it('test (regex)', async () => {
    expect(await evalOne('hello world', 'test("w.rld")')).toBe(true)
    expect(await evalOne('hello world', 'test("xyz")')).toBe(false)
  })

  it('walk transform', async () => {
    const data = { a: 'FOO', b: ['BAR', 'BAZ'] }
    expect(await evalOne(data, 'walk(if type == "string" then ascii_downcase else . end)')).toEqual(
      {
        a: 'foo',
        b: ['bar', 'baz'],
      },
    )
  })

  it('top-level select that drops everything produces no output', async () => {
    expect(await jqEval({ x: 5 }, 'select(.x > 100)')).toEqual([])
  })

  it('try / .missing returns null (real jq: missing key is not an error)', async () => {
    expect(await evalOne({}, 'try .missing.x catch "fb"')).toBeNull()
  })

  it('try / catch triggers on real error', async () => {
    expect(await evalOne([1, 2, 3], 'try .name catch "fb"')).toBe('fb')
  })

  it('missing dict key returns null in real jq (no throw)', async () => {
    expect(await evalOne({ a: 1 }, '.b')).toBeNull()
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
    expect(await evalOne(slidesDoc(), expr)).toBe('Hello worldBye')
  })

  it('per-slide [content] then join, collected', async () => {
    const expr =
      '[.slides[] | [.pageElements[].shape.text.textElements[].textRun.content] | join("")]'
    expect(await evalOne(slidesDoc(), expr)).toEqual(['Hello world', 'Bye'])
  })

  it('full slides summary object with nested constructions', async () => {
    const expr =
      '{title: .title, slideCount: (.slides | length), slides: [.slides[] | {objectId, elements: [.pageElements[] | select(.shape != null) | {type: .shape.shapeType, text: [.shape.text.textElements[].textRun.content] | join("")}]}]}'
    expect(await evalOne(slidesDoc(), expr)).toEqual({
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

describe('jq eval — output arity', () => {
  it('a comma is two outputs, not one array', async () => {
    expect(await jqEval({ a: 1, b: 2 }, '.a, .b')).toEqual([1, 2])
  })

  it('a comma over arrays keeps each array whole', async () => {
    expect(await jqEval({ a: 1, b: 2 }, '[.a], [.b]')).toEqual([[1], [2]])
  })

  it('a collector emits one output that is an array', async () => {
    expect(await jqEval({ a: [{ t: 'x' }, { t: 'y' }] }, '[.a[] | .t]')).toEqual([['x', 'y']])
  })

  it('spreads with no bracket pair in the program', async () => {
    expect(await jqEval(null, 'range(3)')).toEqual([0, 1, 2])
    expect(await jqEval({ a: 1 }, '..')).toEqual([{ a: 1 }, 1])
  })

  it('a bracket pair inside a string literal is one output', async () => {
    expect(await jqEval({ a: 'x[]y' }, '.a | contains("[]")')).toEqual([true])
  })
})

describe('named args and inputs', () => {
  it('binds $name from named args', async () => {
    expect(await jqEval({ a: 1 }, '[.a, $v]', { v: 'hi' })).toEqual([[1, 'hi']])
  })

  it('carries JSON values', async () => {
    expect(await jqEval(null, '$v', { v: { k: [1, 2] } })).toEqual([{ k: [1, 2] }])
  })

  it('yields the bound documents from inputs', async () => {
    expect(await jqEval(null, '[inputs]', {}, [1, 2, 3])).toEqual([[1, 2, 3]])
  })

  it('lets a program define its own inputs', async () => {
    expect(await jqEval(null, 'def inputs: 9; [inputs]', {}, [1, 2])).toEqual([[9]])
  })

  it('finds whole-word inputs references only', () => {
    expect(referencesInputs('[inputs]')).toBe(true)
    expect(referencesInputs('reduce inputs as $x (0; . + $x)')).toBe(true)
    expect(referencesInputs('.myinputs')).toBe(false)
    expect(referencesInputs('.inputs_total')).toBe(false)
  })

  it('ignores the word where it spells data', () => {
    expect(referencesInputs('.inputs')).toBe(false)
    expect(referencesInputs('.a.inputs')).toBe(false)
    expect(referencesInputs('$inputs')).toBe(false)
    expect(referencesInputs('{inputs: .a}')).toBe(false)
    expect(referencesInputs('{inputs}')).toBe(false)
    expect(referencesInputs('{a, inputs}')).toBe(false)
    expect(referencesInputs('m::inputs')).toBe(false)
  })

  it('ignores strings and comments', () => {
    expect(referencesInputs('"no inputs found"')).toBe(false)
    expect(referencesInputs('. # drains inputs')).toBe(false)
    expect(referencesInputs('"a\\("b" + "inputs")c"')).toBe(false)
  })

  it('reads calls in every value position', () => {
    expect(referencesInputs('{a: inputs}')).toBe(true)
    expect(referencesInputs('{(inputs): 1}')).toBe(true)
    expect(referencesInputs('[1, inputs, 2]')).toBe(true)
    expect(referencesInputs('"\\(inputs)"')).toBe(true)
  })

  it('reads $ARGS the same way', () => {
    expect(referencesArgs('$ARGS.positional')).toBe(true)
    expect(referencesArgs('{$ARGS}')).toBe(true)
    expect(referencesArgs('"$ARGS"')).toBe(false)
    expect(referencesArgs('. # $ARGS')).toBe(false)
    expect(referencesArgs('$ARGSX')).toBe(false)
  })
})

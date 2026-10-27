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

import { describe, expect, it, vi } from 'vitest'
import { JqCompileError } from './errors.ts'
import {
  jqCheck,
  jqEval,
  jqRaised,
  jqRun,
  jqRunTexts,
  referencesArgs,
  streamReads,
} from './eval.ts'
import type { JqRun } from './types.ts'

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

  it('takes the first unread document for input', async () => {
    expect(await jqEval(null, 'input', {}, [{ n: 1 }, { n: 2 }])).toEqual([{ n: 1 }])
  })

  it('leaves inputs the documents after the one input took', async () => {
    expect(await jqEval(null, 'input as $h | [$h, [inputs]]', {}, [1, 2, 3])).toEqual([[1, [2, 3]]])
    expect(await jqEval(null, '[input, inputs]', {}, [1, 2, 3])).toEqual([[1, 2, 3]])
  })

  it('fails input with break once nothing is left, as jq does', async () => {
    await expect(jqEval(null, 'input', {}, [])).rejects.toThrow(/break/)
    expect(await jqEval(null, 'try input catch .', {}, [])).toEqual(['break'])
  })

  it('binds values past the WebAssembly stack size', async () => {
    const big = 'x'.repeat(2_000_000)
    expect(await jqEval(null, '$x | length', { x: big })).toEqual([2_000_000])
    const docs = Array.from({ length: 20_480 }, () => ({ k: 'x'.repeat(90) }))
    expect(await jqEval(null, '[inputs] | length', {}, docs)).toEqual([20_480])
    expect(
      await jqEval(null, '$ARGS.named.x | length', { x: big }, null, { named: { x: big } }),
    ).toEqual([2_000_000])
  })

  it('reports a compile error on the line the program wrote it', async () => {
    await expect(jqEval(null, '1 +', { x: 1 })).rejects.toThrow(/at <top-level>, line 1,/)
    await expect(jqEval(null, '.\n| 1 +', {}, [])).rejects.toThrow(/at <top-level>, line 2,/)
  })

  it('keeps a trailing comment from swallowing the program', async () => {
    expect(await jqEval(null, '$x # the bound value', { x: 1 })).toEqual([1])
  })

  it('skips a named arg no variable can spell', async () => {
    expect(await jqEval(null, '$ok', { 'a-b': 1, ok: 2 })).toEqual([2])
  })

  it('keeps jq refusing an empty program when something is bound', async () => {
    await expect(jqEval(null, '# nothing', { x: 1 })).rejects.toThrow(/Top-level program not given/)
  })

  it('finds whole-word stream references only', () => {
    expect(streamReads('[inputs]')).toEqual({ input: false, inputs: true })
    expect(streamReads('reduce inputs as $x (0; . + $x)').inputs).toBe(true)
    expect(streamReads('input')).toEqual({ input: true, inputs: false })
    expect(streamReads('input as $h | [inputs]')).toEqual({ input: true, inputs: true })
    expect(streamReads('.myinputs').inputs).toBe(false)
    expect(streamReads('.inputs_total').inputs).toBe(false)
    expect(streamReads('input_filename').input).toBe(false)
    expect(streamReads('input_line_number').input).toBe(false)
  })

  it('ignores the words where they spell data', () => {
    for (const expr of [
      '.inputs',
      '.a.inputs',
      '$inputs',
      '{inputs: .a}',
      '{inputs}',
      '{a, inputs}',
      'm::inputs',
    ]) {
      expect(streamReads(expr).inputs).toBe(false)
    }
    for (const expr of ['.input', '$input', '{input: 1}', '{input}', 'm::input']) {
      expect(streamReads(expr).input).toBe(false)
    }
  })

  it('ignores strings and comments', () => {
    expect(streamReads('"no inputs found"').inputs).toBe(false)
    expect(streamReads('. # drains inputs').inputs).toBe(false)
    expect(streamReads('"a\\("b" + "inputs")c"').inputs).toBe(false)
    expect(streamReads('"read the input"').input).toBe(false)
  })

  it('ignores a function the program defines for itself', () => {
    expect(streamReads('def input: 1; input').input).toBe(false)
    expect(streamReads('def inputs: 9; [inputs]').inputs).toBe(false)
    expect(streamReads('def f(x): x; f(input)').input).toBe(true)
  })

  it('reads calls in every value position', () => {
    expect(streamReads('{a: inputs}').inputs).toBe(true)
    expect(streamReads('{(inputs): 1}').inputs).toBe(true)
    expect(streamReads('[1, inputs, 2]').inputs).toBe(true)
    expect(streamReads('"\\(inputs)"').inputs).toBe(true)
    expect(streamReads('{a: input}').input).toBe(true)
  })

  it('reads $ARGS the same way', () => {
    expect(referencesArgs('$ARGS.positional')).toBe(true)
    expect(referencesArgs('{$ARGS}')).toBe(true)
    expect(referencesArgs('"$ARGS"')).toBe(false)
    expect(referencesArgs('. # $ARGS')).toBe(false)
    expect(referencesArgs('$ARGSX')).toBe(false)
  })
})

describe('jqRun', () => {
  it.each<[string, JqRun]>([
    [
      '.a, error("boom"), .a',
      { outputs: [1], stop: { kind: 'error', text: 'boom', string: true } },
    ],
    ['error({"b": 2})', { outputs: [], stop: { kind: 'error', text: '{"b":2}', string: false } }],
    ['error(null)', { outputs: [], stop: { kind: 'error', text: 'null', string: false } }],
    ['error("null")', { outputs: [], stop: { kind: 'error', text: 'null', string: true } }],
    [
      '.a | .b',
      {
        outputs: [],
        stop: { kind: 'error', text: 'Cannot index number with string ("b")', string: true },
      },
    ],
    [
      '"bye\\n" | halt_error',
      { outputs: [], stop: { kind: 'halt', message: 'bye\n', string: true, code: 5 } },
    ],
    [
      '[1] | halt_error(2)',
      { outputs: [], stop: { kind: 'halt', message: '[1]', string: false, code: 2 } },
    ],
    [
      'null | halt_error',
      { outputs: [], stop: { kind: 'halt', message: null, string: false, code: 5 } },
    ],
    [
      '"a", halt',
      { outputs: ['a'], stop: { kind: 'halt', message: null, string: false, code: null } },
    ],
    [
      '1, [halt_error(2)], 3',
      { outputs: [1], stop: { kind: 'halt', message: '{"a":1}', string: false, code: 2 } },
    ],
    [
      '[.a] | map(halt_error(4))',
      { outputs: [], stop: { kind: 'halt', message: '1', string: false, code: 4 } },
    ],
    [
      '{"__mirage_jq_error": [true, "x"]}',
      { outputs: [{ __mirage_jq_error: [true, 'x'] }], stop: null },
    ],
    [
      'try ("failure" | halt_error(3)) catch "continued"',
      { outputs: [], stop: { kind: 'halt', message: 'failure', string: true, code: 3 } },
    ],
    [
      'try (.a, halt) catch "c"',
      { outputs: [1], stop: { kind: 'halt', message: null, string: false, code: null } },
    ],
    ['try error("x") catch .', { outputs: ['x'], stop: null }],
  ])('hands back what stopped %s', async (expr, run) => {
    expect(await jqRun({ a: 1 }, expr)).toEqual(run)
  })

  it('reads a halt whose message no second run recovers as the default', async () => {
    // A halt in the program's own `try` inside a collector still ends the
    // run, but neither redefinition hands its message back.
    expect(await jqRun(1, '[try halt_error(2) catch "c"]')).toEqual({
      outputs: [],
      stop: { kind: 'halt', message: null, string: false, code: 5 },
    })
  })

  it('reads a halt back past outputs that differ from run to run', async () => {
    // `now` prints another value when the program runs again for the halt.
    const run = await jqRun(null, 'now, ("x" | halt_error(3))')
    expect([run.outputs.length, run.stop]).toEqual([
      1,
      { kind: 'halt', message: 'x', string: true, code: 3 },
    ])
  })

  it("reads jq's own clock at each call, in a program that can halt too", async () => {
    // jq-wasm's `now` reads Date.now, here a clock that moves a second at
    // each reading.
    let ms = 1_790_000_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (ms += 1000))
    try {
      const run = await jqRun(null, '[now, now], halt')
      const [first, second] = run.outputs[0] as number[]
      expect(second).toBeGreaterThan(first ?? Infinity)
    } finally {
      clock.mockRestore()
    }
  })

  it('leaves named arguments named like the prelude variables to the program', async () => {
    const named = {
      __mirage_jq_value: 'v',
      __mirage_jq_named: 'n',
      __mirage_jq_inputs: 'i',
      __mirage_jq_args: 'a',
    }
    const program =
      '., [$__mirage_jq_value, $__mirage_jq_named, $__mirage_jq_inputs, $__mirage_jq_args], ' +
      'input, ($ARGS.named | keys)'
    expect(await jqRun({ a: 1 }, program, named, [2], { positional: [], named })).toEqual({
      outputs: [{ a: 1 }, ['v', 'n', 'i', 'a'], 2, Object.keys(named).sort()],
      stop: null,
    })
  })

  it('refuses a halt code that is not a number as jq does', async () => {
    expect(await jqRun(1, 'halt_error("x")')).toEqual({
      outputs: [],
      stop: { kind: 'error', text: 'number (1) halt_error/1: number required', string: true },
    })
  })

  it("keeps the program's own line numbers", async () => {
    expect((await jqRun(null, '$__loc__ | .line')).outputs).toEqual([1])
    expect((await jqRun(null, '$__loc__ | .line', {}, [])).outputs).toEqual([1])
  })

  it('refuses code that closes the prelude early as jq refuses it', async () => {
    await expect(jqRun(1, '1) catch 2 | try (3')).rejects.toThrow(JqCompileError)
  })

  it('reads a compile error as the program numbers its lines', async () => {
    await expect(jqRun(1, '.a |\n  nosuch(1)', {}, null, { positional: [] })).rejects.toThrow(
      /line 2, column/,
    )
  })
})

// gojq tells an error the program raised with `error` from a builtin's, which
// jq never does; each verdict is gh 2.85's gojq's.
describe('jqRaised', () => {
  it.each<[string, boolean]>([
    ['.a, error("boom")', true],
    ['error({"b": 2})', true],
    ['error(null)', true],
    ['"x" | error', true],
    ['try (.a | .b) catch error', true],
    ['[error("in")]', true],
    ['first(error("in"))', true],
    ['label $out | error("in")', true],
    ['{v:error("tight")}', true],
    ['def f: error("in f"); try f catch error', true],
    ['(try error("x") catch .), error("y")', true],
    ['try error("x") catch error("wrapped: " + .)', true],
    ['now, error("x")', true],
    ['[now] | .[0], error("y")', true],
    ['range(20000), error("many")', true],
    ['.a | .b', false],
    ['label $out | .a | .b', false],
    ['try error("x") catch (.a | .b)', false],
    ['(try error("x") catch .), (.a | .b)', false],
    ['.error, (.a | .b)', false],
    ['"error" as $e | .a | .b # error', false],
    ['def error: 7; error | .b', false],
    ['limit(-1; .a)', false],
  ])('tells who raised the error %s stopped at', async (expr, raised) => {
    const run = await jqRun({ a: 1 }, expr)
    expect(run.stop?.kind).toBe('error')
    expect(await jqRaised({ a: 1 }, expr, run)).toBe(raised)
  })

  it("reads an error no rerun can speak for as a builtin's", async () => {
    // Neither rerun can speak for it: the catch reads the wrapped value in
    // the first, and the mark rides into the error in the second.
    const expr = '(try error("x") catch .) as $m | error($m + "!")'
    const run = await jqRun(null, expr)
    expect(run.stop).toEqual({ kind: 'error', text: 'x!', string: true })
    expect(await jqRaised(null, expr, run)).toBe(false)
  })

  it('is false for a run no error stopped', async () => {
    expect(await jqRaised(1, '"a", halt', await jqRun(1, '"a", halt'))).toBe(false)
    expect(await jqRaised(1, '.', await jqRun(1, '.'))).toBe(false)
  })
})

describe('jqCheck', () => {
  it('compiles a program without running it', async () => {
    await jqCheck('repeat(1)')
    await expect(jqCheck('1 +')).rejects.toThrow(/1 compile error$/)
  })
})

// jqRunTexts runs on JSON text and hands back jq's own dump of each output;
// every expectation is what jq 1.8.2 prints for the same program.
describe('jqRunTexts', () => {
  it('keeps every literal and the key order jq reads', async () => {
    expect(
      await jqRunTexts('{"b":1,"1":2,"a":{"z":1,"0":2}}', '., keys, keys_unsorted, (. + {"c":3})'),
    ).toEqual({
      outputs: [
        '{"b":1,"1":2,"a":{"z":1,"0":2}}',
        '["1","a","b"]',
        '["b","1","a"]',
        '{"b":1,"1":2,"a":{"z":1,"0":2},"c":3}',
      ],
      stop: null,
    })
    const run = await jqRunTexts(
      '[1.000, 1e2, -0, 100000000000000000001]',
      '.[], (.[3] + 1), (.[0] | tojson), map(. * 1)',
    )
    expect(run.outputs).toEqual([
      '1.000',
      '1E+2',
      '-0',
      '100000000000000000001',
      '1e+20',
      '"1.000"',
      '[1,100,-0,1e+20]',
    ])
  })

  it('reads the environment it is given', async () => {
    const env = '{"HOME":"/home/a"}'
    expect(
      await jqRunTexts('null', '[$ENV.HOME, env.HOME]', new Map(), null, null, null, env),
    ).toEqual({ outputs: ['["/home/a","/home/a"]'], stop: null })
    expect(
      await jqRunTexts(
        'null',
        '[$ENV, env.HOME]',
        new Map([['ENV', '"x"']]),
        null,
        null,
        null,
        env,
      ),
    ).toEqual({ outputs: ['[{"HOME":"/home/a"},"/home/a"]'], stop: null })
    expect(await jqRunTexts('null', 'def env: 1; env', new Map(), null, null, null, env)).toEqual({
      outputs: ['1'],
      stop: null,
    })
  })

  it("reports errors and halts in jq's own spelling", async () => {
    expect((await jqRunTexts('1.000', '. + "a"')).stop).toEqual({
      kind: 'error',
      text: 'number (1.000) and string ("a") cannot be added',
      string: true,
    })
    expect((await jqRunTexts('{"b":1.000,"1":2}', 'error')).stop).toEqual({
      kind: 'error',
      text: '{"b":1.000,"1":2}',
      string: false,
    })
    expect((await jqRunTexts('{"b":1.000,"1":2}', 'halt_error')).stop).toEqual({
      kind: 'halt',
      message: '{"b":1.000,"1":2}',
      string: false,
      code: 5,
    })
  })

  it('binds its arguments and unread documents as text', async () => {
    const run = await jqRunTexts(
      'null',
      '$v, $ARGS, input, [inputs]',
      new Map([['v', '{"b":1,"1":2.50}']]),
      ['1.0', '2.00', '3e2'],
      '{"positional":[1.0],"named":{"v":{"b":1,"1":2.50}}}',
    )
    expect(run.outputs).toEqual([
      '{"b":1,"1":2.50}',
      '{"positional":[1.0],"named":{"v":{"b":1,"1":2.50}}}',
      '1.0',
      '[2.00,3E+2]',
    ])
  })

  it('meets the parse error past the unread documents', async () => {
    const message = 'Unfinished JSON term at EOF at line 1, column 3'
    expect(await jqRunTexts('null', '[inputs]', new Map(), ['1.0'], null, message)).toEqual({
      outputs: [],
      stop: { kind: 'error', text: message, string: true },
    })
  })

  it('dumps a program whose comment carries on past its line', async () => {
    // jq 1.8.2 carries a comment over a backslash at its line's end, so a
    // program ending in one is run as typed, and still dumped.
    expect(await jqRunTexts('5.0', '. # c \\')).toEqual({ outputs: ['5.0'], stop: null })
    expect(await jqRunTexts('5.0', '[.] # c')).toEqual({ outputs: ['[5.0]'], stop: null })
  })

  it('hands a pretty-printed document to jq-wasm compacted, as the same value', async () => {
    const doc = '{\n  "b": [\n    1.000,\n    " a \\" b "\n  ],\n  "1": {}\n}'
    expect(await jqRunTexts(doc, '., tojson')).toEqual({
      outputs: [
        '{"b":[1.000," a \\" b "],"1":{}}',
        '"{\\"b\\":[1.000,\\" a \\\\\\" b \\"],\\"1\\":{}}"',
      ],
      stop: null,
    })
  })

  it.each(['42', 'empty', 'error("shadow")'])(
    'dumps outputs independently of tojson defined as %s',
    async (definition) => {
      const doc = '{"b":1.000,"1":[-0,100000000000000000001]}'
      for (const suffix of ['', ' # c', ' # c \\']) {
        expect(await jqRunTexts(doc, `def tojson: ${definition}; .${suffix}`)).toEqual({
          outputs: [doc],
          stop: null,
        })
      }
    },
  )

  it('preserves user calls and each output when dumping an as-typed program', async () => {
    expect(await jqRunTexts('1.000', 'def tojson: 42; ., tojson # c \\')).toEqual({
      outputs: ['1.000', '42'],
      stop: null,
    })
  })

  it('preserves bindings and unread documents when dumping an as-typed program', async () => {
    expect(
      await jqRunTexts(
        'null',
        'def tojson: empty; $v, $ARGS, input, [inputs] # c \\',
        new Map([['v', '{"b":1.000,"1":2}']]),
        ['-0', '1e2'],
        '{"positional":[2.50],"named":{}}',
      ),
    ).toEqual({
      outputs: ['{"b":1.000,"1":2}', '{"positional":[2.50],"named":{}}', '-0', '[1E+2]'],
      stop: null,
    })
  })
})

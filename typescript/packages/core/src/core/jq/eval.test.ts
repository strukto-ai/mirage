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
import { Engine, localZone, readFrames, type Ending } from './eval.ts'

/**
 * Every output of a jq program on one value, run to its end in mirage-rs's
 * jq_eval with no input left to read. Throws jq's refusal of the program, or
 * the error that ended the run.
 */
async function jqEval(obj: unknown, expr: string): Promise<unknown[]> {
  const engine = await Engine.open(expr, '{}', 'UTC')
  const ending: Ending = { stop: null }
  const outputs: unknown[] = []
  try {
    for await (const text of engine.run(JSON.stringify(obj), ending)) {
      outputs.push(JSON.parse(text))
    }
  } finally {
    await engine.close()
  }
  if (ending.stop?.kind === 'error') throw new Error(ending.stop.text)
  return outputs
}

/**
 * Evaluate expr and return its single output.
 *
 * jqEval keeps every output, so a program that emits one value still comes
 * back as a one-element list. Tests of single-valued programs go through
 * here, which asserts the arity instead of assuming it.
 */
async function evalOne(obj: unknown, expr: string): Promise<unknown> {
  const outputs = await jqEval(obj, expr)
  expect(outputs).toHaveLength(1)
  return outputs[0]
}

describe('jq eval', () => {
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

describe('jq eval — regression suite', () => {
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

const ENC = new TextEncoder()

function frame(tag: number, payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === 'string' ? ENC.encode(payload) : payload
  const out = new Uint8Array(5 + body.length)
  out[0] = tag
  new DataView(out.buffer).setUint32(1, body.length, true)
  out.set(body, 5)
  return out
}

describe('the engine gh --jq runs', () => {
  it('folds frames into outputs and the stop that ended the run', () => {
    const outputs: Uint8Array[] = []
    const wire = new Uint8Array([
      ...frame(1, '1'),
      ...frame(4, '["DEBUG:",1]'),
      ...frame(1, '2'),
      ...frame(5, 'x'),
      ...frame(2, new Uint8Array([0, ...ENC.encode('{}')])),
    ])
    expect(readFrames(wire, outputs)).toEqual({
      kind: 'error',
      text: '{}',
      string: false,
      own: false,
    })
    expect(outputs).toEqual([ENC.encode('1'), ENC.encode('2')])
    expect(readFrames(frame(2, new Uint8Array([3, ...ENC.encode('x')])), [])).toEqual({
      kind: 'error',
      text: 'x',
      string: true,
      own: true,
    })
    expect(readFrames(frame(3, '{"message":"bye","string":true,"code":3.0}'), [])).toEqual({
      kind: 'halt',
      message: 'bye',
      string: true,
      code: 3,
    })
    expect(() => readFrames(frame(9, ''), [])).toThrow()
  })

  it("reads the zone from the session's TZ, else the process's, else the runtime's", () => {
    const saved = process.env.TZ
    process.env.TZ = 'EST5EDT'
    try {
      expect(localZone({ TZ: ':Asia/Tokyo' })).toBe(':Asia/Tokyo')
      expect(localZone({ TZ: '' })).toBe('')
      expect(localZone({})).toBe('EST5EDT')
      delete process.env.TZ
      expect(localZone(undefined)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it('finds no more input and drops what debug and stderr write', async () => {
    const engine = await Engine.open('(1 | debug), ("x" | stderr), try input catch .', '{}', 'UTC')
    const ending: Ending = { stop: null }
    const outputs: string[] = []
    try {
      for await (const text of engine.run('null', ending)) outputs.push(text)
    } finally {
      await engine.close()
    }
    expect(outputs).toEqual(['1', '"x"', '"break"'])
    expect(ending.stop).toBeNull()
  })

  it('cancels a run its reader stops, so the next can begin', async () => {
    const engine = await Engine.open('., until(false; .)', '{}', 'UTC')
    try {
      for (const doc of ['1', '2']) {
        const values = engine.run(doc, { stop: null })
        expect((await values.next()).value).toBe(doc)
        await values.return()
      }
    } finally {
      await engine.close()
    }
  })

  it("refuses a program with jq's report", async () => {
    await expect(Engine.open('if', '{}', 'UTC')).rejects.toThrow(/\njq: 1 compile error$/)
    await expect(Engine.open('import "a" as a; .', '{}', 'UTC')).rejects.toThrow(
      /^jq: error: module not found: a\n\njq: 1 compile error$/,
    )
  })
})

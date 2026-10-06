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
import { JqParser } from './parse.ts'
import { InputReader, READ_CHUNK, piecesThrough, readTexts, valueText } from './stream.ts'
import { JqParseError, NO_VALUE, jqOptions, type InputSource, type JqOptions } from './types.ts'
import { eacces, eisdir, enoent } from '../../errors/fs.ts'

const ENC = new TextEncoder()

/** The value jq's parser reads a text as, which is what libjq runs on. */
function parsed(text: unknown): unknown {
  expect(typeof text).toBe('string')
  const parser = new JqParser()
  parser.feed(ENC.encode(text as string), false)
  const value = parser.next()
  expect(value).not.toBeInstanceOf(JqParseError)
  expect(parser.next()).toBe(NO_VALUE)
  return value
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0))
}

async function* chunked(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
}

function sources(inputs: readonly Uint8Array[], size = 1 << 20): InputSource[] {
  return inputs.map((data, i) => ({ name: `f${String(i)}.json`, chunks: chunked(data, size) }))
}

type Row = [unknown, string] | ['error', string, string]

async function read(
  inputs: InputSource[],
  opts: JqOptions = jqOptions(),
  asTexts = false,
): Promise<Row[]> {
  const reader = new InputReader(inputs, opts)
  const rows: Row[] = []
  for (;;) {
    const text = await reader.nextInput()
    if (text === NO_VALUE) return rows
    if (text instanceof JqParseError) {
      rows.push(['error', text.message, reader.position()])
      if (!opts.seq) return rows
      continue
    }
    rows.push([asTexts ? text : parsed(text), reader.position()])
  }
}

async function values(inputs: readonly Uint8Array[], opts = jqOptions()): Promise<unknown[]> {
  return (await read(sources(inputs), opts)).map((row) => row[0])
}

async function texts(
  inputs: readonly Uint8Array[],
  opts = jqOptions(),
  size = 1 << 20,
): Promise<unknown[]> {
  return (await read(sources(inputs, size), opts, true)).map((row) => row[0])
}

describe('InputReader', () => {
  it.each([1, 3, 1 << 20])(
    'reads the inputs as one stream for one parser (chunks of %i)',
    async (size) => {
      expect((await read(sources([bytes('1'), bytes('2')], size))).map((row) => row[0])).toEqual([
        12,
      ])
      expect((await read(sources([bytes('[1,'), bytes('2]')], size))).map((row) => row[0])).toEqual(
        [[1, 2]],
      )
    },
  )

  it('places a value where the reader holds it whole', async () => {
    expect(await read(sources([bytes('1'), bytes(' 2\n')]))).toEqual([
      [1, 'f1.json:1'],
      [2, 'f1.json:1'],
    ])
    expect(await read(sources([bytes('1\n'), bytes('2\n3')]))).toEqual([
      [1, 'f0.json:1'],
      [2, 'f1.json:1'],
      [3, 'f1.json:1'],
    ])
    expect(await read(sources([bytes('1\n2\n'), bytes('[3,\n4]\n5')]))).toEqual([
      [1, 'f0.json:1'],
      [2, 'f0.json:2'],
      [[3, 4], 'f1.json:2'],
      [5, 'f1.json:2'],
    ])
  })

  function linesBefore(rows: Row[], count: number): [number, number] {
    const lines = rows
      .slice(0, count)
      .map((row) => Number(String(row[row.length - 1]).split(':')[1]))
    return [lines.filter((line) => line === 0).length, lines.filter((line) => line === 1).length]
  }

  it('counts a long line once the reader holds its last piece', async () => {
    // jq 1.8.2 reads a long line 4091 bytes at a time: of 4095 values on one
    // 8190-byte line, only the last four arrive with its newline.
    const rows = await read(sources([bytes('1 '.repeat(4095) + '\n2\n')]))
    expect(linesBefore(rows, 4095)).toEqual([4091, 4])
  })

  it('reads a piece on to the end of a character', async () => {
    // The first piece ends inside an é, reads one more byte to finish it,
    // and so every later piece starts a byte on (pinned: 2044 and 56).
    const text = ENC.encode('"a' + 'é'.repeat(2045) + '"  ' + '1 '.repeat(2100) + '\n')
    const rows = await read(sources([text]))
    expect(linesBefore(rows.slice(1), 2100)).toEqual([2044, 56])
  })

  it.each([1, 5, 1 << 20])('reads JSON Lines a line at a time (chunks of %i)', async (size) => {
    const data = bytes('{"a":1}\n{"a":2}\n\n{"a":3}\n')
    expect(await read(sources([data], size))).toEqual([
      [{ a: 1 }, 'f0.json:1'],
      [{ a: 2 }, 'f0.json:2'],
      [{ a: 3 }, 'f0.json:4'],
    ])
  })

  it.each([1, 5, 1 << 20])('reads a pretty-printed document whole (chunks of %i)', async (size) => {
    const data = bytes('{\n  "a": [\n    1,\n    2\n  ]\n}\n{\n  "b": 3\n}\n')
    expect(await read(sources([data], size))).toEqual([
      [{ a: [1, 2] }, 'f0.json:6'],
      [{ b: 3 }, 'f0.json:9'],
    ])
  })

  it.each([
    ['{\n  "a": [\n    1\n  ]\n}\n', { a: [1] }],
    ['[\n  1,\n  2\n]\n{\n', [1, 2]],
    ['{\n"a": 1}\n', { a: 1 }],
  ])('hands a document over before the input ends (%j)', async (text, value) => {
    // Nothing past a document's closing line is read before it is handed
    // over, so an input that has not ended yet still yields it.
    async function* unending(): AsyncIterable<Uint8Array> {
      yield bytes(text)
      await new Promise<never>(() => undefined)
    }
    const reader = new InputReader([{ name: 'f0.json', chunks: unending() }], jqOptions())
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve('still waiting')
      }, 5000)
    })
    expect(parsed(await Promise.race([reader.nextInput(), late]))).toEqual(value)
    clearTimeout(timer)
  })

  it.each([1, 7, 1 << 20])(
    "sends a document not pretty-printed to jq's parser (chunks of %i)",
    async (size) => {
      const data = bytes('{\n"a": 1}\n{\n  "b": 2 }\n[\n  nan\n]\n')
      const rows = await read(sources([data], size))
      expect(rows.slice(0, 2)).toEqual([
        [{ a: 1 }, 'f0.json:2'],
        [{ b: 2 }, 'f0.json:4'],
      ])
      expect(Number.isNaN((rows[2]?.[0] as number[])[0])).toBe(true)
      expect(rows[2]?.[1]).toBe('f0.json:7')
    },
  )

  it("reads jq's own numbers and the JSON around them", async () => {
    const got = await values([bytes('[1]\nnan\n{"a":.5}\n')])
    expect(got[0]).toEqual([1])
    expect(Number.isNaN(got[1])).toBe(true)
    expect(got[2]).toEqual({ a: 0.5 })
  })

  it('leaves a lone surrogate escape to jq', async () => {
    expect(await read(sources([bytes('"\\udc00"\n"\\ud800"\n')]))).toEqual([
      ['\ufffd', 'f0.json:1'],
      ['error', 'Invalid \\uXXXX\\uXXXX surrogate pair escape at line 2, column 8', 'f0.json:2'],
    ])
  })

  it('leaves nesting past the limit to jq', async () => {
    const deep = bytes('['.repeat(10001) + '\n')
    expect(await read(sources([deep]))).toEqual([
      ['error', 'Exceeds depth limit for parsing at line 1, column 10001', 'f0.json:1'],
    ])
  })

  it('ends the stream at a parse error, after the values before it', async () => {
    expect(await read(sources([bytes('1\n2\n'), bytes('[')]))).toEqual([
      [1, 'f0.json:1'],
      [2, 'f0.json:2'],
      ['error', 'Unfinished JSON term at EOF at line 3, column 1', 'f1.json:0'],
    ])
    expect(await read(sources([bytes('{"a":1}\n1 [')]))).toEqual([
      [{ a: 1 }, 'f0.json:1'],
      [1, 'f0.json:1'],
      ['error', 'Unfinished JSON term at EOF at line 2, column 3', 'f0.json:1'],
    ])
  })

  it('strips a BOM from the start of the stream only', async () => {
    expect(await values([bytes('\xef\xbb\xbf1\n')])).toEqual([1])
    expect(await read(sources([bytes('\xef\xbb\xbf1\n'), bytes('\xef\xbb\xbf2\n')]))).toEqual([
      [1, 'f0.json:1'],
      ['error', 'Invalid numeric literal at line 3, column 0', 'f1.json:1'],
    ])
    expect(await read(sources([bytes('\xef\xbb1\n')]))).toEqual([
      ['error', 'Malformed BOM', 'f0.json:1'],
    ])
    // The BOM check goes on from one input into the next, as jq's one parser
    // keeps it.
    expect(await read(sources([bytes('\xef'), bytes('1\n')]))).toEqual([
      ['error', 'Malformed BOM', 'f1.json:1'],
    ])
  })

  it('slurps every input into one value', async () => {
    const opts = jqOptions({ slurp: true })
    expect(await values([bytes('{"a":1}'), bytes(' {"b":2}')], opts)).toEqual([
      [{ a: 1 }, { b: 2 }],
    ])
    expect(await read(sources([bytes('1\n'), bytes('[')]), opts)).toEqual([
      ['error', 'Unfinished JSON term at EOF at line 2, column 1', 'f1.json:0'],
    ])
    expect(await read(sources([bytes('1\n'), bytes('2\n3')]), opts)).toEqual([
      [[1, 2, 3], 'f1.json:1'],
    ])
  })

  it('runs a raw line on from one input into the next', async () => {
    const raw = jqOptions({ rawInput: true })
    expect(await values([bytes('x\ny'), bytes('z\n')], raw)).toEqual(['x', 'yz'])
    expect(await values([bytes('a\nb')], raw)).toEqual(['a', 'b'])
    expect(await values([bytes('')], raw)).toEqual([])
    expect(await values([bytes('\n')], raw)).toEqual([''])
    expect(await values([ENC.encode('a\u2028b\n')], raw)).toEqual(['a\u2028b'])
    expect(await values([bytes('a\xffb\n\xf0\x80\x80\x80\n')], raw)).toEqual(['a\ufffdb', '\ufffd'])
  })

  it('reads every input as one string when raw and slurped', async () => {
    const opts = jqOptions({ rawInput: true, slurp: true })
    expect(await values([bytes('x\n'), bytes('y')], opts)).toEqual(['x\ny'])
  })

  it('reports a parse error under --seq and reads on', async () => {
    const opts = jqOptions({ seq: true })
    expect(await read(sources([bytes('\x1e1\n\x1e[1 2]\n\x1e3\n')]), opts)).toEqual([
      [1, 'f0.json:1'],
      [
        'error',
        'Expected separator between values at line 2, column 6 (need RS to resync)',
        'f0.json:2',
      ],
      [3, 'f0.json:3'],
    ])
    expect(await read(sources([bytes('{"a":1}\n')]), opts)).toEqual([
      ['error', 'Unfinished abandoned text at EOF at line 2, column 0', 'f0.json:1'],
    ])
  })

  it('hands --stream events over as the input goes by', async () => {
    const opts = jqOptions({ stream: true })
    expect(await read(sources([bytes('[1,\n[2]]\n')]), opts)).toEqual([
      [[[0], 1], 'f0.json:1'],
      [[[1, 0], 2], 'f0.json:2'],
      [[[1, 0]], 'f0.json:2'],
      [[[1]], 'f0.json:2'],
    ])
    expect(await read(sources([bytes('{"a":[1,')]), opts)).toEqual([
      [[['a', 0], 1], 'f0.json:0'],
      ['error', 'Unfinished JSON term at EOF at line 1, column 8', 'f0.json:0'],
    ])
  })

  it('collects the events when streamed and slurped', async () => {
    const opts = jqOptions({ stream: true, slurp: true })
    expect(await values([bytes('[1] [2]')], opts)).toEqual([[[[0], 1], [[0]], [[0], 2], [[0]]]])
  })

  it('reads no input at all as nothing', async () => {
    const reader = new InputReader([], jqOptions())
    expect(await reader.nextInput()).toBe(NO_VALUE)
    expect(reader.position()).toBe('<unknown>')
  })

  it('finds no documents in an empty input', async () => {
    expect(await values([bytes('')])).toEqual([])
    expect(await values([bytes('  \n\n ')])).toEqual([])
  })

  it('keeps a __proto__ key an ordinary key', async () => {
    const [doc] = await values([bytes('{"__proto__":1,"a":[]}\n')])
    expect(Object.keys(doc as object)).toEqual(['__proto__', 'a'])
    expect(JSON.stringify(doc)).toBe('{"__proto__":1,"a":[]}')
  })

  it.each([1, 5, 1 << 20])(
    'hands a value over as the text it was read from (chunks of %i)',
    async (size) => {
      // jq keeps a number's literal and an object's key order, so libjq is
      // handed the bytes, not a value built from them.
      const data = bytes(
        '{"b":1.000,"1":2}\n{\n  "n": 100000000000000000001,\n  "e": 1e2\n}\n' +
          '[1.10, -0] "\\u00e9" nan\n',
      )
      expect(await texts([data], jqOptions(), size)).toEqual([
        '{"b":1.000,"1":2}',
        '{\n  "n": 100000000000000000001,\n  "e": 1e2\n}',
        '[1.10, -0]',
        '"\\u00e9"',
        'nan',
      ])
    },
  )

  it.each([1, 1 << 20])(
    'reads a value run on across inputs as one text (chunks of %i)',
    async (size) => {
      expect(await texts([bytes('1.'), bytes('000')], jqOptions(), size)).toEqual(['1.000'])
      expect(
        await texts([bytes('[1.0,'), bytes(' {"b":1,'), bytes('"1":2}]')], jqOptions(), size),
      ).toEqual(['[1.0, {"b":1,"1":2}]'])
    },
  )

  it('leaves the BOM out of a text and replaces bad UTF-8 as jq does', async () => {
    expect(await texts([bytes('\xef\xbb\xbf1.000\n')])).toEqual(['1.000'])
    expect(await texts([bytes('["\xff", 1.000]')])).toEqual(['["\ufffd", 1.000]'])
  })

  it('hands raw lines, --seq, --stream and -s over as text', async () => {
    expect(await texts([bytes('a"b\n')], jqOptions({ rawInput: true }))).toEqual(['"a\\"b"'])
    expect(
      await texts([bytes('\x1e1.000\n\x1e{"b":1,"1":2}\n')], jqOptions({ seq: true })),
    ).toEqual(['1.000', '{"b":1,"1":2}'])
    expect(await texts([bytes('{"b":1.000,"1":[2.50]}')], jqOptions({ stream: true }))).toEqual([
      '[["b"],1.000]',
      '[["1",0],2.50]',
      '[["1",0]]',
      '[["1"]]',
    ])
    const slurp = jqOptions({ slurp: true })
    expect(await texts([bytes('1.000 {"b":1,"1":2}\n'), bytes('[1e2]')], slurp)).toEqual([
      '[1.000,{"b":1,"1":2},[1e2]]',
    ])
    expect(await texts([], slurp)).toEqual(['[]'])
  })
})

async function* failing(
  error: Error,
  data: Uint8Array = new Uint8Array(0),
  size = 1 << 20,
): AsyncIterable<Uint8Array> {
  for await (const chunk of chunked(data, size)) yield chunk
  throw error
}

async function reported(
  inputs: InputSource[],
  opts: JqOptions = jqOptions(),
): Promise<[unknown[], string[], string, number]> {
  const reports: string[] = []
  const reader = new InputReader(inputs, opts, (line) => reports.push(line))
  const found: unknown[] = []
  for (;;) {
    const text = await reader.nextInput()
    if (text === NO_VALUE) return [found, reports, reader.position(), reader.failures()]
    found.push(parsed(text))
  }
}

const MISSING = 'jq: error: Could not open file missing.json: No such file or directory\n'

describe('InputReader over an input it cannot open or read', () => {
  it.each([1, 1 << 20])(
    'reports an input that cannot be opened and reads past it (chunks of %i)',
    async (size) => {
      // jq's reader names the input fopen refused and goes on to the next,
      // and a value runs on across it (pinned: `[1,`, missing, `2]`).
      const inputs = [
        { name: 'a.json', chunks: chunked(bytes('[1,'), size) },
        { name: 'missing.json', chunks: failing(enoent('missing')) },
        { name: 'b.json', chunks: chunked(bytes('2]\n'), size) },
      ]
      expect(await reported(inputs)).toEqual([[[1, 2]], [MISSING], 'b.json:1', 1])
    },
  )

  it('stands on a failed input it ends on', async () => {
    // `jq -n input missing.json` fails at missing.json:0 (pinned).
    const inputs = [{ name: 'missing.json', chunks: failing(enoent('missing')) }]
    expect(await reported(inputs)).toEqual([[], [MISSING], 'missing.json:0', 1])
  })

  it('reports a directory, which fails at its read, in bare words', async () => {
    // jq opens a directory and fails at its first read, which it reports as
    // the strerror alone (pinned: `jq: error: Is a directory`).
    const inputs = [{ name: 'd', chunks: failing(eisdir('d')) }, ...sources([bytes('1\n')])]
    expect(await reported(inputs)).toEqual([[1], ['jq: error: Is a directory\n'], 'f0.json:1', 1])
  })

  it.each([1, 1 << 20])(
    'loses the line a read that fails midway was reading (chunks of %i)',
    async (size) => {
      // fgets hands out every line before the failed read, and the line it
      // was reading goes with it: here the `]`, which the next input stands
      // in for.
      const inputs = [
        { name: 'a.json', chunks: failing(eacces('a'), bytes('1\n[\n  2\n]'), size) },
        ...sources([bytes(',3]\n')]),
      ]
      const [found, reports, , failures] = await reported(inputs)
      expect([found, reports, failures]).toEqual([
        [1, [2, 3]],
        ['jq: error: Permission denied\n'],
        1,
      ])
    },
  )

  it('runs a raw line on across a failed input', async () => {
    // Pinned: `x`, missing.txt, `y\n` read under -R as "xy".
    const inputs = [
      { name: 'a.txt', chunks: chunked(bytes('x'), 8) },
      { name: 'missing.txt', chunks: failing(enoent('missing')) },
      { name: 'b.txt', chunks: chunked(bytes('y\n'), 8) },
    ]
    const [found, reports] = await reported(inputs, jqOptions({ rawInput: true }))
    expect(found).toEqual(['xy'])
    expect(reports).toEqual([MISSING.replace('missing.json', 'missing.txt')])
  })

  it('raises a failed input without a reporter', async () => {
    const inputs = [{ name: 'missing.json', chunks: failing(enoent('missing')) }]
    await expect(read(inputs)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('piecesThrough', () => {
  it('ends a piece at a newline or after 4091 bytes', () => {
    const data = bytes('ab\ncd\n')
    expect(piecesThrough(data, 0)).toEqual([3, 1])
    expect(piecesThrough(data, 4)).toEqual([6, 2])
    const long = bytes('x'.repeat(READ_CHUNK + 5) + '\n')
    expect(piecesThrough(long, 10)).toEqual([READ_CHUNK, 0])
    expect(piecesThrough(long, READ_CHUNK + 1)).toEqual([long.length, 1])
  })

  it('reads a piece ending inside a character on to its end', () => {
    const head = bytes('x'.repeat(READ_CHUNK - 1))
    const data = new Uint8Array([...head, ...ENC.encode('é'), ...bytes('yz\n')])
    expect(piecesThrough(data, 0)).toEqual([READ_CHUNK + 1, 0])
  })
})

describe('readTexts', () => {
  it('reads a slurpfile as jq does', async () => {
    expect(
      await readTexts({ name: 'm.json', chunks: chunked(bytes('{"a":1.0}\n{"a":2}\n'), 4) }),
    ).toEqual([['{"a":1.0}', '{"a":2}'], null])
    expect(await readTexts({ name: 'bad.json', chunks: chunked(bytes('1 ['), 99) })).toEqual([
      ['1'],
      new JqParseError('Unfinished JSON term at EOF at line 1, column 3'),
    ])
  })
})

describe('valueText', () => {
  it('takes one value as jv_parse does', () => {
    expect(valueText(bytes('{"b":1,"1":2.50}'))).toBe('{"b":1,"1":2.50}')
    expect(valueText(bytes('nan'))).toBe('nan')
    expect(valueText(bytes(' 12 \n'))).toBe('12')
    expect(valueText(bytes('\xef\xbb\xbf1.0'))).toBe('1.0')
    expect(valueText(bytes('1 2'))).toBe(NO_VALUE)
    expect(valueText(bytes(''))).toBe(NO_VALUE)
    expect(valueText(bytes('nope'))).toBe(NO_VALUE)
    expect(valueText(bytes('[1,'))).toBe(NO_VALUE)
  })
})

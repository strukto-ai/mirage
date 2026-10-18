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

import { readFileSync } from 'node:fs'
import { loadJq, type Jq } from 'jq-wasm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JqParser, decodeUtf8, stringText, utf8Missing } from './parse.ts'
import { JqParseError, NO_VALUE } from './types.ts'

const cases = z
  .array(
    z.object({
      input: z.string(),
      seq: z.boolean(),
      streaming: z.boolean(),
      events: z.array(z.tuple([z.enum(['text', 'error']), z.string()])),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../../../integ/fixtures/jq/scanner.json', import.meta.url),
        'utf8',
      ),
    ),
  )

for (const size of [1, 7, 4091]) {
  describe(`jq scanner with chunks of ${String(size)} bytes`, () => {
    for (const [index, fixture] of cases.entries()) {
      it(`preserves text and diagnostics for fixture ${String(index)}`, async () => {
        const parser = new JqParser(fixture.seq, fixture.streaming)
        const data = Uint8Array.from(fixture.input.match(/../g) ?? [], (byte) =>
          Number.parseInt(byte, 16),
        )
        const events: [string, string][] = []
        let stopped = false
        try {
          for (let at = 0; at < Math.max(1, data.length); at += size) {
            parser.feed(data.subarray(at, at + size), at + size < data.length)
            for (;;) {
              const value = await parser.next()
              if (value === NO_VALUE) break
              if (value instanceof JqParseError) {
                events.push(['error', value.message])
                if (!fixture.seq) {
                  stopped = true
                  break
                }
              } else events.push(['text', value])
            }
            if (stopped) break
          }
          expect(events).toEqual(fixture.events)
        } finally {
          await parser.close()
        }
      })
    }
  })
}

it('decodes malformed UTF-8 using jq sequence grouping', async () => {
  for (const [data, text] of [
    [[0xe2, 0x61], '�'],
    [[0xed, 0xa0, 0x80], '�'],
    [[0xf0, 0x80, 0x80, 0x80], '�'],
    [[0xc0, 0x80], '��'],
    [[0xe2, 0x82, 0x78], '�x'],
    [[0x61, 0xff, 0x62], 'a�b'],
  ] satisfies [number[], string][])
    expect(await decodeUtf8(new Uint8Array(data))).toBe(text)
})

it('quotes host strings without altering them', () => {
  const text = 'a"\\\n\u007fé'
  expect(JSON.parse(stringText(text))).toBe(text)
})

it('finishes a reader piece inside a UTF-8 character', () => {
  expect(utf8Missing(new Uint8Array([0x61, 0xe2]))).toBe(2)
  expect(utf8Missing(new Uint8Array([0x61, 0xe2, 0x82]))).toBe(1)
  expect(utf8Missing(new Uint8Array([0x61, 0xe2, 0x82, 0xac]))).toBe(0)
})

it('cancels and discards a large unfinished input', async () => {
  const controller = new AbortController()
  const parser = new JqParser(false, false, controller.signal)
  const data = new Uint8Array(8 * 1024 * 1024).fill(0x78)
  data[0] = 0x22
  parser.feed(data, true)
  const timer = setTimeout(() => {
    controller.abort()
  }, 20)
  try {
    await expect(parser.next()).rejects.toThrow()
  } finally {
    clearTimeout(timer)
    await parser.close()
  }
})

const ENC = new TextEncoder()
const BOM = '\ufeff'

const ALPHABET: readonly string[] = [
  '{',
  '}',
  '[',
  ']',
  ':',
  ',',
  '"',
  '\\',
  ' ',
  '\n',
  '\t',
  '1',
  '0',
  '-',
  '+',
  '.',
  'e',
  'E',
  't',
  'r',
  'u',
  'n',
  'a',
  'f',
  'l',
  's',
  'x',
  '\x01',
  '\x00',
  '\xe9',
  '"a"',
  'true',
  'null',
  'false',
  '12',
  '"\\u00e9"',
  '"\\ud83d\\ude00"',
  '"\\ud800"',
  '"\\udc00"',
  '\\u',
  'nan',
  'NaN',
  'inf',
  '1e5',
  '.5',
  '"\\n"',
  '{"k":1}',
  '[1,2]',
  "'",
  BOM,
]
const SEQ_ALPHABET: readonly string[] = [...ALPHABET, '\x1e', '\x1e', '\x1e', '\x1e[1,2]\n']
const SEEDS: readonly string[] = [
  '{"a":1,"b":[1,2,{"c":null}]}',
  '[1,2,3]',
  '"str"',
  '123',
  'true',
  '{"a":{"b":{"c":[true,false]}}}',
  '[{"x":"y"},{"z":[]}]',
  '1 2 3',
  '{"a":1}\n{"b":2}\n',
  '[]',
  '{}',
  '[[[]]]',
  '-0.5e10',
  '"a\\"b"',
]
const SEQ_SEEDS: readonly string[] = [
  ...SEEDS.map((seed) => `\x1e${seed}\n`),
  '\x1e1\x1e2',
  '\x1e{"a":[1,2]}\n\x1e"x"\n',
  '\x1e[1,\x1e2\n',
]

const PARSE_ERROR = 'jq: parse error: '
const IGNORED_ERROR = 'jq: ignoring parse error: '

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randint(rng: () => number, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1))
}

function choice(rng: () => number, items: readonly string[]): string {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new Error('nothing to choose from')
  return item
}

function mutant(rng: () => number, alphabet: readonly string[], seeds: readonly string[]): string {
  if (rng() < 0.5) {
    const parts: string[] = []
    for (let n = randint(rng, 0, 12); n > 0; n -= 1) parts.push(choice(rng, alphabet))
    return parts.join('')
  }
  const text = Array.from(choice(rng, seeds))
  for (let n = randint(rng, 0, 3); n > 0; n -= 1) {
    const at = randint(rng, 0, text.length)
    const roll = rng()
    if (roll < 0.33 && text.length > 0) {
      text.splice(Math.min(at, text.length - 1), 1)
    } else if (roll < 0.66) {
      text.splice(at, 0, choice(rng, alphabet))
    } else if (text.length > 0) {
      text[Math.min(at, text.length - 1)] = choice(rng, alphabet)
    }
  }
  return text.join('')
}

interface ReferenceRun {
  readonly lines: readonly string[]
  readonly errors: readonly string[]
}

function jqReads(jq: Jq, text: string, flags: readonly string[], seq: boolean): ReferenceRun {
  const result = jq.raw(text, '.', ['-c', ...flags])
  const lines = (result.stdout === '' ? [] : result.stdout.split('\n')).map((line) => {
    if (seq && !line.startsWith('\x1e')) throw new Error(`no RS before ${line}`)
    return seq ? line.slice(1) : line
  })
  const reports = result.stderr === '' ? [] : result.stderr.split('\n')
  const prefix = seq ? IGNORED_ERROR : PARSE_ERROR
  const errors = reports.map((report) => {
    if (!report.startsWith(prefix)) throw new Error(`unexpected report: ${report}`)
    return report.slice(prefix.length)
  })
  const exit = errors.length > 0 && !seq ? 5 : 0
  if (result.exitCode !== exit) throw new Error(`unexpected exit: ${JSON.stringify(result)}`)
  return { lines, errors }
}

async function scanned(
  jq: Jq,
  data: Uint8Array,
  seq: boolean,
  streaming: boolean,
  size: number,
): Promise<ReferenceRun> {
  const parser = new JqParser(seq, streaming)
  const lines: string[] = []
  const errors: string[] = []
  try {
    for (let at = 0; at < Math.max(1, data.length); at += size) {
      parser.feed(data.subarray(at, at + size), at + size < data.length)
      for (;;) {
        const value = await parser.next()
        if (value === NO_VALUE) break
        if (value instanceof JqParseError) {
          errors.push(value.message)
          if (!seq) return { lines, errors }
        } else {
          const echoed = jq.raw(value, '.', ['-c'])
          if (echoed.exitCode !== 0) throw new Error(`invalid scanner output: ${value}`)
          lines.push(echoed.stdout)
        }
      }
    }
    return { lines, errors }
  } finally {
    await parser.close()
  }
}

let jqInstance: Promise<Jq> | undefined

function jqWasm(): Promise<Jq> {
  return (jqInstance ??= loadJq())
}

describe('JqParser against jq-wasm', () => {
  const modes = [
    { name: 'plain', flags: [], seq: false, streaming: false, count: 2500, seed: 1325 },
    { name: '--stream', flags: ['--stream'], seq: false, streaming: true, count: 800, seed: 7 },
    { name: '--seq', flags: ['--seq'], seq: true, streaming: false, count: 800, seed: 11 },
    {
      name: '--seq --stream',
      flags: ['--seq', '--stream'],
      seq: true,
      streaming: true,
      count: 400,
      seed: 13,
    },
  ]
  for (const mode of modes) {
    it(`agrees with jq 1.8.2 ${mode.name} on generated input`, async () => {
      const jq = await jqWasm()
      const rng = mulberry32(mode.seed)
      const alphabet = mode.seq ? SEQ_ALPHABET : ALPHABET
      const seeds = mode.seq ? SEQ_SEEDS : SEEDS
      for (let n = 0; n < mode.count; n += 1) {
        const text = mutant(rng, alphabet, seeds)
        const want = jqReads(jq, text, mode.flags, mode.seq)
        const data = ENC.encode(text)
        for (const size of [Math.max(1, data.length), 1]) {
          const got = await scanned(jq, data, mode.seq, mode.streaming, size)
          expect(got, JSON.stringify({ n, text, size })).toEqual(want)
        }
      }
    }, 60_000)
  }
})

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
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JqParser, decodeUtf8, readTexts, stringText, valueText } from './parse.ts'
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

it('cancels and discards a large unfinished input', async () => {
  const controller = new AbortController()
  const parser = new JqParser(false, false, controller.signal)
  parser.feed(new TextEncoder().encode('"' + '\\n'.repeat(4 * 1024 * 1024)), true)
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

it('reads a slurpfile as jq does', async () => {
  const enc = new TextEncoder()
  expect(await readTexts(enc.encode('{"a":1.0}\n{"a":2}\n'))).toEqual([
    ['{"a":1.0}', '{"a":2}'],
    null,
  ])
  expect(await readTexts(enc.encode('1 ['))).toEqual([
    ['1'],
    new JqParseError('Unfinished JSON term at EOF at line 1, column 3'),
  ])
})

it('takes one value as jv_parse does', async () => {
  const enc = new TextEncoder()
  expect(await valueText(enc.encode('{"b":1,"1":2.50}'))).toBe('{"b":1,"1":2.50}')
  expect(await valueText(enc.encode('nan'))).toBe('nan')
  expect(await valueText(enc.encode(' 12 \n'))).toBe('12')
  expect(await valueText(new Uint8Array([0xef, 0xbb, 0xbf, 0x31, 0x2e, 0x30]))).toBe('1.0')
  for (const text of ['1 2', '', 'nope', '[1,']) {
    expect(await valueText(enc.encode(text))).toBe(NO_VALUE)
  }
})

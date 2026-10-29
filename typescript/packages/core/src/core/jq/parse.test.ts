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

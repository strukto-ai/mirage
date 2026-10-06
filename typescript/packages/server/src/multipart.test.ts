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
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MultipartError, partEvents, type PartEvent } from './multipart.ts'

const BOUNDARY = 'b0undary'
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`
const HEAD = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="stdin"\r\n\r\n`)
const END = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)

function chunks(...parts: Buffer[]): AsyncIterable<Buffer> {
  return Readable.from(parts)
}

async function events(...parts: Buffer[]): Promise<PartEvent[]> {
  const got: PartEvent[] = []
  for await (const event of partEvents(chunks(...parts), CONTENT_TYPE)) got.push(event)
  return got
}

function data(got: PartEvent[]): string {
  return Buffer.concat(got.flatMap((e) => (e.kind === 'data' ? [e.data] : []))).toString()
}

describe('partEvents', () => {
  it('begins a part before its first byte', async () => {
    const reading = partEvents(chunks(HEAD, Buffer.from('ab'), END), CONTENT_TYPE)
    expect((await reading.next()).value).toEqual({ kind: 'begin', name: 'stdin' })
    const rest: PartEvent[] = []
    for await (const event of reading) rest.push(event)
    expect(data(rest)).toBe('ab')
    expect(rest.at(-1)).toEqual({ kind: 'end' })
  })

  it('keeps the data whole however the body is split', async () => {
    const stdin = `a\r\n--${BOUNDARY.slice(0, -1)}\r`
    const body = Buffer.concat([HEAD, Buffer.from(stdin), END])
    const split = Array.from({ length: Math.ceil(body.length / 3) }, (_, i) =>
      body.subarray(i * 3, i * 3 + 3),
    )
    expect(data(await events(...split))).toBe(stdin)
  })

  it.each([`a\r\n--${BOUNDARY}world`, `a\r\n--${BOUNDARY}-x`, `a\r\n--${BOUNDARY}\rx`])(
    'keeps a boundary not followed by -- or a line break as data: %j',
    async (stdin) => {
      const body = Buffer.concat([HEAD, Buffer.from(stdin), END])
      expect(data(await events(body))).toBe(stdin)
      const bytes = Array.from(body, (byte) => Buffer.from([byte]))
      expect(data(await events(...bytes))).toBe(stdin)
    },
  )

  it.each([
    [[HEAD], 'multipart/form-data', 'multipart body without a boundary'],
    [[HEAD, Buffer.from('ab')], CONTENT_TYPE, 'multipart body ended early'],
    [
      [Buffer.from(`--${BOUNDARY}\r\nX-Pad: ${'x'.repeat(5000)}\r\n\r\n`), END],
      CONTENT_TYPE,
      'bad multipart body: Maximum header size exceeded',
    ],
  ])('refuses a bad body', async (parts, contentType, detail) => {
    const reading = async (): Promise<void> => {
      for await (const _ of partEvents(chunks(...parts), contentType)) void _
    }
    const error = await reading().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MultipartError)
    expect(error).toMatchObject({ statusCode: 400, message: detail })
  })
})

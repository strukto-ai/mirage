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
import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { UploadStdin } from './stdin.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await tick()
  return done
}

describe('UploadStdin', () => {
  it('reads back in order as plain Uint8Array chunks, then ends', async () => {
    const upload = new UploadStdin()
    await upload.feed(Buffer.from('a'))
    await upload.feed(new Uint8Array())
    await upload.feed(Buffer.from('b'))
    upload.close()
    const got: Uint8Array[] = []
    for await (const chunk of upload) got.push(chunk)
    expect(got.some((c) => Buffer.isBuffer(c))).toBe(false)
    expect(got.map((c) => Buffer.from(c).toString())).toEqual(['a', 'b'])
  })

  it.each([CAPACITY, CAPACITY * 2])(
    'makes a %i-byte upload wait for the reader',
    async (capacity) => {
      const upload = new UploadStdin(capacity)
      for (let i = 0; i < capacity / CHUNK_SIZE; i++)
        await upload.feed(new Uint8Array(CHUNK_SIZE).fill(i))
      const blocked = upload.feed(Buffer.from('next'))
      expect(await settled(blocked)).toBe(false)
      const reading = upload[Symbol.asyncIterator]()
      expect((await reading.next()).value).toEqual(new Uint8Array(CHUNK_SIZE))
      await blocked
      upload.close()
      const remaining: Uint8Array[] = []
      for await (const chunk of reading) remaining.push(chunk)
      expect(Buffer.concat(remaining)).toEqual(
        Buffer.concat([
          ...Array.from({ length: capacity / CHUNK_SIZE - 1 }, (_, i) =>
            Buffer.alloc(CHUNK_SIZE, i + 1),
          ),
          Buffer.from('next'),
        ]),
      )
    },
  )

  it('frees a waiting feed on discard and drops the rest', async () => {
    const upload = new UploadStdin()
    for (let i = 0; i < CAPACITY / CHUNK_SIZE; i++)
      await upload.feed(new Uint8Array(CHUNK_SIZE).fill(i))
    const blocked = upload.feed(Buffer.from('next'))
    expect(await settled(blocked)).toBe(false)
    upload.discard()
    await blocked
    await upload.feed(Buffer.from('later'))
    upload.close()
    expect((await upload[Symbol.asyncIterator]().next()).done).toBe(true)
  })

  it('ends a waiting read on discard', async () => {
    const upload = new UploadStdin()
    const waiting = upload[Symbol.asyncIterator]().next()
    expect(await settled(waiting)).toBe(false)
    upload.discard()
    expect((await waiting).done).toBe(true)
  })
})

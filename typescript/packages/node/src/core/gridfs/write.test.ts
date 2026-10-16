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

import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, bucket: vi.fn() }
})

import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import * as clientMod from './client.ts'
import { DRIVER } from './driver.ts'

function fakeBucket(keys: string[]): unknown {
  return {
    openUploadStream: (key: string) => {
      keys.push(key)
      const handlers: Record<string, () => void> = {}
      return {
        // The new revision's _id, which put reports as the object's
        // token the way a real GridFSBucketWriteStream does.
        id: `oid-${String(keys.length)}`,
        on: (event: string, handler: () => void) => {
          handlers[event] = handler
        },
        end: () => {
          handlers.finish?.()
        },
      }
    },
  }
}

describe('gridfs put token', () => {
  it('reports the new revision as the object token', async () => {
    // gridfs spells a token as the uploaded revision's _id, the same
    // string `head` answers for the latest revision.
    const keys: string[] = []
    vi.mocked(clientMod.bucket).mockResolvedValue(fakeBucket(keys) as never)
    const accessor = new GridFSAccessor({
      uri: 'mongodb://localhost:27017',
      database: 'db',
    } as GridFSConfig)
    const meta = await DRIVER.put(accessor, 'a/b.txt', new TextEncoder().encode('hi'))
    expect(meta?.fingerprint).toBe('oid-1')
    expect(meta?.revision).toBe('oid-1')
    expect(meta?.size).toBe(2)
  })
})

it.each([false, true])('streams a GridFS upload and aborts failures: %s', async (fail) => {
  const parts: Uint8Array[] = []
  const abort = vi.fn(() => Promise.resolve())
  const upload = Object.assign(
    new Writable({
      write(chunk: Uint8Array, _encoding, done) {
        parts.push(chunk.slice())
        done()
      },
    }),
    { id: 'new-id', abort },
  )
  vi.mocked(clientMod.bucket).mockResolvedValue({ openUploadStream: () => upload } as never)
  const accessor = new GridFSAccessor({
    uri: 'mongodb://localhost:27017',
    database: 'db',
  } as GridFSConfig)
  let closed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      yield new TextEncoder().encode('first')
      await Promise.resolve()
      if (fail) throw new Error('producer failed')
      yield new TextEncoder().encode('last')
    } finally {
      closed = true
    }
  }
  if (DRIVER.putStream === undefined) throw new Error('stream hook missing')
  const result = DRIVER.putStream(accessor, 'a', source(), {})
  if (fail) {
    await expect(result).rejects.toThrow('producer failed')
    expect(abort).toHaveBeenCalledOnce()
  } else {
    expect(await result).toMatchObject({ size: 9, revision: 'new-id' })
    expect(Buffer.concat(parts).toString()).toBe('firstlast')
    expect(abort).not.toHaveBeenCalled()
  }
  expect(closed).toBe(true)
})

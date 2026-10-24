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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import {
  FakeStore,
  makeAccessor,
  mockedClient,
  spec,
} from '../../../tests/core/gridfs/_test_util.ts'

let store = new FakeStore()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...mockedClient(actual, () => store), bucket: vi.fn() }
})

import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import * as clientMod from './client.ts'
import { DRIVER } from './driver.ts'
import { read } from './read.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()
const A_TXT = spec('a.txt')

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

// Twins of the retention tests in tests/core/gridfs/test_write.py.
describe('gridfs retention', () => {
  beforeEach(() => {
    store = new FakeStore()
    vi.mocked(clientMod.bucket).mockImplementation(() => Promise.resolve(store as never))
  })

  it('prunes the oldest revisions on write', async () => {
    const accessor = makeAccessor(store, { keepRevisions: 2 })
    for (const data of ['v1', 'v2']) await write(accessor, A_TXT, ENC.encode(data))
    const kept = store.ids('a.txt')
    // Two revisions never fall below the two kept.
    await write(accessor, A_TXT, ENC.encode('v3'))
    const ids = store.ids('a.txt')
    expect(ids.slice(0, 1)).toEqual(kept.slice(1))
    expect(ids).toHaveLength(2)
    expect(store.chunks.has(String(kept[0]))).toBe(false)
    expect(new TextDecoder().decode(store.chunks.get(String(ids[1])))).toBe('v3')
  })

  it('counts live and trashed revisions apart', async () => {
    const accessor = makeAccessor(store, { keepRevisions: 1 })
    await write(accessor, A_TXT, ENC.encode('v1'))
    await write(accessor, A_TXT, ENC.encode('v2'))
    await unlink(accessor, A_TXT)
    expect(store.ids('/trash/a.txt')).toHaveLength(1)
    await write(accessor, A_TXT, ENC.encode('v3'))
    expect(store.ids('a.txt')).toHaveLength(1)
    const [trashed] = store.ids('/trash/a.txt')
    expect(new TextDecoder().decode(store.chunks.get(String(trashed)))).toBe('v2')
  })

  it('breaks upload date ties by the newest id', async () => {
    // Two uploads in one clock tick: the later _id is the newer revision,
    // for reads and for what retention keeps.
    store.upload('a.txt', ENC.encode('older'))
    const newer = store.upload('a.txt', ENC.encode('newer'), true)
    const accessor = makeAccessor(store, { keepRevisions: 1 })
    expect(new TextDecoder().decode(await read(accessor, A_TXT))).toBe('newer')
    await unlink(accessor, A_TXT)
    expect(store.ids('/trash/a.txt')).toEqual([newer])
  })

  it('keeps every revision without retention', async () => {
    const accessor = makeAccessor(store)
    for (const data of ['v1', 'v2', 'v3']) await write(accessor, A_TXT, ENC.encode(data))
    await unlink(accessor, A_TXT)
    await write(accessor, A_TXT, ENC.encode('v4'))
    expect(store.ids('/trash/a.txt')).toHaveLength(3)
    expect(store.chunks.size).toBe(4)
  })
})

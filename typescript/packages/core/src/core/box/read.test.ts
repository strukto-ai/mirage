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

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HashModule from '../../utils/hash.ts'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, downloadFile: vi.fn(), downloadFileStream: vi.fn() }
})

vi.mock('../../utils/hash.ts', async () => {
  const actual = await vi.importActual<typeof HashModule>('../../utils/hash.ts')
  return { ...actual, sha1Hex: vi.fn(actual.sha1Hex) }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { Sha1, sha1Hex } from '../../utils/hash.ts'
import * as api from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { read, readStream } from './read.ts'

const STUB_TM = {} as BoxTokenManager
const PATH = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const DATA = Uint8Array.from({ length: 134 }, (_, i) => i)
const OTHER = new TextEncoder().encode('another version of the file')

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

async function listed(sha: string | null): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await index.setDir('/', [
    [
      'a.txt',
      new IndexEntry({
        id: '200',
        name: 'a.txt',
        resourceType: 'box/file',
        vfsName: 'a.txt',
        extra: sha === null ? {} : { sha1: sha },
      }),
    ],
  ])
  return index
}

type Row = [string, number, string | null]

async function recordedRead(
  index: RAMIndexCacheStore,
  data: Uint8Array,
  window?: { offset?: number; size?: number },
): Promise<[Uint8Array, Row[]]> {
  vi.mocked(api.downloadFile).mockResolvedValue(data)
  const [got, records] = await runWithRecording(() => read(makeAccessor(), PATH, index, window))
  return [got, records.map((r) => [r.op, r.bytes, r.fingerprint])]
}

function chunked(...chunks: Uint8Array[]): void {
  vi.mocked(api.downloadFileStream).mockImplementation(async function* () {
    for (const c of chunks) {
      await Promise.resolve()
      yield c
    }
  })
}

async function recordedStream(
  index: RAMIndexCacheStore,
  chunks: Uint8Array[],
  closeAfter: number | null = null,
): Promise<[Uint8Array[], Row[]]> {
  chunked(...chunks)
  const [got, records] = await runWithRecording(async () => {
    const out: Uint8Array[] = []
    for await (const c of readStream(makeAccessor(), PATH, index)) {
      out.push(c)
      if (closeAfter !== null && out.length === closeAfter) break
    }
    return out
  })
  return [got, records.map((r) => [r.op, r.bytes, r.fingerprint])]
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('box read stamps', () => {
  it.each(['native', 'no-subtle'])(
    'a whole read stamps the listed sha1 (%s)',
    async (cryptoMode) => {
      const digest = cryptoMode === 'native' ? vi.spyOn(globalThis.crypto.subtle, 'digest') : null
      if (cryptoMode === 'no-subtle') vi.stubGlobal('crypto', {})
      vi.mocked(api.downloadFile).mockClear()
      const [got, rows] = await recordedRead(await listed(sha1(DATA)), DATA)
      expect(got).toEqual(DATA)
      expect(rows).toEqual([['read', DATA.byteLength, sha1(DATA)]])
      expect(api.downloadFile).toHaveBeenCalledTimes(1)
      if (digest !== null) expect(digest).toHaveBeenCalledWith('SHA-1', DATA)
    },
  )

  // A writer between the listing and the download: the bytes are newer than
  // the listed sha1, which must not label them.
  it('a read of other bytes than listed stamps nothing', async () => {
    const [got, rows] = await recordedRead(await listed(sha1(OTHER)), DATA)
    expect(got).toEqual(DATA)
    expect(rows).toEqual([['read', DATA.byteLength, null]])
  })

  // A token describes the whole object; a windowed call carries none even
  // when its bytes happen to be all of them (gdrive's rule).
  it.each([
    ['tail', { offset: 1 }, DATA.subarray(1)],
    ['head', { offset: 0, size: 4 }, DATA.subarray(0, 4)],
    ['size-capped-whole', { offset: 0, size: DATA.byteLength }, DATA],
    ['range-ignored', { offset: 1 }, DATA],
  ] as const)('a windowed read stamps and hashes nothing (%s)', async (_id, window, data) => {
    vi.mocked(sha1Hex).mockClear()
    const [got, rows] = await recordedRead(await listed(sha1(DATA)), data, window)
    expect(got).toEqual(data)
    expect(rows).toEqual([['read', data.byteLength, null]])
    expect(vi.mocked(sha1Hex)).not.toHaveBeenCalled()
  })

  it('reads through a sha1-less entry stamp and hash nothing', async () => {
    const update = vi.spyOn(Sha1.prototype, 'update')
    vi.mocked(sha1Hex).mockClear()
    const index = await listed(null)
    const [got, rows] = await recordedRead(index, DATA)
    expect(got).toEqual(DATA)
    expect(rows).toEqual([['read', DATA.byteLength, null]])
    const [chunks, streamed] = await recordedStream(index, [
      DATA.subarray(0, 64),
      DATA.subarray(64),
    ])
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(DATA))
    expect(streamed).toEqual([['read', DATA.byteLength, null]])
    expect(vi.mocked(sha1Hex)).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('box stream stamps', () => {
  it('a drained stream stamps the listed sha1, hashing each chunk as it passes', async () => {
    const update = vi.spyOn(Sha1.prototype, 'update')
    const chunks = [DATA.subarray(0, 1), DATA.subarray(1, 64), DATA.subarray(64)]
    const [got, rows] = await recordedStream(await listed(sha1(DATA)), chunks)
    expect(Buffer.concat(got)).toEqual(Buffer.from(DATA))
    expect(rows).toEqual([['read', DATA.byteLength, sha1(DATA)]])
    // One update per chunk, with that chunk: the stream never buffers itself
    // whole to hash at the end.
    expect(update.mock.calls.map(([chunk]) => chunk)).toEqual(chunks)
  })

  it('a drained stream of other bytes stamps nothing', async () => {
    const [, rows] = await recordedStream(await listed(sha1(OTHER)), [
      DATA.subarray(0, 64),
      DATA.subarray(64),
    ])
    expect(rows).toEqual([['read', DATA.byteLength, null]])
  })

  // One chunk, closed before the iterator ends: a stamp set up front would
  // label this read as the whole object.
  it('an abandoned stream stamps nothing', async () => {
    const [got, rows] = await recordedStream(await listed(sha1(DATA)), [DATA], 1)
    expect(got).toEqual([DATA])
    expect(rows.map(([, , fp]) => fp)).toEqual([null])
  })

  it('reads with no recorder bound still return bytes', async () => {
    const index = await listed(sha1(DATA))
    vi.mocked(api.downloadFile).mockResolvedValue(DATA)
    expect(await read(makeAccessor(), PATH, index)).toEqual(DATA)
    // Only whole reads publish a token without an observer.
    const update = vi.spyOn(Sha1.prototype, 'update')
    chunked(DATA)
    const out: Uint8Array[] = []
    for await (const c of readStream(makeAccessor(), PATH, index)) out.push(c)
    expect(out).toEqual([DATA])
    expect(update).not.toHaveBeenCalled()
  })
})

describe('box read stamp boundaries', () => {
  // A 0-byte file still has a sha1 (that of no bytes); a truthiness check
  // would leave every fresh read of it unverifiable.
  it('an empty file is stamped like any other', async () => {
    const empty = new Uint8Array(0)
    const index = await listed(sha1(empty))
    const [got, rows] = await recordedRead(index, empty)
    expect(got).toEqual(empty)
    expect(rows).toEqual([['read', 0, sha1(empty)]])
    const [, streamed] = await recordedStream(index, [empty])
    expect(streamed).toEqual([['read', 0, sha1(empty)]])
  })

  // A 0-byte download may yield no chunk at all; the stamp must not depend on
  // the hash having seen one.
  it('a stream with no chunks is stamped as the empty file', async () => {
    const empty = new Uint8Array(0)
    const [got, rows] = await recordedStream(await listed(sha1(empty)), [])
    expect(got).toEqual([])
    expect(rows).toEqual([['read', 0, sha1(empty)]])
  })
})

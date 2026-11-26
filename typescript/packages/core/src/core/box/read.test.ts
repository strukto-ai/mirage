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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HashModule from '../../utils/hash.ts'

vi.mock('../../utils/hash.ts', async () => {
  const actual = await vi.importActual<typeof HashModule>('../../utils/hash.ts')
  return { ...actual, sha1Hex: vi.fn(actual.sha1Hex) }
})

import { recordingScope } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import type { FileStat, JsonValue } from '../../types.ts'
import { Digest, sha1Hex } from '../../utils/hash.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { read, readStream } from './read.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()
const HELLO = ENC.encode('hello')
const PATH = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/a.txt' })
const DATA = Uint8Array.from({ length: 134 }, (_, i) => i)
const OTHER = ENC.encode('another version of the file')
const ITEMS_ROUTE = '/2.0/folders/:folder_id/items'

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

beforeEach(() => {
  account = new BoxAccount(origin)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await account.run.close()
})

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ vfsPath: virtual.replace(/^\/+/, ''), virtual, directory: virtual })
}

// What the mount's listing hands a read of `virtual`.
async function entry(virtual = '/a.txt'): Promise<FileStat | null> {
  return entryAt(readdir, account.accessor(), spec(virtual))
}

// The entry a listing of /a.txt gave while it held `listed`, after another
// client has since made it `now`.
async function listedThenChanged(listed: Uint8Array, now: Uint8Array): Promise<FileStat | null> {
  const id = await account.put('a.txt', listed)
  const row = await entry()
  if (now !== listed) await account.uploadVersion(id, now)
  return row
}

// /a.txt as listed by a Box that gives it no sha1.
async function listedWithoutSha1(): Promise<FileStat | null> {
  await account.put('a.txt', DATA)
  const listing = await account.run.call<{ entries: Record<string, JsonValue>[] }>(
    'GET',
    '/2.0/folders/0/items',
  )
  for (const row of listing.entries) delete row.sha1
  await account.run.answerNext('GET', ITEMS_ROUTE, 200, listing)
  return entry()
}

type Row = [string, number, string | null]

async function recordedRead(
  row: FileStat | null,
  window?: { offset?: number; size?: number },
): Promise<[Uint8Array, Row[]]> {
  const [got, records] = await recordingScope(() => read(account.accessor(), PATH, window, row))
  return [got, records.map((r) => [r.op, r.bytes, r.fingerprint])]
}

async function recordedStream(
  row: FileStat | null,
  closeAfter: number | null = null,
): Promise<[Uint8Array[], Row[]]> {
  const [got, records] = await recordingScope(async () => {
    const out: Uint8Array[] = []
    for await (const c of readStream(account.accessor(), PATH, row)) {
      out.push(c)
      if (closeAfter !== null && out.length === closeAfter) break
    }
    return out
  })
  expect(
    records.every((r) => r.complete === (closeAfter === null || got.length < closeAfter)),
  ).toBe(true)
  return [got, records.map((r) => [r.op, r.bytes, r.fingerprint])]
}

describe('box read', () => {
  it('downloads a plain file by id', async () => {
    const id = await account.put('a.txt', HELLO)
    const row = await entry()
    await account.run.recordRequests('range')
    expect(await read(account.accessor(), PATH, undefined, row)).toEqual(HELLO)
    expect(await account.run.requests()).toEqual([`GET /2.0/files/${id}/content`, `GET /dl/${id}`])
  })

  it('asks Box for the range of a ranged read', async () => {
    const id = await account.put('a.txt', HELLO)
    const row = await entry()
    await account.run.recordRequests('range')
    const got = await read(account.accessor(), PATH, { offset: 1, size: 3 }, row)
    expect(new TextDecoder().decode(got)).toBe('ell')
    expect(await account.run.requests()).toEqual([
      `GET /2.0/files/${id}/content range=bytes=1-3`,
      `GET /dl/${id} range=bytes=1-3`,
    ])
  })

  it('leaves the range open for a read to the end', async () => {
    const id = await account.put('a.txt', HELLO)
    const row = await entry()
    await account.run.recordRequests('range')
    const got = await read(account.accessor(), PATH, { offset: 2 }, row)
    expect(new TextDecoder().decode(got)).toBe('llo')
    expect(await account.run.requests()).toEqual([
      `GET /2.0/files/${id}/content range=bytes=2-`,
      `GET /dl/${id} range=bytes=2-`,
    ])
  })

  it('returns a Box-native file as its raw bytes', async () => {
    const raw = ENC.encode(JSON.stringify({ doc: { content: [] } }))
    await account.put('n.boxnote', raw)
    const got = await read(
      account.accessor(),
      spec('/n.boxnote'),
      undefined,
      await entry('/n.boxnote'),
    )
    expect(got).toEqual(raw)
  })

  it('a folder is EISDIR', async () => {
    await account.mkdir('docs')
    await expect(
      read(account.accessor(), spec('/docs'), undefined, await entry('/docs')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('a path the mount found nothing at is ENOENT', async () => {
    await expect(
      read(account.accessor(), spec('/ghost.txt'), undefined, null),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('streams a plain file', async () => {
    await account.put('a.txt', HELLO)
    const row = await entry()
    const out: Uint8Array[] = []
    for await (const c of readStream(account.accessor(), PATH, row)) out.push(c)
    expect(Buffer.concat(out)).toEqual(Buffer.from(HELLO))
  })
})

describe('box read stamps', () => {
  it.each(['native', 'no-subtle'])(
    'a whole read stamps the listed sha1 (%s)',
    async (cryptoMode) => {
      const row = await listedThenChanged(DATA, DATA)
      const digest = cryptoMode === 'native' ? vi.spyOn(globalThis.crypto.subtle, 'digest') : null
      if (cryptoMode === 'no-subtle') vi.stubGlobal('crypto', {})
      const [got, rows] = await recordedRead(row)
      expect(got).toEqual(DATA)
      expect(rows).toEqual([['read', DATA.byteLength, sha1(DATA)]])
      if (digest !== null) expect(digest).toHaveBeenCalledWith('SHA-1', DATA)
    },
  )

  // A writer between the listing and the download: the bytes are newer than
  // the listed sha1, which must not label them.
  it('a read of other bytes than listed stamps nothing', async () => {
    const [got, rows] = await recordedRead(await listedThenChanged(OTHER, DATA))
    expect(got).toEqual(DATA)
    expect(rows).toEqual([['read', DATA.byteLength, null]])
  })

  // A token describes the whole object; a windowed call carries none even
  // when its bytes happen to be all of them (gdrive's rule).
  it.each([
    ['tail', { offset: 1 }, DATA.subarray(1)],
    ['head', { offset: 0, size: 4 }, DATA.subarray(0, 4)],
    ['size-capped-whole', { offset: 0, size: DATA.byteLength }, DATA],
  ] as const)('a windowed read stamps and hashes nothing (%s)', async (_id, window, data) => {
    const row = await listedThenChanged(DATA, DATA)
    vi.mocked(sha1Hex).mockClear()
    const [got, rows] = await recordedRead(row, window)
    expect(got).toEqual(data)
    expect(rows).toEqual([['read', data.byteLength, null]])
    expect(vi.mocked(sha1Hex)).not.toHaveBeenCalled()
  })

  it('reads through a sha1-less entry stamp and hash nothing', async () => {
    const row = await listedWithoutSha1()
    const update = vi.spyOn(Digest.prototype, 'update')
    vi.mocked(sha1Hex).mockClear()
    const [got, rows] = await recordedRead(row)
    expect(got).toEqual(DATA)
    expect(rows).toEqual([['read', DATA.byteLength, null]])
    const [chunks, streamed] = await recordedStream(row)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(DATA))
    expect(streamed).toEqual([['read', DATA.byteLength, null]])
    expect(vi.mocked(sha1Hex)).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('box stream stamps', () => {
  it('a drained stream stamps the listed sha1, hashing each chunk as it passes', async () => {
    // Large enough to arrive in several chunks.
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251)
    const row = await listedThenChanged(big, big)
    const update = vi.spyOn(Digest.prototype, 'update')
    const [got, rows] = await recordedStream(row)
    expect(Buffer.concat(got)).toEqual(Buffer.from(big))
    expect(rows).toEqual([['read', big.byteLength, sha1(big)]])
    // One update per chunk, with that chunk: the stream never buffers itself
    // whole to hash at the end.
    expect(got.length).toBeGreaterThan(1)
    expect(update.mock.calls.map(([chunk]) => chunk)).toEqual(got)
  })

  it('a drained stream of other bytes stamps nothing', async () => {
    const [got, rows] = await recordedStream(await listedThenChanged(OTHER, DATA))
    expect(Buffer.concat(got)).toEqual(Buffer.from(DATA))
    expect(rows).toEqual([['read', DATA.byteLength, null]])
  })

  // One chunk, closed before the iterator ends: a stamp set up front would
  // label this read as the whole object.
  it('an abandoned stream stamps nothing', async () => {
    const [got, rows] = await recordedStream(await listedThenChanged(DATA, DATA), 1)
    expect(got).toHaveLength(1)
    expect(Buffer.from(DATA).subarray(0, got[0]?.byteLength)).toEqual(Buffer.from(got[0] ?? []))
    expect(rows.map(([, , fp]) => fp)).toEqual([null])
  })

  it('reads with no recorder bound still return bytes', async () => {
    const row = await listedThenChanged(DATA, DATA)
    expect(await read(account.accessor(), PATH, undefined, row)).toEqual(DATA)
    // Only whole reads publish a token without an observer.
    const update = vi.spyOn(Digest.prototype, 'update')
    const out: Uint8Array[] = []
    for await (const c of readStream(account.accessor(), PATH, row)) out.push(c)
    expect(Buffer.concat(out)).toEqual(Buffer.from(DATA))
    expect(update).not.toHaveBeenCalled()
  })
})

describe('box read stamp boundaries', () => {
  // A 0-byte file still has a sha1 (that of no bytes); a truthiness check
  // would leave every fresh read of it unverifiable.
  it('an empty file is stamped like any other', async () => {
    const empty = new Uint8Array(0)
    const row = await listedThenChanged(empty, empty)
    const [got, rows] = await recordedRead(row)
    expect(got).toEqual(empty)
    expect(rows).toEqual([['read', 0, sha1(empty)]])
    const [, streamed] = await recordedStream(row)
    expect(streamed).toEqual([['read', 0, sha1(empty)]])
  })

  // A 0-byte download yields no chunk at all; the stamp must not depend on
  // the hash having seen one.
  it('a stream with no chunks is stamped as the empty file', async () => {
    const empty = new Uint8Array(0)
    const [got, rows] = await recordedStream(await listedThenChanged(empty, empty))
    expect(got).toEqual([])
    expect(rows).toEqual([['read', 0, sha1(empty)]])
  })
})

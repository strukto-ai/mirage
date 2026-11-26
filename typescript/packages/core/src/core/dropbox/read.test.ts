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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mountKey } from '../../utils/key_prefix.ts'
import { captureRead, runWithWriteContext } from '../../cache/context.ts'
import type { WriteContext } from '../../cache/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { recordingScope } from '../../observe/context.ts'
import { DropboxVFS } from '../../vfs/dropbox/dropbox.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { read, readStream } from './read.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()
const DOWNLOAD_ROUTE = '/2/files/download'
const LIST_ROUTE = '/2/files/list_folder'
const DATA = ENC.encode('0123456789')
// The row a listing names for a file: Dropbox downloads by path, so it only
// says a file is there.
const NOTE = new FileStat({ name: 'note.txt', type: FileType.FILE })
const NOTE_PATH = new PathSpec({ virtual: '/note.txt', directory: '/', vfsPath: 'note.txt' })
const A = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })
const UNDER_PREFIX = new PathSpec({
  virtual: '/dropbox/note.txt',
  directory: '/dropbox',
  vfsPath: mountKey('/dropbox/note.txt', '/dropbox'),
})

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

// What the mount hands a read at `path`, found by listing as it would.
async function listed(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat | null> {
  return (await handedAt((a, p) => readdir(a, p), accessor, path)).entry ?? null
}

// Each download since recording: the path it named and its Range.
async function downloads(): Promise<[string, string | null][]> {
  const sent = await account.run.headers('POST', DOWNLOAD_ROUTE)
  return sent.map((h) => [
    (JSON.parse(h['dropbox-api-arg'] ?? '{}') as { path: string }).path,
    h.range ?? null,
  ])
}

// /a.txt holding DATA under a listing that lags the bytes: Dropbox's own
// listing with a stale content_hash, for every listing the read makes.
// Answers the hash of DATA.
async function lagging(): Promise<string> {
  const stored = await account.put('/a.txt', DATA)
  const listing = await account.run.call<{ entries: Record<string, JsonValue>[] }>(
    'POST',
    LIST_ROUTE,
    { json: { path: '' } },
  )
  for (const entry of listing.entries) entry.content_hash = 'stale'
  await account.run.answerNext('POST', LIST_ROUTE, 200, listing, 10)
  return stored.content_hash
}

describe('dropbox read', () => {
  it('downloads a file by stripping prefix and using path-based API', async () => {
    await account.put('/note.txt', ENC.encode('hi!'))
    const accessor = account.accessor()
    const entry = await listed(accessor, UNDER_PREFIX)
    await account.run.recordRequests('dropbox-api-arg', 'range')
    expect(await read(accessor, UNDER_PREFIX, undefined, entry)).toEqual(ENC.encode('hi!'))
    expect(await downloads()).toEqual([['/note.txt', null]])
  })

  it('asks Dropbox for the range of a ranged read', async () => {
    await account.put('/note.txt', ENC.encode('hi!'))
    const accessor = account.accessor()
    const entry = await listed(accessor, NOTE_PATH)
    await account.run.recordRequests('dropbox-api-arg', 'range')
    const got = await read(accessor, NOTE_PATH, { offset: 1, size: 2 }, entry)
    expect(got).toEqual(ENC.encode('i!'))
    expect(await downloads()).toEqual([['/note.txt', 'bytes=1-2']])
  })

  it('carries the range for a handed row', async () => {
    await account.put('/note.txt', ENC.encode('hi!'))
    await account.run.recordRequests('dropbox-api-arg', 'range')
    await read(account.accessor(), NOTE_PATH, { offset: 1, size: 2 }, NOTE)
    expect(await downloads()).toEqual([['/note.txt', 'bytes=1-2']])
  })

  it('downloads through the subfolder mount root', async () => {
    await account.put('/Team/data/note.txt', ENC.encode('hi'))
    const accessor = account.accessor('Team/data')
    const entry = await listed(accessor, UNDER_PREFIX)
    await account.run.recordRequests('dropbox-api-arg', 'range')
    expect(await read(accessor, UNDER_PREFIX, undefined, entry)).toEqual(ENC.encode('hi'))
    expect(await downloads()).toEqual([['/Team/data/note.txt', null]])
  })

  it('throws EISDIR when path resolves to a folder', async () => {
    await account.mkdir('/docs')
    const accessor = account.accessor()
    const path = new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' })
    const entry = await listed(accessor, path)
    await expect(
      read(accessor, path, undefined, entry),
      // The stamped code is the signal, not the message: the message is the
      // bare operand, which is what the shell renders and what Python's
      // IsADirectoryError(virtual) carries.
    ).rejects.toMatchObject({ code: 'EISDIR', virtualPath: '/docs' })
  })

  it('throws ENOENT for a missing file', async () => {
    const accessor = account.accessor()
    const path = new PathSpec({ vfsPath: 'missing.txt', virtual: '/missing.txt', directory: '/' })
    await expect(
      read(accessor, path, undefined, await listed(accessor, path)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('dropbox read stamps content_hash', () => {
  // The listing that resolved the entry lags the bytes: the token must come
  // from the download's own Dropbox-API-Result, never the row. A ranged read
  // is answered 206 and still carries Dropbox-API-Result.
  it.each([
    ['full', undefined, DATA],
    ['ranged', { offset: 2, size: 3 }, ENC.encode('234')],
  ] as const)('%s records the download token', async (_id, window, expected) => {
    const whole = await lagging()
    const accessor = account.accessor()
    const entry = await listed(accessor, A)
    const [data, records] = await recordingScope(() => read(accessor, A, window, entry))
    expect(data).toEqual(expected)
    expect(records.map((r) => [r.op, r.bytes, r.fingerprint])).toEqual([
      ['read', expected.byteLength, whole],
    ])
  })

  // Outside a shell line (FUSE, a programmatic read) there is no recorder,
  // and the stream must still stream.
  it.each([true, false])('a stream records the token its response names (%s)', async (line) => {
    const whole = await lagging()
    const accessor = account.accessor()
    const entry = await listed(accessor, A)
    const drain = async (): Promise<Uint8Array> => {
      const out: Uint8Array[] = []
      for await (const c of readStream(accessor, A, entry)) out.push(c)
      return new Uint8Array(Buffer.concat(out))
    }
    if (!line) {
      expect(await drain()).toEqual(DATA)
      return
    }
    const [bytes, records] = await recordingScope(drain)
    expect(bytes).toEqual(DATA)
    expect(records.map((r) => [r.op, r.bytes, r.fingerprint])).toEqual([
      ['read', DATA.byteLength, whole],
    ])
  })

  // A miss says the listed file is no longer there, which the mount reads as
  // a stale row and lists again; anything else is a failure.
  it.each([
    [409, 'path/not_found/..', { code: 'ENOENT' }],
    [409, 'path/not_file/..', { code: 'EISDIR' }],
    [409, 'path/restricted_content/..', { status: 409 }],
    [500, 'path/not_found/..', { status: 500 }],
  ] as const)('maps only a listed read %s %s to ENOENT', async (status, summary, raised) => {
    await account.run.answerNext('POST', DOWNLOAD_ROUTE, status, { error_summary: summary })
    await expect(read(account.accessor(), A, undefined, NOTE)).rejects.toMatchObject(raised)
  })

  // A truncate without a listing reads the exact existing file before rewriting.
  it('rewrites an exactly spelled file for a truncate with no row', async () => {
    await account.put('/N', ENC.encode('abcdef'))
    const vfs = new DropboxVFS({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'unit',
      endpoint: account.run.url,
    })
    await vfs.truncate(new PathSpec({ virtual: '/N', directory: '/', vfsPath: 'N' }), 4)
    expect(await account.read('/N')).toEqual(ENC.encode('abcd'))
  })
})

describe('dropbox read publishes its token on a conditional mount', () => {
  const context: WriteContext = {
    vfs: 'dropbox',
    conditions: ['put', 'copy', 'delete'],
    readVersion: () => Promise.resolve(null),
    readVersions: (paths) => Promise.resolve(paths.map(() => null)),
    drop: () => Promise.resolve(),
    keep: () => Promise.resolve(),
  }

  it.each([
    ['whole', true, undefined, true],
    ['ranged', true, { offset: 2, size: 3 }, false],
    ['unconditional', false, undefined, false],
  ] as const)('%s', async (_name, conditional, options, whole) => {
    const stored = await account.put('/a.txt', DATA)
    const [, tokens] = await runWithWriteContext('/', conditional ? context : null, () =>
      captureRead(A.virtual, () => read(account.accessor(), A, options, NOTE)),
    )
    expect(tokens).toEqual(whole ? [stored.content_hash] : [])
  })
})

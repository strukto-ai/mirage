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
import { FileType, PathSpec } from '../../types.ts'
import type { JsonValue, FileStat } from '../../types.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
const DOCS = new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' })
const A_TXT = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
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
  await account.run.close()
})

async function rows(path: PathSpec, row?: FileStat | null, root?: string): Promise<FileStat[]> {
  return (await readdir(account.accessor(root), path, row)) as FileStat[]
}

describe('box readdir', () => {
  it('lists root via folder id 0', async () => {
    const docs = await account.mkdir('docs')
    const id = await account.put('notes.txt', ENC.encode('hello world!'))
    await account.run.recordRequests()
    const listed = await rows(ROOT)
    expect(await account.run.requests()).toEqual(['GET /2.0/folders/0/items'])
    expect(listed.map((row) => [row.name, row.type, row.size, row.extra.box_id])).toEqual([
      ['docs', FileType.DIRECTORY, null, docs],
      ['notes.txt', FileType.FILE, 12, id],
    ])
  })

  it('surfaces a Box-native file raw', async () => {
    await account.put('meeting.boxnote', ENC.encode('{"doc": {}}'))
    const listed = await rows(ROOT)
    expect(listed.map((row) => [row.name, row.extra.resource_type])).toEqual([
      ['meeting.boxnote', 'box/file'],
    ])
  })

  it('lists a subfolder by the id its row names', async () => {
    const docs = await account.mkdir('docs')
    await account.put('note.md', ENC.encode('hello'), docs)
    const row = await entryAt(readdir, account.accessor(), DOCS)
    await account.run.recordRequests()
    expect((await rows(DOCS, row)).map((r) => r.name)).toEqual(['note.md'])
    expect(await account.run.requests()).toEqual([`GET /2.0/folders/${docs}/items`])
  })

  it('a folder no listing named is ENOENT, a file ENOTDIR, with no request', async () => {
    await account.put('a.txt', ENC.encode('hello'))
    const file = await entryAt(readdir, account.accessor(), A_TXT)
    await account.run.recordRequests()
    await expect(rows(DOCS)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(rows(A_TXT, file)).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await account.run.requests()).toEqual([])
  })

  it('keeps 0-byte files with size 0 and hides weblinks', async () => {
    await account.webLink('homepage')
    await account.put('empty.txt', new Uint8Array(0))
    expect((await rows(ROOT)).map((row) => [row.name, row.size])).toEqual([['empty.txt', 0]])
  })

  it('reads a 404 from the folder listing as absence, not as a failure', async () => {
    // BoxApiError carries only an HTTP status, so a folder deleted after its
    // row was listed must be stamped ENOENT here; du's walk counts a stamped
    // ENOENT as zero and propagates everything else. A mount whose root
    // folder Box no longer has.
    await expect(rows(ROOT, undefined, '9')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a throttled folder listing stay a failure', async () => {
    await account.run.answerNext('GET', ITEMS_ROUTE, 429)
    await expect(rows(ROOT)).rejects.toMatchObject({ status: 429 })
  })

  // Box's own listing with the sha1 it gave replaced.
  it.each([
    [5, undefined],
    ['', undefined],
    ['abc', 'abc'],
  ] as const)('keeps only a string sha1 (%s)', async (sha1, kept) => {
    await account.put('a.txt', ENC.encode('hello'))
    const listing = await account.run.call<{ entries: Record<string, JsonValue>[] }>(
      'GET',
      '/2.0/folders/0/items',
    )
    for (const row of listing.entries) row.sha1 = sha1
    await account.run.answerNext('GET', ITEMS_ROUTE, 200, listing)
    const [row] = await rows(ROOT)
    expect(row?.extra.sha1).toBe(kept)
    expect(row?.fingerprint).toBe(kept ?? null)
  })

  it('rows carry the etag a write sends', async () => {
    const id = await account.put('a.txt', ENC.encode('hello'))
    await account.uploadVersion(id, ENC.encode('again'))
    const [row] = await rows(ROOT)
    const listed = (await account.child('0', 'a.txt')) as unknown as { etag: string }
    expect(row?.extra.etag).toBe(listed.etag)
    expect(row?.extra.etag).not.toBe('0')
  })
})

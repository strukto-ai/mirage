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
import { ContentType, type FileStat, FileType, PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const ENC = new TextEncoder()
const METADATA_ROUTE = '/2/files/get_metadata'
const LIST_ROUTE = '/2/files/list_folder'
const A = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })

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

// The path each get_metadata since recording asked for.
async function asked(): Promise<string[]> {
  const sent = await account.run.bodies('POST', METADATA_ROUTE)
  return sent.map((body) => (body as { path: string }).path)
}

describe('dropbox stat', () => {
  it('is a directory at the mount root with no I/O', async () => {
    await account.run.recordRequests()
    const out = await stat(
      account.accessor(),
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(await account.run.requests()).toEqual([])
  })

  it('resolves a file through get_metadata', async () => {
    // Dropbox addresses by path: stat is one get_metadata.
    const stored = await account.put('/a.txt', ENC.encode('hello'))
    const out = await stat(account.accessor(), PathSpec.fromStrPath('/a.txt'))
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(out.modified).toBe(stored.server_modified)
    expect(out.fingerprint).toBe(stored.content_hash)
    expect(out.extra.dropbox_id).toBe(stored.id)
    expect(out.extra.resource_type).toBe('dropbox/file')
  })

  it('resolves a folder through get_metadata', async () => {
    const made = await account.mkdir('/docs')
    const out = await stat(account.accessor(), PathSpec.fromStrPath('/docs'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('docs')
    expect(out.size).toBeNull()
    expect(out.extra.dropbox_id).toBe(made.id)
  })

  it('maps a 409 to ENOENT', async () => {
    await expect(
      stat(account.accessor(), PathSpec.fromStrPath('/ghost.txt')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/ghost.txt',
    })
  })

  it('propagates a non-409 error', async () => {
    // A rate-limit or server error is not absence: it must surface.
    await account.run.answerNext('POST', METADATA_ROUTE, 500)
    await expect(stat(account.accessor(), PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      status: 500,
    })
  })

  // statFromEntry fallbacks: server_modified→client_modified→'',
  // id→path_display→name, no content_hash is no token, and a non-number/absent
  // size renders as null (the unknown-size machinery, never a fabricated
  // number). Answers the fake never gives.
  const fallbackCases: [JsonValue, string, number | null, string][] = [
    [
      {
        '.tag': 'file',
        id: 'id:x',
        name: 'f.txt',
        client_modified: '2026-01-02T00:00:00Z',
        size: 3,
      },
      'id:x',
      3,
      '2026-01-02T00:00:00Z',
    ],
    [{ '.tag': 'file', id: 'id:x', name: 'f.txt', size: 3 }, 'id:x', 3, ''],
    [{ '.tag': 'file', name: 'f.txt', path_display: '/d/f.txt', size: 3 }, '/d/f.txt', 3, ''],
    [{ '.tag': 'file', name: 'f.txt', size: 3 }, 'f.txt', 3, ''],
    [{ '.tag': 'file', id: 'id:x', name: 'f.txt' }, 'id:x', null, ''],
    // size is typed number, but the wire is untyped JSON; a non-number
    // from the API must render as null, not a fabricated size.
    [{ '.tag': 'file', id: 'id:x', name: 'f.txt', size: 'big' }, 'id:x', null, ''],
  ]
  it.each(fallbackCases)(
    'renders entry field fallbacks (%#)',
    async (entry, dropboxId, size, modified) => {
      await account.run.answerNext('POST', METADATA_ROUTE, 200, entry, 5)
      const out = await stat(account.accessor(), PathSpec.fromStrPath('/f.txt'))
      expect(out.extra.dropbox_id).toBe(dropboxId)
      expect(out.size).toBe(size)
      expect(out.modified).toBe(modified)
      expect(out.fingerprint).toBeNull()
    },
  )

  // Every other test runs on an unprefixed mount; this pins the prefix
  // arithmetic of the path get_metadata is asked for.
  it('honors the mount prefix', async () => {
    await account.put('/a.txt', ENC.encode('hello'))
    await account.run.recordRequests()
    const out = await stat(
      account.accessor(),
      new PathSpec({
        virtual: '/dropbox/a.txt',
        directory: '/dropbox',
        vfsPath: mountKey('/dropbox/a.txt', '/dropbox'),
      }),
    )
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('a.txt')
    expect(out.size).toBe(5)
    expect(await asked()).toEqual(['/a.txt'])
  })

  it('serves a size for every listed file that matches its read length', async () => {
    // The fskit invariant behind sizes_always_known: the size stat serves
    // from the listing must equal the byte length a read delivers, 0-byte
    // files included.
    await account.put('/a.txt', ENC.encode('hello'))
    await account.put('/empty.txt', new Uint8Array(0))
    await account.put('/docs/b.bin', ENC.encode('abc'))
    const accessor = account.accessor()
    const files: string[] = []
    const stack = ['/']
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      const listing = (await readdir(accessor, PathSpec.fromStrPath(current))) as FileStat[]
      for (const child of listing) {
        const trimmed = `${current.replace(/\/$/, '')}/${child.name}`
        const spec = PathSpec.fromStrPath(trimmed)
        const info = await stat(accessor, spec)
        if (info.type === FileType.DIRECTORY) {
          stack.push(trimmed)
          continue
        }
        expect(info.size, trimmed).not.toBeNull()
        const handed = await handedAt((a, p) => readdir(a, p), accessor, spec)
        const bytes = await read(accessor, spec, undefined, handed.entry)
        expect(info.size, trimmed).toBe(bytes.length)
        files.push(trimmed)
      }
    }
    expect(files.sort()).toEqual(['/a.txt', '/docs/b.bin', '/empty.txt'])
  })

  // One get_metadata, never a listing of the parent: the mount keeps
  // listings and answers a listed path itself.
  it('asks one lookup', async () => {
    const stored = await account.put('/a.txt', ENC.encode('hello'))
    await account.run.recordRequests()
    const out = await stat(account.accessor(), A)
    expect(out.fingerprint).toBe(stored.content_hash)
    expect(await account.run.bodies('POST', LIST_ROUTE)).toEqual([])
    expect(await asked()).toEqual(['/a.txt'])
  })

  // A restricted file exists, so a fresh probe must not hear ENOENT and drop
  // its overlay; a 5xx body naming not_found is a relay's.
  const answers: [string, number, string, Record<string, unknown>][] = [
    ['not-found', 409, 'path/not_found/..', { code: 'ENOENT' }],
    ['not-folder', 409, 'path/not_folder/..', { code: 'ENOENT' }],
    ['restricted', 409, 'path/restricted_content/..', { status: 409 }],
    ['5xx', 502, 'path/not_found/..', { status: 502 }],
  ]
  it.each(answers)('reads only a miss as ENOENT (%s)', async (_id, status, summary, raised) => {
    await account.run.answerNext('POST', METADATA_ROUTE, status, { error_summary: summary })
    await expect(stat(account.accessor(), A)).rejects.toMatchObject(raised)
  })

  // get_metadata matches case-insensitively where a listing is exact:
  // Dropbox answers /A.TXT with a.txt.
  it('reports ENOENT when get_metadata answers another case', async () => {
    const stored = await account.put('/a.txt', ENC.encode('hello'))
    await account.run.answerNext('POST', METADATA_ROUTE, 200, stored, 5)
    await expect(stat(account.accessor(), PathSpec.fromStrPath('/A.TXT'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

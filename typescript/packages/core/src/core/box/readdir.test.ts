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

import { describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolderItems: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import * as api from './api.ts'
import { readdir } from './readdir.ts'

const STUB_TM = {} as BoxTokenManager
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
const DOCS = new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' })
const DOCS_ROW = new FileStat({ name: 'docs', type: FileType.DIRECTORY, extra: { box_id: '111' } })

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

describe('box readdir', () => {
  it('lists root via folder id 0', async () => {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId: string) => {
      if (folderId === '0') {
        return Promise.resolve([
          { type: 'folder' as const, id: '111', name: 'docs', modified_at: '2026-04-01T00:00:00Z' },
          {
            type: 'file' as const,
            id: '222',
            name: 'notes.txt',
            size: 12,
            modified_at: '2026-04-01T00:00:00Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${folderId}`)
    })
    const rows = (await readdir(makeAccessor(), ROOT)) as FileStat[]
    expect(rows.map((row) => [row.name, row.type, row.size, row.extra.box_id])).toEqual([
      ['docs', FileType.DIRECTORY, null, '111'],
      ['notes.txt', FileType.FILE, 12, '222'],
    ])
  })

  it('lists a subfolder by the id its row names', async () => {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId: string) => {
      if (folderId === '111') {
        return Promise.resolve([{ type: 'file' as const, id: '222', name: 'note.md', size: 5 }])
      }
      throw new Error(`unexpected folderId=${folderId}`)
    })
    const rows = (await readdir(makeAccessor(), DOCS, DOCS_ROW)) as FileStat[]
    expect(rows.map((row) => row.name)).toEqual(['note.md'])
  })

  it('a folder no listing named is ENOENT, a file ENOTDIR, with no request', async () => {
    vi.mocked(api.listFolderItems).mockReset()
    await expect(readdir(makeAccessor(), DOCS)).rejects.toMatchObject({ code: 'ENOENT' })
    const file = new FileStat({ name: 'docs', type: FileType.FILE, extra: { box_id: '9' } })
    await expect(readdir(makeAccessor(), DOCS, file)).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(api.listFolderItems).not.toHaveBeenCalled()
  })

  it('keeps 0-byte files with size 0 and hides weblinks', async () => {
    vi.mocked(api.listFolderItems).mockResolvedValue([
      {
        type: 'file' as const,
        id: '444',
        name: 'empty.txt',
        size: 0,
        modified_at: '2026-04-01T00:00:00Z',
      },
      {
        type: 'web_link' as const,
        id: '555',
        name: 'homepage',
        modified_at: '2026-04-01T00:00:00Z',
      },
    ])
    const rows = (await readdir(makeAccessor(), ROOT)) as FileStat[]
    expect(rows.map((row) => [row.name, row.size])).toEqual([['empty.txt', 0]])
  })

  it('reads a 404 from the folder listing as absence, not as a failure', async () => {
    // BoxApiError carries only an HTTP status, so a folder deleted after its
    // row was listed must be stamped ENOENT here; du's walk counts a stamped
    // ENOENT as zero and propagates everything else.
    vi.mocked(api.listFolderItems).mockRejectedValue(
      new BoxApiError('Box GET /folders/111/items -> 404 not_found', 404),
    )
    await expect(readdir(makeAccessor(), ROOT)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a throttled folder listing stay a failure', async () => {
    vi.mocked(api.listFolderItems).mockRejectedValue(
      new BoxApiError('Box GET /folders/111/items -> 429 rate_limit', 429),
    )
    await expect(readdir(makeAccessor(), ROOT)).rejects.toMatchObject({ status: 429 })
  })

  it.each([
    [5, undefined],
    ['', undefined],
    ['abc', 'abc'],
  ] as const)('keeps only a string sha1 (%s)', async (sha1, kept) => {
    vi.mocked(api.listFolderItems).mockResolvedValue([
      { type: 'file', id: '200', name: 'a.txt', size: 1, sha1 } as unknown as api.BoxItem,
    ])
    const [row] = (await readdir(makeAccessor(), ROOT)) as FileStat[]
    expect(row?.extra.sha1).toBe(kept)
    expect(row?.fingerprint).toBe(kept ?? null)
  })

  it('rows carry the etag a write sends', async () => {
    vi.mocked(api.listFolderItems).mockResolvedValue([
      { type: 'file' as const, id: '200', name: 'a.txt', size: 1, etag: '3' },
    ])
    const [row] = (await readdir(makeAccessor(), ROOT)) as FileStat[]
    expect(row?.extra.etag).toBe('3')
  })
})

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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return {
    ...actual,
    googleGet: vi.fn(),
    googleGetBytes: vi.fn(),
    googleGetStream: vi.fn(),
    googleDelete: vi.fn(),
  }
})

import type { TokenManager } from './_client.ts'
import * as client from './_client.ts'
import {
  deleteFile,
  downloadFile,
  downloadFileStream,
  listAllFiles,
  listFiles,
  listSharedDrives,
} from './drive.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listFiles shared drive params', () => {
  it('sets corpus params when driveId is given', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listFiles(STUB_TOKEN_MANAGER, { folderId: 'folder123', driveId: 'drive123' })
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBe('drive')
    expect(params.driveId).toBe('drive123')
    expect(params.includeItemsFromAllDrives).toBe('true')
    expect(params.supportsAllDrives).toBe('true')
  })

  it('omits corpus params when no driveId', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listFiles(STUB_TOKEN_MANAGER, { folderId: 'folder123' })
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBeUndefined()
    expect(params.driveId).toBeUndefined()
  })
})

describe('listAllFiles', () => {
  it('searches every corpus', async () => {
    // The g* mounts must see Shared Drive files, like gdrive does. Without
    // the all-drives triple Drive answers from the user corpus only, so the
    // same account sees a Shared Drive spreadsheet under gdrive and not
    // under gsheets, with no error to explain the difference.
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await listAllFiles(STUB_TOKEN_MANAGER)
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    expect(params.corpora).toBe('allDrives')
    expect(params.includeItemsFromAllDrives).toBe('true')
    expect(params.supportsAllDrives).toBe('true')
    // allDrives is the union of every corpus, so naming one contradicts it.
    expect(params.driveId).toBeUndefined()
    // incompleteSearch is a partial-response field: unasked for, unreturned.
    expect(String(params.fields).startsWith('incompleteSearch,')).toBe(true)
  })

  it('reports an incomplete search from any page', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({
        files: [{ id: 'f1', name: 'a.txt' }],
        incompleteSearch: true,
        nextPageToken: 'token2',
      })
      .mockResolvedValueOnce({ files: [{ id: 'f2', name: 'b.txt' }] })
    const { files, complete } = await listAllFiles(STUB_TOKEN_MANAGER)
    expect(files.map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(complete).toBe(false)
  })
})

describe('listSharedDrives', () => {
  it('paginates across pages', async () => {
    vi.mocked(client.googleGet)
      .mockResolvedValueOnce({ drives: [{ id: 'drive1', name: 'Team' }], nextPageToken: 'next' })
      .mockResolvedValueOnce({ drives: [{ id: 'drive2', name: 'Projects' }] })
    const result = await listSharedDrives(STUB_TOKEN_MANAGER)
    expect(result).toEqual([
      { id: 'drive1', name: 'Team' },
      { id: 'drive2', name: 'Projects' },
    ])
    expect(vi.mocked(client.googleGet).mock.calls).toHaveLength(2)
    const firstParams = vi.mocked(client.googleGet).mock.calls[0]?.[2] as Record<string, unknown>
    const secondParams = vi.mocked(client.googleGet).mock.calls[1]?.[2] as Record<string, unknown>
    expect(firstParams.pageToken).toBeUndefined()
    expect(secondParams.pageToken).toBe('next')
  })
})

describe('shared-drive support flags', () => {
  it('downloadFile requests supportsAllDrives', async () => {
    vi.mocked(client.googleGetBytes).mockResolvedValue(new Uint8Array())
    await downloadFile(STUB_TOKEN_MANAGER, 'file123')
    expect(vi.mocked(client.googleGetBytes).mock.calls[0]?.[1]).toContain('supportsAllDrives=true')
  })

  it('downloadFileStream requests supportsAllDrives', async () => {
    vi.mocked(client.googleGetStream).mockImplementation(async function* () {
      await Promise.resolve()
      yield new Uint8Array()
    })
    for await (const _chunk of downloadFileStream(STUB_TOKEN_MANAGER, 'file123')) void _chunk
    expect(vi.mocked(client.googleGetStream).mock.calls[0]?.[1]).toContain('supportsAllDrives=true')
  })

  it('deleteFile requests supportsAllDrives', async () => {
    vi.mocked(client.googleDelete).mockResolvedValue(undefined)
    await deleteFile(STUB_TOKEN_MANAGER, 'file123')
    expect(vi.mocked(client.googleDelete).mock.calls[0]?.[1]).toContain('supportsAllDrives=true')
  })
})

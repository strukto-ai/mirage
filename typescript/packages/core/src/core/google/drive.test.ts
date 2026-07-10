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
  listFiles,
  listSharedDrives,
} from './drive.ts'

const STUB_TOKEN_MANAGER = {} as TokenManager

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

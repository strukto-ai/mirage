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

// Mirror of the search_files cases in python/tests/core/dropbox/test_api.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, dropboxRpc: vi.fn() }
})

import * as client from './_client.ts'
import type { DropboxTokenManager } from './_client.ts'
import { MAX_SEARCH_MATCHES, SEARCH_PAGE, searchFiles } from './api.ts'

const TM = {} as DropboxTokenManager
const rpc = vi.mocked(client.dropboxRpc)

function searchMatch(tag: string, lower: string, display: string): Record<string, unknown> {
  return {
    match_type: { '.tag': 'filename' },
    metadata: {
      '.tag': 'metadata',
      metadata: { '.tag': tag, path_lower: lower, path_display: display },
    },
  }
}

beforeEach(() => {
  rpc.mockReset()
})

describe('searchFiles', () => {
  it('pages, dedups across pages, and skips folders', async () => {
    rpc
      .mockResolvedValueOnce({
        matches: [searchMatch('file', '/a.txt', '/A.txt'), searchMatch('folder', '/dir', '/Dir')],
        has_more: true,
        cursor: 'c1',
      })
      .mockResolvedValueOnce({
        matches: [searchMatch('file', '/a.txt', '/A.txt'), searchMatch('file', '/b.txt', '/B.txt')],
        has_more: false,
      })
    const out = await searchFiles(TM, 'needle', { path: '/docs' })
    expect(out.paths).toEqual([
      ['/a.txt', '/A.txt'],
      ['/b.txt', '/B.txt'],
    ])
    expect(out.truncated).toBe(false)
    expect(rpc.mock.calls[0]?.[1]).toBe('/files/search_v2')
    expect(rpc.mock.calls[0]?.[2]).toEqual({
      query: 'needle',
      options: {
        max_results: SEARCH_PAGE,
        file_status: 'active',
        filename_only: false,
        path: '/docs',
      },
    })
    expect(rpc.mock.calls[1]?.[1]).toBe('/files/search/continue_v2')
    expect(rpc.mock.calls[1]?.[2]).toEqual({ cursor: 'c1' })
  })

  it('omits the path option for the account root', async () => {
    rpc.mockResolvedValueOnce({ matches: [], has_more: false })
    const out = await searchFiles(TM, 'needle')
    expect(out).toEqual({ paths: [], truncated: false })
    const options = (rpc.mock.calls[0]?.[2] as { options: Record<string, unknown> }).options
    expect('path' in options).toBe(false)
  })

  it('flags the 10,000-match ceiling as truncated', async () => {
    const matches = Array.from({ length: MAX_SEARCH_MATCHES }, (_, i) =>
      searchMatch('file', `/f${String(i)}.txt`, `/f${String(i)}.txt`),
    )
    rpc.mockResolvedValueOnce({ matches, has_more: true, cursor: 'c1' })
    const out = await searchFiles(TM, 'needle')
    expect(out.paths).toHaveLength(MAX_SEARCH_MATCHES)
    expect(out.truncated).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})

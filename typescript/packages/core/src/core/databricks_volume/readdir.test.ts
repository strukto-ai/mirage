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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { readdir } from './readdir.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  spec,
  TEST_ROOT,
} from './_test_util.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readdir', () => {
  it('lists sorted virtual paths without trailing slashes', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/b.txt`, is_directory: false, file_size: 2 },
          { path: `${TEST_ROOT}/a`, is_directory: true },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const names = await readdir(makeAccessor(), spec('/volume/'))
    expect(names).toEqual(['/volume/a', '/volume/b.txt'])
  })

  it('follows next_page_token pagination', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.url.includes('page_token=next')) {
        return jsonResponse({ contents: [{ path: `${TEST_ROOT}/b.txt` }] })
      }
      return jsonResponse({
        contents: [{ path: `${TEST_ROOT}/a.txt` }],
        next_page_token: 'next',
      })
    })
    vi.stubGlobal('fetch', fetch)
    const names = await readdir(makeAccessor(), spec('/volume/'))
    expect(names).toEqual(['/volume/a.txt', '/volume/b.txt'])
    expect(calls).toHaveLength(2)
  })

  it('raises ENOENT for missing directories', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await readdir(makeAccessor(), spec('/volume/missing')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('stores size, type, and modified time in the index cache', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/a.txt`, file_size: 6, last_modified: 1_700_000_000_000 },
          { path: `${TEST_ROOT}/d`, is_directory: true },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const index = new RAMIndexCacheStore()
    await readdir(makeAccessor(), spec('/volume/'), index)
    const file = await index.get('/volume/a.txt')
    expect(file.entry?.resourceType).toBe('file')
    expect(file.entry?.size).toBe(6)
    expect(file.entry?.remoteTime).toBe('2023-11-14T22:13:20.000Z')
    const dir = await index.get('/volume/d')
    expect(dir.entry?.resourceType).toBe('folder')
  })

  it('serves and fills the index cache', async () => {
    const { fetch, calls } = routedFetch(() =>
      jsonResponse({ contents: [{ path: `${TEST_ROOT}/a.txt`, file_size: 1 }] }),
    )
    vi.stubGlobal('fetch', fetch)
    const index = new RAMIndexCacheStore()
    const first = await readdir(makeAccessor(), spec('/volume/'), index)
    const second = await readdir(makeAccessor(), spec('/volume/'), index)
    expect(first).toEqual(['/volume/a.txt'])
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
  })
})

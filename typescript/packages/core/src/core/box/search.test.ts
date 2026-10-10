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

// Mirror of python/tests/core/box/test_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'
import type * as ResolveModule from './resolve.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, searchContent: vi.fn() }
})

vi.mock('./resolve.ts', async () => {
  const actual = await vi.importActual<typeof ResolveModule>('./resolve.ts')
  return { ...actual, resolveItem: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { PathSpec } from '../../types.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import * as api from './api.ts'
import type { BoxSearchItem } from './api.ts'
import * as resolve from './resolve.ts'
import { filesContaining } from './search.ts'

const STUB_TM = {} as BoxTokenManager
const search = vi.mocked(api.searchContent)
const resolveItem = vi.mocked(resolve.resolveItem)

function makeAccessor(rootFolderId?: string): BoxAccessor {
  return new BoxAccessor({
    tokenManager: STUB_TM,
    contentSearch: true,
    ...(rootFolderId !== undefined ? { rootFolderId } : {}),
  })
}

function mountRoot(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', vfsPath: '' })
}

function file(id: string, name: string, chain: [string, string][]): BoxSearchItem {
  return {
    type: 'file',
    id,
    name,
    path_collection: {
      total_count: chain.length,
      entries: chain.map(([cid, cname]) => ({ type: 'folder', id: cid, name: cname })),
    },
  }
}

const ROOT: [string, string][] = [['0', 'All Files']]

beforeEach(() => {
  search.mockReset()
  resolveItem.mockReset()
})

describe('filesContaining', () => {
  it('names each hit from its path_collection', async () => {
    search.mockResolvedValueOnce({
      items: [
        file('2', 'x.txt', ROOT),
        file('3', 'y.txt', [...ROOT, ['100', 'Sub']]),
        file('4', 'out.txt', [['7', 'Elsewhere']]),
      ],
      truncated: false,
    })
    const out = await filesContaining(makeAccessor(), 'needle', [mountRoot()])
    expect(search.mock.calls[0]?.[2]).toBe('0')
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([
      ['/data/x.txt', 'x.txt'],
      ['/data/Sub/y.txt', 'Sub/y.txt'],
    ])
  })

  it('searches a subfolder scope under its folder id', async () => {
    const scope = new PathSpec({
      virtual: '/data/docs',
      directory: '/data/docs',
      vfsPath: 'docs',
    })
    resolveItem.mockResolvedValueOnce({ id: '100', type: 'folder', name: 'docs' })
    search.mockResolvedValueOnce({
      items: [file('5', 'in.txt', [...ROOT, ['100', 'docs']])],
      truncated: false,
    })
    const out = await filesContaining(makeAccessor(), 'needle', [scope])
    expect(search.mock.calls[0]?.[2]).toBe('100')
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([['/data/docs/in.txt', 'docs/in.txt']])
  })

  // No hit is distrusted too: Box indexes a write after it lands.
  it.each([
    ['an API failure', () => search.mockRejectedValueOnce(new BoxApiError('boom', 500))],
    [
      'a truncated answer',
      () => search.mockResolvedValueOnce({ items: [file('2', 'x.txt', ROOT)], truncated: true }),
    ],
    ['no hit', () => search.mockResolvedValueOnce({ items: [], truncated: false })],
  ])('is null for %s', async (_name, arrange) => {
    arrange()
    expect(await filesContaining(makeAccessor(), 'needle', [mountRoot()])).toBeNull()
  })

  it('is null for a scope that is no folder', async () => {
    const scope = new PathSpec({
      virtual: '/data/a.txt',
      directory: '/data/a.txt',
      vfsPath: 'a.txt',
    })
    resolveItem.mockResolvedValueOnce({ id: '9', type: 'file', name: 'a.txt' })
    expect(await filesContaining(makeAccessor(), 'needle', [scope])).toBeNull()
  })
})

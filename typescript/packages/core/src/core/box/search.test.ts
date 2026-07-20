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
import { BoxApiError, type BoxTokenManager } from './_client.ts'
import * as api from './api.ts'
import type { BoxSearchItem } from './api.ts'
import * as resolve from './resolve.ts'
import { narrowPaths } from './search.ts'

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
  return new PathSpec({ virtual: '/data', directory: '/data', resourcePath: '' })
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

describe('narrowPaths', () => {
  it('maps path_collection to mount paths', async () => {
    search.mockResolvedValueOnce({
      items: [file('2', 'x.txt', ROOT), file('3', 'y.txt', [...ROOT, ['100', 'Sub']])],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(search.mock.calls[0]?.[2]).toBe('0')
    expect(out?.map((p) => p.virtual)).toEqual(['/data/Sub/y.txt', '/data/x.txt'])
    expect(out?.[1]?.resourcePath).toBe('x.txt')
    expect(out?.[1]?.resolved).toBe(true)
  })

  it('sorts results in sorted-readdir walk order', async () => {
    // A sorted readdir walk descends into foo/ before visiting foo.txt;
    // plain lexicographic path order would put foo.txt first ('.' < '/').
    search.mockResolvedValueOnce({
      items: [file('2', 'foo.txt', ROOT), file('3', 'inner.txt', [...ROOT, ['100', 'foo']])],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(out?.map((p) => p.virtual)).toEqual(['/data/foo/inner.txt', '/data/foo.txt'])
  })

  it('rebases rawPath onto the scope spelling', async () => {
    const scope = new PathSpec({
      virtual: '/data',
      directory: '/data',
      resourcePath: '',
      rawPath: '.',
    })
    search.mockResolvedValueOnce({ items: [file('2', 'x.txt', ROOT)], truncated: false })
    const out = await narrowPaths(makeAccessor(), 'needle', [scope])
    expect(out?.[0]?.rawPath).toBe('./x.txt')
  })

  it('resolves a subfolder scope id and trims the key', async () => {
    const scope = new PathSpec({
      virtual: '/data/docs',
      directory: '/data/docs',
      resourcePath: 'docs',
    })
    resolveItem.mockResolvedValueOnce({ id: '100', type: 'folder', name: 'docs' })
    search.mockResolvedValueOnce({
      items: [file('5', 'in.txt', [...ROOT, ['100', 'docs']])],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor(), 'needle', [scope])
    expect(search.mock.calls[0]?.[2]).toBe('100')
    expect(out?.map((p) => p.virtual)).toEqual(['/data/docs/in.txt'])
  })

  it('returns null for a non-folder scope', async () => {
    const scope = new PathSpec({
      virtual: '/data/a.txt',
      directory: '/data/a.txt',
      resourcePath: 'a.txt',
    })
    resolveItem.mockResolvedValueOnce({ id: '9', type: 'file', name: 'a.txt' })
    const out = await narrowPaths(makeAccessor(), 'needle', [scope])
    expect(out).toBeNull()
  })

  it('returns null on an API failure', async () => {
    search.mockRejectedValueOnce(new BoxApiError('boom', 500))
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(out).toBeNull()
  })

  it('returns null for truncated results', async () => {
    search.mockResolvedValueOnce({ items: [file('2', 'x.txt', ROOT)], truncated: true })
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(out).toBeNull()
  })
})

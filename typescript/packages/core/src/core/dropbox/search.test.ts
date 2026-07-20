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

// Mirror of python/tests/core/dropbox/test_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, searchFiles: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import { DropboxApiError, type DropboxTokenManager } from './_client.ts'
import * as api from './api.ts'
import { narrowPaths } from './search.ts'

const STUB_TM = {} as DropboxTokenManager
const search = vi.mocked(api.searchFiles)

function makeAccessor(rootPath?: string): DropboxAccessor {
  return new DropboxAccessor({
    tokenManager: STUB_TM,
    ...(rootPath !== undefined ? { rootPath } : {}),
  })
}

function mountRoot(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', resourcePath: '' })
}

function subdir(): PathSpec {
  return new PathSpec({ virtual: '/data/docs', directory: '/data/docs', resourcePath: 'docs' })
}

beforeEach(() => {
  search.mockReset()
})

describe('narrowPaths', () => {
  it('maps API paths back to mount paths', async () => {
    search.mockResolvedValueOnce({
      paths: [
        ['/x.txt', '/x.txt'],
        ['/sub/y.txt', '/Sub/Y.txt'],
      ],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(search.mock.calls[0]?.[2]).toEqual({ path: '' })
    expect(out?.map((p) => p.virtual)).toEqual(['/data/Sub/Y.txt', '/data/x.txt'])
    expect(out?.[1]?.resourcePath).toBe('x.txt')
    expect(out?.[1]?.resolved).toBe(true)
  })

  it('strips the configured root path case-insensitively', async () => {
    search.mockResolvedValueOnce({
      paths: [['/team/sub/a.txt', '/Team/Sub/A.txt']],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor('/Team'), 'needle', [mountRoot()])
    expect(search.mock.calls[0]?.[2]).toEqual({ path: '/Team' })
    expect(out?.map((p) => p.virtual)).toEqual(['/data/Sub/A.txt'])
  })

  it('filters results outside the scope', async () => {
    search.mockResolvedValueOnce({
      paths: [
        ['/docs/in.txt', '/docs/in.txt'],
        ['/other/out.txt', '/other/out.txt'],
      ],
      truncated: false,
    })
    const out = await narrowPaths(makeAccessor(), 'needle', [subdir()])
    expect(search.mock.calls[0]?.[2]).toEqual({ path: '/docs' })
    expect(out?.map((p) => p.virtual)).toEqual(['/data/docs/in.txt'])
  })

  it('sorts results in sorted-readdir walk order', async () => {
    // A sorted readdir walk descends into foo/ before visiting foo.txt;
    // plain lexicographic path order would put foo.txt first ('.' < '/').
    search.mockResolvedValueOnce({
      paths: [
        ['/foo.txt', '/foo.txt'],
        ['/foo/inner.txt', '/foo/inner.txt'],
      ],
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
    search.mockResolvedValueOnce({ paths: [['/x.txt', '/x.txt']], truncated: false })
    const out = await narrowPaths(makeAccessor(), 'needle', [scope])
    expect(out?.[0]?.rawPath).toBe('./x.txt')
  })

  it('returns null on an API failure', async () => {
    search.mockRejectedValueOnce(new DropboxApiError('boom', 500))
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(out).toBeNull()
  })

  it('returns null for truncated results', async () => {
    search.mockResolvedValueOnce({ paths: [['/x.txt', '/x.txt']], truncated: true })
    const out = await narrowPaths(makeAccessor(), 'needle', [mountRoot()])
    expect(out).toBeNull()
  })
})

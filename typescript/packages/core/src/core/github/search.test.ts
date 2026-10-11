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

// Mirror of the narrow_paths tests in python/tests/core/github/test_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import type * as TreeModule from './tree.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, searchCode: vi.fn() }
})

vi.mock('./tree.ts', async () => {
  const actual = await vi.importActual<typeof TreeModule>('./tree.ts')
  return { ...actual, ensureTree: vi.fn() }
})

import { GitHubAccessor } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import * as client from './client.ts'
import { SCOPE_WARN } from './constants.ts'
import { filesContaining, narrowPaths, search as restSearch } from './search.ts'
import { ensureTree } from './tree.ts'
import type { TreeEntry } from './tree_entry.ts'

const search = vi.mocked(client.searchCode)
const loadTree = vi.mocked(ensureTree)
// GitHub's documented code-search limit; files at or over it are not indexed.
const SEARCH_LIMIT = 384 * 1024

function blob(path: string, size: number | null): TreeEntry {
  return { path, type: 'blob', sha: path, size }
}

function makeAccessor(tree: Record<string, TreeEntry>): GitHubAccessor {
  const transport: client.GitHubTransport = {
    get(): Promise<unknown> {
      throw new Error('search is mocked')
    },
    request(): Promise<unknown> {
      throw new Error('search is mocked')
    },
  }
  return new GitHubAccessor({
    transport,
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
    tree,
  })
}

function root(): PathSpec {
  return new PathSpec({ virtual: '/', directory: '/', vfsPath: '' })
}

function scope(name: string): PathSpec {
  return new PathSpec({ virtual: `/${name}`, directory: `/${name}`, vfsPath: name })
}

const SMALL = { 'src/a.py': blob('src/a.py', 10) }

beforeEach(() => {
  search.mockReset()
  loadTree.mockReset()
})

describe('filesContaining', () => {
  // A cold mount learns its tree is truncated only once it loads it.
  it('judges the tree it loads', async () => {
    loadTree.mockImplementationOnce((accessor) => {
      for (let i = 0; i <= SCOPE_WARN; i++)
        accessor.tree[`f${String(i)}`] = blob(`f${String(i)}`, 10)
      accessor.truncated = true
      return Promise.resolve()
    })
    const got = await filesContaining(
      makeAccessor({}),
      'needle',
      [root()],
      new RAMIndexCacheStore(),
    )
    expect(got).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })
})

describe('narrowPaths', () => {
  it('returns null for a truncated answer', async () => {
    search.mockResolvedValueOnce({ results: [{ path: 'src/a.py', sha: 'a' }], truncated: true })
    expect(await narrowPaths(makeAccessor(SMALL), 'needle', [root()])).toBeNull()
  })

  it('stops at the first truncated scope', async () => {
    // Code search is rate limited; a narrowing already void asks nothing more.
    search.mockResolvedValue({ results: [], truncated: true })
    const out = await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src'), scope('docs')])
    expect(out).toBeNull()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('lets a failed scope void the others', async () => {
    // A scope whose search failed contributes nothing, so the hits of the
    // scopes that did answer are not the whole set either.
    search
      .mockResolvedValueOnce({ results: [{ path: 'src/a.py', sha: 'a' }], truncated: false })
      .mockRejectedValueOnce(new Error('boom'))
    const out = await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src'), scope('docs')])
    expect(out).toBeNull()
  })

  it('adds the files code search never indexes, once', async () => {
    // Code search skips files at or over the limit, so a trusted narrowing
    // has to read them itself; one that is also a hit is listed once.
    const tree = {
      'src/a.py': blob('src/a.py', 10),
      'src/big.bin': blob('src/big.bin', SEARCH_LIMIT),
    }
    for (const hits of [['src/a.py'], ['src/a.py', 'src/big.bin']]) {
      search.mockResolvedValueOnce({
        results: hits.map((path) => ({ path, sha: path })),
        truncated: false,
      })
      const out = await narrowPaths(makeAccessor(tree), 'needle', [root()])
      expect(out?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
    }
  })

  it('adds big files only from the scope', async () => {
    // A big file elsewhere would put lines from outside the operand in the
    // output.
    const tree = {
      'src/a.py': blob('src/a.py', 10),
      'src/big.bin': blob('src/big.bin', SEARCH_LIMIT),
      'docs/big.md': blob('docs/big.md', SEARCH_LIMIT),
    }
    search.mockResolvedValueOnce({ results: [{ path: 'src/a.py', sha: 'a' }], truncated: false })
    const out = await narrowPaths(makeAccessor(tree), 'needle', [scope('src')])
    expect(out?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
  })

  it('returns null when the only scope fails, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    search.mockRejectedValueOnce(new Error('boom'))
    expect(await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src')])).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      'github code search failed (Error: boom); falling back to per-file scan',
    )
    warn.mockRestore()
  })

  it('filters a subdirectory scope by its repo-relative path', async () => {
    search.mockResolvedValueOnce({ results: [], truncated: false })
    await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src')])
    expect(search.mock.calls[0]?.[4]).toBe('src')
  })

  it('does not filter the root scope', async () => {
    search.mockResolvedValueOnce({ results: [], truncated: false })
    await narrowPaths(makeAccessor(SMALL), 'needle', [root()])
    expect(search.mock.calls[0]?.[4]).toBeUndefined()
  })

  it('does not let big files rescue a truncated answer', async () => {
    search.mockResolvedValueOnce({ results: [], truncated: true })
    const tree = { 'src/big.bin': blob('src/big.bin', SEARCH_LIMIT) }
    expect(await narrowPaths(makeAccessor(tree), 'needle', [root()])).toBeNull()
  })

  it('maps hits under the mount prefix', async () => {
    search.mockResolvedValueOnce({
      results: [
        { path: 'src/main.py', sha: 'a' },
        { path: 'src/utils.py', sha: 'b' },
      ],
      truncated: false,
    })
    const mounted = new PathSpec({ virtual: '/gh', directory: '/gh', vfsPath: '' })
    const out = await narrowPaths(makeAccessor(SMALL), 'import', [mounted])
    expect(out?.map((p) => p.virtual)).toEqual(['/gh/src/main.py', '/gh/src/utils.py'])
    expect(out?.map((p) => p.vfsPath)).toEqual(['src/main.py', 'src/utils.py'])
  })
})

it('paginates REST search and clips the final page', async () => {
  const requests: Record<string, string>[] = []
  const transport: client.GitHubTransport = {
    get: () => Promise.reject(new Error('expected response metadata')),
    request: () => Promise.reject(new Error('expected response metadata')),
    requestWithResponse: (_method, _path, _body, params = {}) => {
      requests.push({ ...params })
      const start = (Number(params.page) - 1) * 100
      return Promise.resolve({
        data: { items: Array.from({ length: 100 }, (_, i) => start + i) },
        status: 200,
        headers: { link: '<https://api.github.test/next>; rel="next"' },
      })
    },
  }
  expect(await restSearch(transport, 'issues', 'repo:acme/proj', 102, 'created', 'asc')).toEqual(
    Array.from({ length: 102 }, (_, i) => i),
  )
  expect(requests.map((params) => params.page)).toEqual(['1', '2'])
  expect(requests.every((params) => params.per_page === '100')).toBe(true)
  expect(requests[0]).toMatchObject({ sort: 'created', order: 'asc' })
})

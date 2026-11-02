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
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import type { GitHubTransport } from './client.ts'
import { SCOPE_WARN } from './constants.ts'
import { filesContaining, narrowPaths, search as restSearch, searchCode } from './search.ts'
import type { TreeEntry } from './tree_entry.ts'

// The code search endpoint, as the accessor's transport reaches it.
const search = vi.fn<(params: Record<string, string>) => Promise<unknown>>()
// GitHub's documented code-search limit; files at or over it are not indexed.
const SEARCH_LIMIT = 384 * 1024

function blob(path: string, size: number | null): TreeEntry {
  return { path, type: 'blob', sha: path, size }
}

// A code search answer naming `hits` in the mounted repository; a truncated
// one counts a row more than it carries.
function found(hits: { path: string; sha: string }[], truncated: boolean): Record<string, unknown> {
  return {
    total_count: hits.length + (truncated ? 1 : 0),
    incomplete_results: false,
    items: hits.map((hit) => ({ ...hit, repository: { full_name: 'acme/proj' } })),
  }
}

function makeAccessor(tree: Record<string, TreeEntry>): GitHubAccessor {
  const transport: GitHubTransport = {
    get(_path: string, params?: Record<string, string>): Promise<unknown> {
      return search(params ?? {})
    },
    request(): Promise<unknown> {
      throw new Error('unexpected request')
    },
  }
  return new GitHubAccessor({
    account: new GitHubAccount({ token: 't' }, transport),
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
})

describe('filesContaining', () => {
  // A truncated tree cannot list the files code search never indexes.
  it('leaves a truncated tree to the walk', async () => {
    const accessor = makeAccessor({})
    for (let i = 0; i <= SCOPE_WARN; i++) accessor.tree[`f${String(i)}`] = blob(`f${String(i)}`, 10)
    accessor.truncated = true
    expect(await filesContaining(accessor, 'needle', [root()])).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })
})

// Twin of the search_code tests in python/tests/core/github/test_search.py.
describe('searchCode', () => {
  type Item = Record<string, unknown>

  function stub(
    body: Record<string, unknown>,
    seen: Record<string, string>[] = [],
  ): GitHubTransport {
    return {
      get(_path: string, params?: Record<string, string>): Promise<unknown> {
        seen.push(params ?? {})
        return Promise.resolve(body)
      },
      request(): Promise<unknown> {
        throw new Error('unexpected request')
      },
    }
  }

  function item(path: string, fullName: unknown): Item {
    return { path, sha: path, repository: { full_name: fullName } }
  }

  function body(items: Item[], total?: unknown): Record<string, unknown> {
    return { total_count: total ?? items.length, incomplete_results: false, items }
  }

  it('asks for the largest page', async () => {
    // The default page is 30 rows, and a first page read as the whole
    // answer silently narrows grep to 30 files.
    const seen: Record<string, string>[] = []
    await searchCode(stub(body([]), seen), 'acme', 'proj', 'needle')
    expect(seen[0]?.per_page).toBe('100')
  })

  it('keeps only the mounted repository', async () => {
    // The pattern is sent verbatim, so a qualifier inside it can rescope the
    // search; a fork shares the repository name and a prefix is not a match.
    const out = await searchCode(
      stub(
        body([
          item('src/a.py', 'acme/proj'),
          item('src/a.py', 'other/x'),
          item('src/a.py', 'other/proj'),
          item('src/a.py', 'acme/other'),
          item('src/a.py', 'acme/proj-fork'),
        ]),
      ),
      'acme',
      'proj',
      'needle',
    )
    expect(out.results).toEqual([{ path: 'src/a.py', sha: 'src/a.py' }])
  })

  it.each([
    ['Acme/Proj', 'acme', 'proj'],
    ['acme/proj', 'Acme', 'Proj'],
  ])('compares %s with %s/%s case-insensitively', async (fullName, owner, repo) => {
    const out = await searchCode(stub(body([item('src/a.py', fullName)])), owner, repo, 'needle')
    expect(out.results.map((r) => r.path)).toEqual(['src/a.py'])
  })

  it.each<[string, Item]>([
    ['no repository', { path: 'src/a.py', sha: 'x' }],
    ['a null repository', { path: 'src/a.py', sha: 'x', repository: null }],
    ['an empty repository', { path: 'src/a.py', sha: 'x', repository: {} }],
    ['a null full_name', item('src/a.py', null)],
    ['a numeric full_name', item('src/a.py', 123)],
  ])('drops an item with %s, without throwing', async (_label, entry) => {
    // Nothing vouches for such an item, and dropping it must not throw: a
    // throw inside narrowPaths voids the whole narrowing.
    const out = await searchCode(stub(body([entry])), 'acme', 'proj', 'needle')
    expect(out.results).toEqual([])
  })

  it.each<[string, Record<string, unknown>, boolean]>([
    ['a count equal to the rows', { total_count: 1, incomplete_results: false }, false],
    ['a count below the rows', { total_count: 0, incomplete_results: false }, false],
    ['a count above the rows', { total_count: 2, incomplete_results: false }, true],
    ['incomplete results', { total_count: 1, incomplete_results: true }, true],
    ['no count', { incomplete_results: false }, true],
    ['a string count', { total_count: '1', incomplete_results: false }, true],
    ['a boolean count', { total_count: true, incomplete_results: false }, true],
    ['a fractional count', { total_count: 0.5, incomplete_results: false }, true],
    ['no incomplete flag', { total_count: 1 }, true],
  ])('reports %s as truncated=%s', async (_label, head, truncated) => {
    // Only an answer that says it is complete, with a count no larger than
    // the rows it carries, is the whole set; anything else is truncated.
    const out = await searchCode(
      stub({ ...head, items: [item('src/a.py', 'acme/proj')] }),
      'acme',
      'proj',
      'needle',
    )
    expect(out.truncated).toBe(truncated)
  })

  it('reads null items as no rows', async () => {
    const out = await searchCode(
      stub({ total_count: 0, incomplete_results: false, items: null }),
      'acme',
      'proj',
      'needle',
    )
    expect(out).toEqual({ results: [], truncated: false })
  })

  it('judges completeness before filtering', async () => {
    // total_count counts every row the search matched, foreign ones too.
    const out = await searchCode(
      stub(body([item('src/a.py', 'acme/proj'), item('src/b.py', 'other/x')])),
      'acme',
      'proj',
      'needle',
    )
    expect(out.results.map((r) => r.path)).toEqual(['src/a.py'])
    expect(out.truncated).toBe(false)
  })
})

describe('narrowPaths', () => {
  it('returns null for a truncated answer', async () => {
    search.mockResolvedValueOnce(found([{ path: 'src/a.py', sha: 'a' }], true))
    expect(await narrowPaths(makeAccessor(SMALL), 'needle', [root()])).toBeNull()
  })

  it('stops at the first truncated scope', async () => {
    // Code search is rate limited; a narrowing already void asks nothing more.
    search.mockResolvedValue(found([], true))
    const out = await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src'), scope('docs')])
    expect(out).toBeNull()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('lets a failed scope void the others', async () => {
    // A scope whose search failed contributes nothing, so the hits of the
    // scopes that did answer are not the whole set either.
    search
      .mockResolvedValueOnce(found([{ path: 'src/a.py', sha: 'a' }], false))
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
      search.mockResolvedValueOnce(
        found(
          hits.map((path) => ({ path, sha: path })),
          false,
        ),
      )
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
    search.mockResolvedValueOnce(found([{ path: 'src/a.py', sha: 'a' }], false))
    const out = await narrowPaths(makeAccessor(tree), 'needle', [scope('src')])
    expect(out?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
  })

  it('returns null when the only scope fails, and says why', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    search.mockRejectedValueOnce(new Error('boom'))
    expect(await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src')])).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      'github code search failed (Error: boom); falling back to per-file scan',
    )
    warn.mockRestore()
  })

  it('filters a subdirectory scope by its repo-relative path', async () => {
    search.mockResolvedValueOnce(found([], false))
    await narrowPaths(makeAccessor(SMALL), 'needle', [scope('src')])
    expect(search.mock.calls[0]?.[0].q).toBe('needle repo:acme/proj path:src')
  })

  it('does not filter the root scope', async () => {
    search.mockResolvedValueOnce(found([], false))
    await narrowPaths(makeAccessor(SMALL), 'needle', [root()])
    expect(search.mock.calls[0]?.[0].q).toBe('needle repo:acme/proj')
  })

  it('does not let big files rescue a truncated answer', async () => {
    search.mockResolvedValueOnce(found([], true))
    const tree = { 'src/big.bin': blob('src/big.bin', SEARCH_LIMIT) }
    expect(await narrowPaths(makeAccessor(tree), 'needle', [root()])).toBeNull()
  })

  it('maps hits under the mount prefix', async () => {
    search.mockResolvedValueOnce(
      found(
        [
          { path: 'src/main.py', sha: 'a' },
          { path: 'src/utils.py', sha: 'b' },
        ],
        false,
      ),
    )
    const mounted = new PathSpec({ virtual: '/gh', directory: '/gh', vfsPath: '' })
    const out = await narrowPaths(makeAccessor(SMALL), 'import', [mounted])
    expect(out?.map((p) => p.virtual)).toEqual(['/gh/src/main.py', '/gh/src/utils.py'])
    expect(out?.map((p) => p.vfsPath)).toEqual(['src/main.py', 'src/utils.py'])
  })
})

it('paginates REST search and clips the final page', async () => {
  const requests: Record<string, string>[] = []
  const transport: GitHubTransport = {
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

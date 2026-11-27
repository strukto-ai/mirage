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

// Mirror of python/tests/core/github/test_search.py.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { GitHubRepo, SEARCH, blobSha } from '../../../tests/core/github/repo.ts'
import type { GitHubTransport } from './client.ts'
import { SCOPE_WARN } from './constants.ts'
import { filesContaining, narrowPaths, searchCode } from './search.ts'
import { ensureTree } from './tree.ts'

// GitHub's documented code-search limit; files at or over it are not indexed.
const SEARCH_LIMIT = 384 * 1024
const SOURCES = { 'src/main.py': 'import os\n', 'src/utils.py': 'import os, sys\n' }
const FETCH = globalThis.fetch

let origin: string
let repo: GitHubRepo

beforeAll(async () => {
  origin = await serve('github')
})

beforeEach(() => {
  repo = new GitHubRepo(origin)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await repo.run.close()
})

function root(): PathSpec {
  return new PathSpec({ virtual: '/', directory: '/', vfsPath: '' })
}

function scope(name: string): PathSpec {
  return new PathSpec({ virtual: `/${name}`, directory: `/${name}`, vfsPath: name })
}

function transport(): GitHubTransport {
  return repo.accessor().account.transport
}

async function asked(): Promise<string[]> {
  return (await repo.run.params('GET', SEARCH)).map((params) => params.q ?? '')
}

// A code search answer naming `paths` in the mounted repository; a truncated
// one counts a row more than it carries.
function found(paths: string[], truncated: boolean): JsonValue {
  return {
    total_count: paths.length + (truncated ? 1 : 0),
    incomplete_results: false,
    items: paths.map((path) => ({ path, sha: path, repository: { full_name: 'integ-user/repo' } })),
  }
}

// An accessor whose tree is loaded, as a mount's is once it has listed.
async function loaded(): Promise<GitHubAccessor> {
  const accessor = repo.accessor()
  await ensureTree(accessor)
  return accessor
}

describe('filesContaining', () => {
  // A truncated tree cannot list the files code search never indexes, and a
  // cold mount learns its tree is truncated only once it loads it.
  it('leaves a truncated tree to the walk', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i <= SCOPE_WARN; i++) files[`f${String(i)}`] = 'needle\n'
    await repo.create(files)
    await repo.truncate()
    expect(await filesContaining(repo.accessor(), 'needle', [root()])).toBeNull()
    expect(await repo.count('recursive')).toBe(1)
    expect(await repo.count('search')).toBe(0)
  })

  // Twin of test_files_containing_asks_nothing_of_an_anonymous_account: code
  // search refuses a call with no credential, so it is not asked, and neither
  // is the tree its scope count would load. github.com's API host is reached
  // on the fake's run, so a request the account made would be listed.
  it('asks nothing of an anonymous account', async () => {
    await repo.create({ 'src/a.py': 'needle\n' })
    const api = 'https://api.github.com'
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const routed = url.startsWith(api) ? `${repo.run.url}${url.slice(api.length)}` : url
      return FETCH(input instanceof Request ? new Request(routed, input) : routed, init)
    })
    const accessor = new GitHubAccessor({
      account: new GitHubAccount({}),
      owner: repo.owner,
      repo: repo.name,
      ref: 'main',
      defaultBranch: 'main',
    })
    expect(await filesContaining(accessor, 'needle', [root()])).toBeNull()
    expect(await repo.log()).toEqual([])
  })
})

// Twin of the search_code tests in python/tests/core/github/test_search.py.
// The answers past the first test are code search's, with the rows or counts
// each case needs: the fake only answers rows of its own repositories, each
// counted.
describe('searchCode', () => {
  type Item = Record<string, JsonValue>

  function item(path: string, fullName: JsonValue): Item {
    return { path, sha: path, repository: { full_name: fullName } }
  }

  function body(items: Item[], total?: JsonValue): JsonValue {
    return { total_count: total ?? items.length, incomplete_results: false, items }
  }

  it('finds the files that hold every word, asking the largest page', async () => {
    // The default page is 30 rows, and a first page read as the whole
    // answer silently narrows grep to 30 files.
    await repo.create(SOURCES)
    const out = await searchCode(transport(), repo.owner, repo.name, 'import os')
    expect(out).toEqual({
      results: Object.entries(SOURCES).map(([path, data]) => ({ path, sha: blobSha(data) })),
      truncated: false,
    })
    expect(await repo.run.params('GET', SEARCH)).toEqual([
      { q: 'import os repo:integ-user/repo', per_page: '100' },
    ])
  })

  it('keeps only the mounted repository', async () => {
    // The pattern is sent verbatim, so a qualifier inside it can rescope the
    // search; a fork shares the repository name and a prefix is not a match.
    await repo.answer(
      'search',
      body([
        item('src/a.py', 'acme/proj'),
        item('src/a.py', 'other/x'),
        item('src/a.py', 'other/proj'),
        item('src/a.py', 'acme/other'),
        item('src/a.py', 'acme/proj-fork'),
      ]),
    )
    const out = await searchCode(transport(), 'acme', 'proj', 'needle')
    expect(out.results).toEqual([{ path: 'src/a.py', sha: 'src/a.py' }])
  })

  it.each([
    ['Acme/Proj', 'acme', 'proj'],
    ['acme/proj', 'Acme', 'Proj'],
  ])('compares %s with %s/%s case-insensitively', async (fullName, owner, name) => {
    await repo.answer('search', body([item('src/a.py', fullName)]))
    const out = await searchCode(transport(), owner, name, 'needle')
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
    await repo.answer('search', body([entry]))
    const out = await searchCode(transport(), 'acme', 'proj', 'needle')
    expect(out.results).toEqual([])
  })

  it.each<[string, Record<string, JsonValue>, boolean]>([
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
    await repo.answer('search', { ...head, items: [item('src/a.py', 'acme/proj')] })
    const out = await searchCode(transport(), 'acme', 'proj', 'needle')
    expect(out.truncated).toBe(truncated)
  })

  it('reads null items as no rows', async () => {
    await repo.answer('search', { total_count: 0, incomplete_results: false, items: null })
    const out = await searchCode(transport(), 'acme', 'proj', 'needle')
    expect(out).toEqual({ results: [], truncated: false })
  })

  it('judges completeness before filtering', async () => {
    // total_count counts every row the search matched, foreign ones too.
    await repo.answer('search', body([item('src/a.py', 'acme/proj'), item('src/b.py', 'other/x')]))
    const out = await searchCode(transport(), 'acme', 'proj', 'needle')
    expect(out.results.map((r) => r.path)).toEqual(['src/a.py'])
    expect(out.truncated).toBe(false)
  })
})

describe('narrowPaths', () => {
  it('returns null for a truncated answer', async () => {
    await repo.create({ 'src/a.py': 'needle\n' })
    await repo.answer('search', found(['src/a.py'], true))
    expect(await narrowPaths(await loaded(), 'needle', [root()])).toBeNull()
  })

  it('stops at the first truncated scope', async () => {
    // Code search is rate limited; a narrowing already void asks nothing more.
    await repo.create({ 'src/a.py': 'needle\n', 'docs/b.md': 'needle\n' })
    await repo.answer('search', found([], true), 2)
    const out = await narrowPaths(await loaded(), 'needle', [scope('src'), scope('docs')])
    expect(out).toBeNull()
    expect(await repo.count('search')).toBe(1)
  })

  it('lets a failed scope void the others', async () => {
    // A scope whose search failed contributes nothing, so the hits of the
    // scopes that did answer are not the whole set either.
    await repo.create({ 'src/a.py': 'needle\n', 'docs/b.md': 'needle\n' })
    await repo.run.answerNext(
      'GET',
      SEARCH,
      422,
      { message: 'boom' },
      1,
      undefined,
      repo.searchQuery('needle repo:integ-user/repo path:docs'),
    )
    const out = await narrowPaths(await loaded(), 'needle', [scope('src'), scope('docs')])
    expect(out).toBeNull()
    expect(await repo.count('search')).toBe(2)
  })

  it('adds the files code search never indexes, once', async () => {
    // Code search skips files at or over the limit, so a trusted narrowing
    // has to read them itself, off the tree the mount loaded; one an answer
    // also names is listed once.
    await repo.create({ 'src/a.py': 'needle\n', 'src/big.bin': 'needle\n'.padEnd(SEARCH_LIMIT) })
    const accessor = await loaded()
    const out = await narrowPaths(accessor, 'needle', [root()])
    expect(out?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
    await repo.answer('search', found(['src/a.py', 'src/big.bin'], false))
    const again = await narrowPaths(accessor, 'needle', [root()])
    expect(again?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
  })

  it('adds big files only from the scope', async () => {
    // A big file elsewhere would put lines from outside the operand in the
    // output.
    const big = 'needle\n'.padEnd(SEARCH_LIMIT)
    await repo.create({ 'src/a.py': 'needle\n', 'src/big.bin': big, 'docs/big.md': big })
    const out = await narrowPaths(await loaded(), 'needle', [scope('src')])
    expect(out?.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/big.bin'])
  })

  it('returns null when the only scope fails, and says why', async () => {
    await repo.create({ 'src/a.py': 'needle\n' })
    await repo.refuse('search', 422, 'boom')
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(await narrowPaths(await loaded(), 'needle', [scope('src')])).toBeNull()
    const said = warn.mock.calls.map((call) => String(call[0]))
    expect(said).toContainEqual(expect.stringMatching(/^github code search failed \(.*boom/))
    expect(said).toContainEqual(expect.stringMatching(/falling back to per-file scan$/))
  })

  it('filters a subdirectory scope by its repo-relative path', async () => {
    await repo.create({ 'src/a.py': 'needle\n' })
    await narrowPaths(await loaded(), 'needle', [scope('src')])
    expect(await asked()).toEqual(['needle repo:integ-user/repo path:src'])
  })

  it('does not filter the root scope', async () => {
    await repo.create({ 'src/a.py': 'needle\n' })
    await narrowPaths(await loaded(), 'needle', [root()])
    expect(await asked()).toEqual(['needle repo:integ-user/repo'])
  })

  it('does not let big files rescue a truncated answer', async () => {
    await repo.create({ 'src/big.bin': 'needle\n'.padEnd(SEARCH_LIMIT) })
    await repo.answer('search', found([], true))
    expect(await narrowPaths(await loaded(), 'needle', [root()])).toBeNull()
  })

  it('maps hits under the mount prefix', async () => {
    await repo.create(SOURCES)
    const mounted = new PathSpec({ virtual: '/gh', directory: '/gh', vfsPath: '' })
    const out = await narrowPaths(await loaded(), 'import', [mounted])
    expect(out?.map((p) => p.virtual)).toEqual(['/gh/src/main.py', '/gh/src/utils.py'])
    expect(out?.map((p) => p.vfsPath)).toEqual(['src/main.py', 'src/utils.py'])
  })
})

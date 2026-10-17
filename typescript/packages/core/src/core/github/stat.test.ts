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
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { ContentType, type FileStat, FileType, PathSpec } from '../../types.ts'
import { entryAt } from '../../workspace/fixtures/handed.ts'
import { GitHubApiError, type GitHubTransport } from './client.ts'
import { readdir } from './readdir.ts'
import { stat, tree } from './stat.ts'
import { blobSha, FakeGitHub, servedAccessor } from './_test_util.ts'

const ROOT = new PathSpec({ vfsPath: '', virtual: '/gh', directory: '/gh' })
const FILES = { 'src/main.py': 'x'.repeat(120), 'README.md': 'y'.repeat(50) }

function serve(files: Record<string, string>): FakeGitHub {
  const gh = new FakeGitHub(files)
  vi.stubGlobal('fetch', gh.fetch)
  return gh
}

function under(virtual: string): PathSpec {
  return new PathSpec({
    vfsPath: virtual.slice('/gh/'.length),
    virtual,
    directory: virtual,
  })
}

// Stat a path the way the mount does: handed the row its folder lists.
async function statAt(accessor: GitHubAccessor, path: PathSpec): Promise<FileStat> {
  return stat(accessor, path, await entryAt(readdir, accessor, path))
}

describe('github stat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('answers a file with the row its folder lists', async () => {
    serve(FILES)
    const found = await statAt(servedAccessor(), under('/gh/src/main.py'))
    const sha = await blobSha('x'.repeat(120))
    expect([found.name, found.size, found.content, found.fingerprint, found.extra]).toEqual([
      'main.py',
      120,
      ContentType.TEXT,
      sha,
      { sha },
    ])
  })

  it('answers a folder and the root with no fingerprint', async () => {
    serve(FILES)
    const accessor = servedAccessor()
    const found = await statAt(accessor, under('/gh/src'))
    const root = await stat(accessor, ROOT)
    expect([found.name, found.type, found.fingerprint]).toEqual(['src', FileType.DIRECTORY, null])
    expect([root.name, root.type, root.fingerprint]).toEqual(['/', FileType.DIRECTORY, null])
  })

  it('answers ENOENT for a path no listing names', async () => {
    serve(FILES)
    await expect(statAt(servedAccessor(), under('/gh/nonexistent.py'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // A tree the backend refuses is no answer about the path, so the refusal
  // surfaces rather than ENOENT.
  it('propagates a listing failure', async () => {
    const gh = serve(FILES)
    gh.fail.set('recursive', [500, 'boom'])
    await expect(statAt(servedAccessor(), under('/gh/missing.py'))).rejects.toMatchObject({
      status: 500,
    })
  })
})

describe('the gate check', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the parent directory', async () => {
    const gh = serve(FILES)
    const accessor = servedAccessor()
    const check = new ListingCheckStore()
    const found = await stat(accessor, under('/gh/src/main.py'), null, check)
    expect(found.fingerprint).toBe(await blobSha('x'.repeat(120)))
    await expect(stat(accessor, under('/gh/src/nope.py'), null, check)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(gh.counts()).toEqual([2, 0, 0])
  })

  it('asks the whole tree past a cut listing', async () => {
    const gh = serve(FILES)
    gh.truncatedDirs.set('src', 0)
    const found = await stat(
      servedAccessor(),
      under('/gh/src/main.py'),
      null,
      new ListingCheckStore(),
    )
    expect(found.size).toBe(120)
    expect(gh.counts()).toEqual([1, 1, 0])
  })

  // A point lookup that cannot see the parent defers; a truncated tree then
  // walks down from the ref one folder at a time.
  it('walks a truncated tree by its folders', async () => {
    const asked: string[] = []
    const get = vi.fn((path: string, params?: Record<string, string>) => {
      const segment = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
      asked.push(params?.recursive === '1' ? `${segment} recursive` : segment)
      if (segment === 'main:docs/sub') throw new GitHubApiError('Not Found', 404)
      if (params?.recursive === '1') {
        return Promise.resolve({
          tree: [{ path: 'docs', type: 'tree', sha: 'd' }],
          truncated: true,
        })
      }
      const rows: Record<string, unknown[]> = {
        main: [{ path: 'docs', type: 'tree', sha: 'd' }],
        d: [{ path: 'sub', type: 'tree', sha: 's' }],
        s: [{ path: 'b.txt', type: 'blob', sha: 'b', size: 1 }],
      }
      return Promise.resolve({ tree: rows[segment] ?? [], truncated: false })
    })
    const accessor = new GitHubAccessor({
      account: new GitHubAccount({ token: 't' }, {
        get,
        request: vi.fn(),
      } as unknown as GitHubTransport),
      owner: 'o',
      repo: 'r',
      ref: 'main',
      defaultBranch: 'main',
    })
    const found = await stat(accessor, under('/gh/docs/sub/b.txt'), null, new ListingCheckStore())
    expect(found.size).toBe(1)
    expect(asked).toEqual(['main:docs/sub', 'main recursive', 'main', 'd', 's'])
  })
})

function three(): FakeGitHub {
  return serve(
    Object.fromEntries(
      ['d1', 'd2', 'd3'].flatMap((d) => ['a', 'b', 'c'].map((n) => [`${d}/${n}.txt`, 'x\n'])),
    ),
  )
}

describe('the root stat names the head commit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Through any store but the gate's check the root names no version and
  // asks nothing; only the check wants that request.
  it('asks nothing outside a check', async () => {
    const gh = three()
    const accessor = servedAccessor()
    const found = await stat(accessor, ROOT)
    expect(found.fingerprint).toBeNull()
    expect(gh.counts()).toEqual([0, 0, 0])
    const checked = await stat(accessor, ROOT, null, new ListingCheckStore())
    expect(checked.fingerprint).toBe(await gh.head())
  })

  // A refused head names no version, never falls into a refill, and says why
  // on stderr, the way Python logs it.
  it.each([404, 500])('names no version when the head answers %i', async (status) => {
    const gh = three()
    gh.fail.set('dir', [status, 'refused'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const accessor = servedAccessor()
    const found = await stat(accessor, ROOT, null, new ListingCheckStore())
    expect(found.fingerprint).toBeNull()
    expect(gh.count('recursive')).toBe(0)
    expect(accessor.tree).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^head of [^/]+\/[^ ]+ not answered: /)
    warn.mockRestore()
  })
})

describe('tree', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Mirrors test_tree_answers_each_entry_as_its_listing_does.
  it('answers each entry as its listing does', async () => {
    serve({ 'docs/a.txt': 'alpha', 'docs/sub/b.txt': 'bb', 'top.txt': 't' })
    const accessor = servedAccessor()
    const found = await tree(accessor, under('/gh/docs'))
    if (found === null) throw new Error('expected a tree')
    expect([...found.keys()].sort()).toEqual(['a.txt', 'sub', 'sub/b.txt'])
    const listing = await readdir(accessor, under('/gh/docs'))
    expect(new Map(listing.entries.map((row) => [row.name, row]))).toEqual(
      new Map([
        ['a.txt', found.get('a.txt')],
        ['sub', found.get('sub')],
      ]),
    )
    expect([...((await tree(accessor, ROOT)) ?? new Map()).keys()].sort()).toEqual([
      'docs',
      'docs/a.txt',
      'docs/sub',
      'docs/sub/b.txt',
      'top.txt',
    ])
  })

  // Mirrors test_tree_leaves_a_file_and_a_truncated_tree_to_the_walk.
  it('leaves a file and a truncated tree to the walk', async () => {
    const files = { 'docs/a.txt': 'alpha', 'top.txt': 't' }
    serve(files)
    const accessor = servedAccessor()
    expect(await tree(accessor, under('/gh/top.txt'))).toBeNull()
    expect(await tree(accessor, under('/gh/nope'))).toBeNull()
    const cut = serve(files)
    cut.truncatedRecursive = true
    const walker = servedAccessor()
    expect(await tree(walker, ROOT)).toBeNull()
    expect(await tree(walker, ROOT)).toBeNull()
    expect(cut.count('recursive')).toBe(1)
  })
})

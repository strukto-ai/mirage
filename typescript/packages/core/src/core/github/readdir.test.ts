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
import { GitHubAccessor } from '../../accessor/github.ts'
import { type DirListing, FileType, PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { GitHubApiError, HttpGitHubTransport, type GitHubTransport } from './client.ts'
import { BASE, FakeGitHub, servedAccessor } from './_test_util.ts'

const TREE = [
  { path: 'src', type: 'tree', sha: 'aaa' },
  { path: 'src/main.py', type: 'blob', sha: 'bbb', size: 120 },
  { path: 'src/utils', type: 'tree', sha: 'ccc' },
  { path: 'src/utils/helpers.py', type: 'blob', sha: 'ddd', size: 80 },
  { path: 'README.md', type: 'blob', sha: 'eee', size: 50 },
]

function accessor(): GitHubAccessor {
  const transport = {
    get: () => Promise.resolve({ tree: TREE, truncated: false, sha: 'HEAD1' }),
  } as unknown as GitHubTransport
  return new GitHubAccessor({
    transport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
  })
}

function spec(rel: string, prefix = ''): PathSpec {
  const virtual = rel === '' ? prefix || '/' : `${prefix}/${rel}`
  return new PathSpec({ vfsPath: rel, virtual, directory: virtual })
}

function names(listing: DirListing): string[] {
  return listing.entries.map((row) => row.name)
}

describe('github readdir', () => {
  it.each([
    ['', ['README.md', 'src']],
    ['src', ['main.py', 'utils']],
    ['src/utils', ['helpers.py']],
  ])('lists the folder %j of the tree', async (rel, expected) => {
    expect(names(await readdir(accessor(), spec(rel)))).toEqual(expected)
  })

  it('seeds every folder below at the head of its one tree', async () => {
    const listing = await readdir(accessor(), spec(''))
    expect(listing.version).toBe('HEAD1')
    expect(
      Object.fromEntries([...listing.seeds].map(([k, v]) => [k, v.map((r) => r.name)])),
    ).toEqual({ src: ['main.py', 'utils'], 'src/utils': ['helpers.py'] })
    const src = listing.seeds.get('src') ?? []
    const utils = src.find((row) => row.name === 'utils')
    expect([utils?.type, utils?.extra]).toEqual([FileType.DIRECTORY, { sha: 'ccc' }])
    expect([src[0]?.size, src[0]?.fingerprint]).toEqual([120, 'bbb'])
  })

  it('versions each listing by the head its own tree was read at', async () => {
    // Two listings whose trees land together: the second reseats the
    // accessor before the first one's listing is built.
    const heads = ['HEAD1', 'HEAD2']
    let release = (): void => undefined
    const landed = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = {
      get: async () => {
        const sha = heads.shift()
        await landed
        return { tree: TREE, truncated: false, sha }
      },
    } as unknown as GitHubTransport
    const shared = new GitHubAccessor({
      transport,
      owner: 'o',
      repo: 'r',
      ref: 'main',
      defaultBranch: 'main',
    })
    const both = Promise.all([readdir(shared, spec('src')), readdir(shared, spec(''))])
    release()
    const [first, second] = await both
    expect([first.version, second.version]).toEqual(['HEAD1', 'HEAD2'])
  })

  it('refuses what is no folder', async () => {
    await expect(readdir(accessor(), spec('nonexistent'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readdir(accessor(), spec('README.md'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

describe('the truncated walk', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function truncated(gh: FakeGitHub): GitHubAccessor {
    gh.truncatedRecursive = true
    vi.stubGlobal('fetch', gh.fetch)
    return new GitHubAccessor({
      transport: new HttpGitHubTransport({ token: 't', baseUrl: BASE }),
      owner: 'o',
      repo: 'r',
      ref: 'main',
      defaultBranch: 'main',
      truncated: true,
      tree: {},
    })
  }

  it('lists each folder by its sha', async () => {
    const gh = new FakeGitHub({ 'top.txt': 't', 'docs/sub/b.txt': 'b' })
    const walker = truncated(gh)
    const root = await readdir(walker, spec('', '/gh'))
    expect(names(root)).toEqual(['docs', 'top.txt'])
    const docs = await readdir(walker, spec('docs', '/gh'), root.entries[0])
    expect(names(docs)).toEqual(['sub'])
    expect(gh.count('recursive')).toBe(0)
    await expect(readdir(walker, spec('docs', '/gh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a directory GitHub cut short', async () => {
    const gh = new FakeGitHub({ 'top.txt': 't', 'big/a.txt': 'a', 'big/b.txt': 'b' })
    const walker = truncated(gh)
    gh.truncatedDirs.set('big', 1)
    const root = await readdir(walker, spec('', '/gh'))
    const big = root.entries.find((row) => row.name === 'big')
    const err = await readdir(walker, spec('big', '/gh'), big).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).message).toContain('truncated the tree listing')
  })
})

describe('a fresh tree', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a folder it dropped as missing', async () => {
    const gh = new FakeGitHub({ 'docs/a.txt': 'a', 'top.txt': 't' })
    vi.stubGlobal('fetch', gh.fetch)
    gh.files.delete('docs/a.txt')
    await expect(readdir(servedAccessor(), spec('docs', '/gh'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

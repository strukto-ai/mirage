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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GitHubAccessor } from '../../accessor/github.ts'
import { type DirListing, FileType, PathSpec } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { readdir } from './readdir.ts'
import { GitHubApiError } from './client.ts'
import { GitHubRepo, TREES, blobSha } from '../../../tests/core/github/repo.ts'

const FILES = {
  'src/main.py': 'm'.repeat(120),
  'src/utils/helpers.py': 'h'.repeat(80),
  'README.md': 'r'.repeat(50),
}

let origin: string
let repo: GitHubRepo

beforeAll(async () => {
  origin = await serve('github')
})

beforeEach(() => {
  repo = new GitHubRepo(origin)
})

afterEach(async () => {
  await repo.run.close()
})

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
    await repo.create(FILES)
    expect(names(await readdir(repo.accessor(), spec(rel)))).toEqual(expected)
  })

  it('seeds every folder below at the head of its one tree', async () => {
    const head = await repo.create(FILES)
    const utilsSha = (await repo.tree('main:src')).tree.find((row) => row.path === 'utils')?.sha
    const listing = await readdir(repo.accessor(), spec(''))
    expect(listing.version).toBe(head)
    expect(
      Object.fromEntries([...listing.seeds].map(([k, v]) => [k, v.map((r) => r.name)])),
    ).toEqual({ src: ['main.py', 'utils'], 'src/utils': ['helpers.py'] })
    const src = listing.seeds.get('src') ?? []
    const utils = src.find((row) => row.name === 'utils')
    expect([utils?.type, utils?.extra]).toEqual([FileType.DIRECTORY, { sha: utilsSha }])
    expect([src[0]?.size, src[0]?.fingerprint]).toEqual([120, blobSha('m'.repeat(120))])
  })

  // Twin of test_each_listing_is_versioned_by_its_own_trees_head: two
  // listings on one accessor whose trees answer at different heads. The first
  // fetch is answered with the tree from before a push, and lands only after
  // the second listing, fetched after the push, has reseated the accessor.
  it('versions each listing by the head its own tree was read at', async () => {
    const firstHead = await repo.create(FILES)
    const beforePush = await repo.tree('main', true)
    const shared = repo.accessor()
    let second: DirListing | undefined
    let pushed = ''
    await repo.run.beforeNext([['GET', TREES]], async () => {
      pushed = await repo.commit({ 'src/new.py': 'n' })
      second = await readdir(shared, spec(''))
      await repo.run.answerNext('GET', TREES, 200, beforePush, 1, undefined, 'recursive=1')
    })
    const first = await readdir(shared, spec('src'))
    expect([first.version, second?.version]).toEqual([firstHead, pushed])
  })

  it('refuses what is no folder', async () => {
    await repo.create(FILES)
    const accessor = repo.accessor()
    await expect(readdir(accessor, spec('nonexistent'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readdir(accessor, spec('README.md'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

describe('the truncated walk', () => {
  function truncated(): GitHubAccessor {
    return new GitHubAccessor({
      account: repo.accessor().account,
      owner: repo.owner,
      repo: repo.name,
      ref: 'main',
      defaultBranch: 'main',
      truncated: true,
      tree: {},
    })
  }

  it('lists each folder by its sha', async () => {
    await repo.create({ 'top.txt': 't', 'docs/sub/b.txt': 'b' })
    await repo.truncate()
    const walker = truncated()
    const root = await readdir(walker, spec('', '/gh'))
    expect(names(root)).toEqual(['docs', 'top.txt'])
    const docs = await readdir(walker, spec('docs', '/gh'), root.entries[0])
    expect(names(docs)).toEqual(['sub'])
    expect(await repo.count('recursive')).toBe(0)
    await expect(readdir(walker, spec('docs', '/gh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is no miss while the repository is lost', async () => {
    // GitHub answers a repository the token can no longer read as it answers
    // a missing path; only a ref that still resolves makes a miss.
    await repo.create({ 'top.txt': 't', 'docs/sub/b.txt': 'b' })
    await repo.truncate()
    const walker = truncated()
    const root = await readdir(walker, spec('', '/gh'))
    await repo.refuse('dir', 404, 'Not Found')
    const err = await readdir(walker, spec('docs', '/gh'), root.entries[0]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    await repo.run.clearAnswers()
    await repo.commit({ 'docs/sub/b.txt': null })
    await expect(readdir(walker, spec('docs', '/gh'), root.entries[0])).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses a directory GitHub cut short', async () => {
    await repo.create({ 'top.txt': 't', 'big/a.txt': 'a', 'big/b.txt': 'b' })
    await repo.truncate()
    await repo.cutShort('big', 1)
    const walker = truncated()
    const root = await readdir(walker, spec('', '/gh'))
    const big = root.entries.find((row) => row.name === 'big')
    const err = await readdir(walker, spec('big', '/gh'), big).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).message).toContain('truncated the tree listing')
  })
})

describe('a fresh tree', () => {
  it('reports a folder it dropped as missing', async () => {
    await repo.create({ 'docs/a.txt': 'a', 'top.txt': 't' })
    const accessor = repo.accessor()
    await repo.commit({ 'docs/a.txt': null })
    await expect(readdir(accessor, spec('docs', '/gh'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

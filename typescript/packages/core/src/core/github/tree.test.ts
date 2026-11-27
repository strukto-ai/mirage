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
import { GitHubApiError, type GitHubTransport } from './client.ts'
import { fetchDirTree, fetchTree, refreshTree } from './tree.ts'
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Evicted } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { IndexView } from '../../cache/index/view.ts'
import { PathSpec } from '../../types.ts'
import { keepListing } from '../../workspace/mount/listing.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { readdir } from './readdir.ts'
import { pointRow, treeRows } from './tree.ts'
import { GitHubRepo, TREES, blobSha } from '../../../tests/core/github/repo.ts'

// A commit no tree holds, for a submodule to pin.
const PINNED = 'c'.repeat(40)

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

function root(prefix: string): PathSpec {
  return new PathSpec({ virtual: prefix, directory: prefix, vfsPath: '' })
}

function transport(): GitHubTransport {
  return repo.accessor().account.transport
}

describe('github tree fetch', () => {
  it.each([{}, { tree: null }, { tree: {} }])(
    'refuses a missing recursive listing',
    async (value) => {
      await repo.create({ 'a.txt': 'a' })
      await repo.answer('recursive', value)
      await expect(fetchTree(transport(), repo.owner, repo.name, 'main')).rejects.toThrow(
        'carries no tree',
      )
    },
  )

  it('preserves a blob named __proto__ when indexing its directory', async () => {
    await repo.create(Object.fromEntries([['__proto__', 'ab']]))
    const { tree } = await fetchTree(transport(), repo.owner, repo.name, 'main')
    expect(Object.keys(tree)).toEqual(['__proto__'])
    expect(treeRows(tree).get('')).toHaveLength(1)
  })

  it('excludes submodule gitlinks from the recursive tree', async () => {
    await repo.create({ 'main.py': 'x = 1\n', 'src/a.py': 'a' })
    await repo.link('extern', PINNED)
    expect((await repo.tree('main', true)).tree.map((row) => row.path)).toContain('extern')
    const { tree, truncated } = await fetchTree(transport(), repo.owner, repo.name, 'main')
    expect(truncated).toBe(false)
    expect(Object.keys(tree)).toEqual(['main.py', 'src', 'src/a.py'])
  })

  it('excludes submodule gitlinks from per-directory trees', async () => {
    await repo.create({ 'pkg/main.py': 'x = 1\n' })
    await repo.link('pkg/extern', PINNED)
    const pkg = (await repo.tree('main:pkg')).sha
    const entries = await fetchDirTree(transport(), repo.owner, repo.name, pkg)
    expect(entries.map((e) => e.path)).toEqual(['main.py'])
  })
})

describe('a listing', () => {
  it('refetches rather than reuse the build-time tree', async () => {
    // The build tree is only true at build time: a mount's first listing can
    // come long after it, so reusing it would answer a repository several
    // external writes ago.
    await repo.create({ 'data/keep.txt': 'keep' })
    const accessor = new GitHubAccessor({
      account: repo.accessor().account,
      owner: repo.owner,
      repo: repo.name,
      ref: 'main',
      defaultBranch: 'main',
      tree: { data: { path: 'data', type: 'tree', sha: 't0', size: null } },
    })
    const listing = await readdir(accessor, root('/gh'))
    expect(await repo.count('recursive')).toBe(1)
    expect(listing.seeds.get('data')?.map((row) => row.name)).toEqual(['keep.txt'])
  })
})

// A drop while GitHub answered may be for the very write the tree predates:
// the caller gets the tree, and the accessor does not keep it.
describe('a tree answered after a drop', () => {
  it('reaches its caller unkept', async () => {
    await repo.create({ 'a.txt': 'a' })
    const accessor = repo.accessor()
    await repo.run.beforeNext([['GET', TREES]], () => {
      accessor.forget()
    })
    const fetched = await refreshTree(accessor)
    expect(Object.keys(fetched?.tree ?? {})).toEqual(['a.txt'])
    expect(accessor.tree).toEqual({})
  })
})

describe('treeRows', () => {
  it('keys each folder by its repo path', () => {
    const rows = treeRows({
      data: { path: 'data', type: 'tree', sha: 't1', size: null },
      'data/keep.txt': { path: 'data/keep.txt', type: 'blob', sha: 'b1', size: 4 },
    })
    expect(
      Object.fromEntries([...rows].map(([folder, found]) => [folder, found.map((r) => r.name)])),
    ).toEqual({ '': ['data'], data: ['keep.txt'] })
    expect(rows.get('data')?.[0]?.extra).toEqual({ sha: 'b1' })
  })

  it('gives an empty repo a root listing', () => {
    expect(treeRows({})).toEqual(new Map([['', []]]))
  })
})

// The same rows as python's test_tree.py: a parent Octokit would rewrite
// unencoded (two or more lowercase letters, measured on
// @octokit/endpoint@11.0.4: `main:src` is sent as `main`), its uppercase
// control, a nested parent a raw slash would split, characters that truncate
// or template a URL, and a ref with a slash in it.
const ENCODED: [string, string][] = [
  ['main', 'src'],
  ['main', 'Src'],
  ['main', 'docs/sub'],
  ['main', 'a b'],
  ['main', 'a#b'],
  ['main', 'a?b'],
  ['main', 'a%b'],
  ['main', 'ü'],
  ['main', 'x:y'],
  ['main', 'a{b}'],
  ['release/1.80', 'docs/sub'],
]

describe('the point request', () => {
  for (const [ref, parent] of ENCODED) {
    it(`sends ${ref}:${parent} as one segment`, async () => {
      await repo.create({ [`${parent}/f.txt`]: 'payload', 'src/decoy.txt': 'decoy' })
      if (ref !== 'main') await repo.branch(ref)
      const found = await pointRow(repo.accessor(ref), `${parent}/f.txt`)
      expect(found?.entry?.sha).toBe(blobSha('payload'))
      const log = await repo.log()
      expect(log).toHaveLength(1)
      const [name, segment] = log[0] ?? ['', '']
      expect(name).toBe('dir')
      expect(segment).not.toContain('/')
      expect(decodeURIComponent(segment)).toBe(`${ref}:${parent}`)
      if (parent === 'src') expect(segment).toBe('main%3Asrc')
    })
  }

  it('asks a root child through the ref itself', async () => {
    await repo.create({ 'a.txt': 'a' })
    expect((await pointRow(repo.accessor(), 'a.txt'))?.entry).not.toBeNull()
    expect(await repo.log()).toEqual([['dir', 'main']])
  })

  it('answers each kind of listing', async () => {
    await repo.create({ 'docs/a.txt': 'alpha', 'docs/b.txt': 'bravo' })
    const accessor = repo.accessor()
    const found = await pointRow(accessor, 'docs/a.txt')
    expect([found?.entry?.sha, found?.truncated]).toEqual([blobSha('alpha'), false])
    expect(await pointRow(accessor, 'docs/nope.txt')).toEqual({ entry: null, truncated: false })
    await repo.cutShort('docs', 1)
    expect(await pointRow(accessor, 'docs/b.txt')).toEqual({ entry: null, truncated: true })
    await repo.run.clearAnswers()
    // A missing directory, a deleted ref and a path through a file all
    // defer to the tree rather than answering absent.
    expect(await pointRow(accessor, 'gone/a.txt')).toBeNull()
    expect(await pointRow(accessor, 'docs/a.txt/x')).toBeNull()
    expect(await pointRow(repo.accessor('deleted'), 'docs/a.txt')).toBeNull()
    for (const status of [401, 403]) {
      await repo.refuse('dir', status, 'refused')
      const err = await pointRow(accessor, 'docs/a.txt').catch((e: unknown) => e)
      expect((err as GitHubApiError).status).toBe(status)
      await repo.run.clearAnswers()
    }
    await repo.refuse('dir', 404, 'Not Found')
    expect(await pointRow(accessor, 'docs/a.txt')).toBeNull()
  })

  // Octokit's retry plugin retries these statuses with a multi-second
  // backoff, so they are raised by a transport rather than served.
  for (const status of [409, 429, 500]) {
    it(`raises ${String(status)} rather than deferring`, async () => {
      const refusing = {
        get: () => Promise.reject(new GitHubApiError('refused', status)),
        request: () => Promise.reject(new Error('unused')),
      } as unknown as GitHubTransport
      const accessor = new GitHubAccessor({
        account: new GitHubAccount({ token: 't' }, refusing),
        owner: 'o',
        repo: 'r',
        ref: 'main',
        defaultBranch: 'main',
      })
      const err = await pointRow(accessor, 'docs/a.txt').catch((e: unknown) => e)
      expect((err as GitHubApiError).status).toBe(status)
    })
  }

  it('refuses an answer that carries no tree', async () => {
    await repo.create({ 'docs/a.txt': 'a' })
    await repo.answer('dir', { message: 'something else' })
    const err = await pointRow(repo.accessor(), 'docs/a.txt').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(0)
    expect((err as GitHubApiError).message).toContain('carries no tree')
  })
})

function recording(): { gone: Evicted[]; index: IndexView } {
  const gone: Evicted[] = []
  const index = new IndexView(
    new RAMIndexCacheStore(),
    new RAMFileCacheStore(),
    '/gh',
    () => true,
    {
      onGone: (children) => {
        gone.push(...children)
        return Promise.resolve()
      },
    },
  )
  return { gone, index }
}

async function relist(accessor: GitHubAccessor, index: IndexView): Promise<void> {
  await keepListing(index, '/gh', await readdir(accessor, root('/gh')))
}

describe('a relisting reports what left the repository', () => {
  // The seeds replace each folder's listing, so without the diff a file
  // removed upstream keeps its cached bytes and overlay.
  it.each([
    ['a removed file', ['d1/a.txt'], [{ path: '/gh/d1/a.txt', folder: false }]],
    ['a removed folder once', ['d1/a.txt', 'd1/b.txt'], [{ path: '/gh/d1', folder: true }]],
  ])('reports %s', async (_label, removed, reported) => {
    await repo.create({ 'd1/a.txt': 'a', 'd1/b.txt': 'b', 'top.txt': 't' })
    const accessor = repo.accessor()
    const { gone, index } = recording()
    await relist(accessor, index)
    expect(gone).toEqual([])
    await repo.commit(Object.fromEntries(removed.map((path) => [path, null])))
    await relist(accessor, index)
    expect(gone).toEqual(reported)
  })
})

describe('the head commit a tree response names', () => {
  it('versions the listing and every seed with its head', async () => {
    const head = await repo.create({ 'd1/a.txt': 'a', 'd1/sub/b.txt': 'b', 'top.txt': 't' })
    const listing = await readdir(repo.accessor(), root('/gh'))
    expect(listing.version).toBe(head)
    const index = new RAMIndexCacheStore()
    await keepListing(index, '/gh', listing)
    for (const folder of ['/gh', '/gh/d1', '/gh/d1/sub']) {
      expect((await index.listDir(folder)).version).toBe(head)
    }
  })

  // The second is GitHub's tree with its top-level sha left out.
  it.each([
    ['truncated', true],
    ['without a head', false],
  ])('names no version for a listing %s', async (_label, truncated) => {
    await repo.create({ 'd1/a.txt': 'a', 'top.txt': 't' })
    if (truncated) {
      await repo.truncate()
    } else {
      const whole = await repo.tree('main', true)
      await repo.answer(
        'recursive',
        Object.fromEntries(Object.entries(whole).filter(([key]) => key !== 'sha')),
      )
    }
    const listing = await readdir(repo.accessor(), root('/gh'))
    expect(listing.version).toBeNull()
  })
})

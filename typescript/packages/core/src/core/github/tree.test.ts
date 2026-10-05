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
import { GitHubApiError, type GitHubTransport } from './client.ts'
import { fetchDirTree, fetchTree } from './tree.ts'
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { IndexEntry, type Evicted } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { IndexView } from '../../cache/index/view.ts'
import { ensureLiveSnapshot, pointRow, populateIndex, refillSnapshot } from './tree.ts'
import { FakeGitHub, blobSha, servedAccessor } from './_test_util.ts'

const ITEMS = [
  { path: 'extern', mode: '160000', type: 'commit', sha: 'ccc' },
  { path: 'main.py', mode: '100644', type: 'blob', sha: 'bbb', size: 7 },
  { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
]

function transport(): GitHubTransport {
  return {
    get: () => Promise.resolve({ tree: ITEMS, truncated: false }),
  } as unknown as GitHubTransport
}

describe('github tree fetch', () => {
  it('excludes submodule gitlinks from the recursive tree', async () => {
    const { tree, truncated } = await fetchTree(transport(), 'acme', 'proj', 'main')
    expect(truncated).toBe(false)
    expect(tree.map((e) => e.path)).toEqual(['main.py', 'src'])
  })

  it('excludes submodule gitlinks from per-directory trees', async () => {
    const entries = await fetchDirTree(transport(), 'acme', 'proj', 'sha1')
    expect(entries.map((e) => e.path)).toEqual(['main.py', 'src'])
  })
})

describe('ensureLiveSnapshot', () => {
  const TREE = {
    data: { path: 'data', type: 'tree', sha: 't1', size: null },
    'data/keep.txt': { path: 'data/keep.txt', type: 'blob', sha: 'b1', size: 4 },
  }

  function accessor(calls: { n: number }): GitHubAccessor {
    return new GitHubAccessor({
      transport: {
        get: () => {
          calls.n += 1
          return Promise.resolve({
            tree: [
              { path: 'data', type: 'tree' as const, sha: 't1' },
              { path: 'data/keep.txt', type: 'blob' as const, sha: 'b1', size: 4 },
            ],
            truncated: false,
          })
        },
      } as unknown as GitHubTransport,
      owner: 'acme',
      repo: 'proj',
      ref: 'main',
      defaultBranch: 'main',
      tree: TREE,
    })
  }

  it('refetches rather than reuse the build-time tree', async () => {
    // The build tree is only true at build time: a mount's first read can
    // come long after it, so reusing it would key an index built from a
    // repository several external writes ago.
    const calls = { n: 0 }
    const index = new RAMIndexCacheStore({ ttl: 600 })
    expect(await ensureLiveSnapshot(accessor(calls), index, '/gh')).not.toBeNull()
    expect(calls.n).toBe(1)
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('refetches a dropped listing', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await ensureLiveSnapshot(acc, index, '/gh')
    // What invalidation does: drop the row rather than expire it, which is
    // why the readers' EXPIRED probe never fires.
    await index.invalidateDir('/gh')
    await index.invalidateDir('/gh/data')
    expect(await ensureLiveSnapshot(acc, index, '/gh')).not.toBeNull()
    expect(calls.n).toBe(2)
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('refetches an expired root listing', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await ensureLiveSnapshot(acc, index, '/gh')
    await index.invalidate()
    expect(await ensureLiveSnapshot(acc, index, '/gh')).not.toBeNull()
    expect(calls.n).toBe(2)
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('reports no refill, and sends no request, without an index', async () => {
    const calls = { n: 0 }
    expect(await refillSnapshot(accessor(calls), undefined, '/gh')).toBeNull()
    expect(calls.n).toBe(0)
  })

  it('leaves a live index alone and sends no request', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await ensureLiveSnapshot(acc, index, '/gh')
    const before = calls.n
    expect(await ensureLiveSnapshot(acc, index, '/gh')).toBeNull()
    expect(calls.n).toBe(before)
  })

  it('skips a truncated tree', async () => {
    const calls = { n: 0 }
    const acc = accessor(calls)
    acc.truncated = true
    expect(await ensureLiveSnapshot(acc, new RAMIndexCacheStore({ ttl: 600 }), '/gh')).toBeNull()
    expect(calls.n).toBe(0)
  })

  it('skips a missing index', async () => {
    expect(await ensureLiveSnapshot(accessor({ n: 0 }), undefined, '')).toBeNull()
  })
})

describe('populateIndex', () => {
  const TREE = {
    data: { path: 'data', type: 'tree', sha: 't1', size: null },
    'data/keep.txt': { path: 'data/keep.txt', type: 'blob', sha: 'b1', size: 4 },
  }

  it('keys by mount-absolute path', async () => {
    // Every other backend keys its index this way, which is what lets the
    // shared CacheManager spell an eviction without knowing the backend.
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, TREE, '/gh')
    expect((await index.listDir('/gh')).entries).toEqual(['/gh/data'])
    expect((await index.listDir('/gh/data')).entries).toEqual(['/gh/data/keep.txt'])
  })

  it('keeps bare paths on a root mount', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, TREE, '')
    expect((await index.listDir('/')).entries).toEqual(['/data'])
  })

  it('gives an empty repo a root row', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await populateIndex(index, {}, '/gh')
    expect((await index.listDir('/gh')).entries).toEqual([])
  })

  // A truncated tree names only some children, so writing it must not evict
  // the rest of a folder a per-directory fallback listed in full.
  it('keeps rows a truncated tree does not name', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await index.setDir('/gh/data', [
      ['keep.txt', new IndexEntry({ id: 'b1', name: 'keep.txt', resourceType: 'file' })],
      ['other.txt', new IndexEntry({ id: 'b2', name: 'other.txt', resourceType: 'file' })],
    ])
    await populateIndex(index, TREE, '/gh', new Date(0))
    expect((await index.get('/gh/data/other.txt')).entry?.id).toBe('b2')
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
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const [ref, parent] of ENCODED) {
    it(`sends ${ref}:${parent} as one segment`, async () => {
      const gh = new FakeGitHub({ [`${parent}/f.txt`]: 'payload', 'src/decoy.txt': 'decoy' })
      gh.ref = ref
      const seen: string[] = []
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init).url)
        return gh.fetch(input, init)
      })
      const found = await pointRow(servedAccessor(ref), `${parent}/f.txt`)
      expect(found?.entry?.sha).toBe(await blobSha('payload'))
      expect(seen).toHaveLength(1)
      const segment = (seen[0] ?? '').split('/git/trees/')[1] ?? ''
      expect(segment).not.toContain('/')
      expect(decodeURIComponent(segment)).toBe(`${ref}:${parent}`)
      if (parent === 'src')
        expect(seen[0]).toBe('http://github.test/repos/o/r/git/trees/main%3Asrc')
    })
  }

  it('asks a root child through the ref itself', async () => {
    const gh = new FakeGitHub({ 'a.txt': 'a' })
    vi.stubGlobal('fetch', gh.fetch)
    expect((await pointRow(servedAccessor(), 'a.txt'))?.entry).not.toBeNull()
    expect(gh.log).toEqual([['dir', 'main']])
  })

  it('answers each kind of listing', async () => {
    const gh = new FakeGitHub({ 'docs/a.txt': 'alpha', 'docs/b.txt': 'bravo' })
    vi.stubGlobal('fetch', gh.fetch)
    const accessor = servedAccessor()
    const found = await pointRow(accessor, 'docs/a.txt')
    expect([found?.entry?.sha, found?.truncated]).toEqual([await blobSha('alpha'), false])
    expect(await pointRow(accessor, 'docs/nope.txt')).toEqual({ entry: null, truncated: false })
    gh.truncatedDirs.set('docs', 1)
    expect(await pointRow(accessor, 'docs/b.txt')).toEqual({ entry: null, truncated: true })
    gh.truncatedDirs.clear()
    // A missing directory, a deleted ref and a path through a file all
    // defer to the tree rather than answering absent.
    expect(await pointRow(accessor, 'gone/a.txt')).toBeNull()
    expect(await pointRow(accessor, 'docs/a.txt/x')).toBeNull()
    expect(await pointRow(servedAccessor('deleted'), 'docs/a.txt')).toBeNull()
    for (const status of [401, 403]) {
      gh.fail.set('dir', [status, 'refused'])
      const err = await pointRow(accessor, 'docs/a.txt').catch((e: unknown) => e)
      expect((err as GitHubApiError).status).toBe(status)
    }
    gh.fail.set('dir', [404, 'Not Found'])
    expect(await pointRow(accessor, 'docs/a.txt')).toBeNull()
  })

  // Octokit's retry plugin retries these statuses with a multi-second
  // backoff, so they are raised by a transport rather than served.
  for (const status of [409, 429, 500]) {
    it(`raises ${String(status)} rather than deferring`, async () => {
      const transport = {
        get: () => Promise.reject(new GitHubApiError('refused', status)),
        request: () => Promise.reject(new Error('unused')),
      } as unknown as GitHubTransport
      const accessor = new GitHubAccessor({
        transport,
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
    const transport = {
      get: () => Promise.resolve({ message: 'something else' }),
      request: () => Promise.reject(new Error('unused')),
    } as unknown as GitHubTransport
    const accessor = new GitHubAccessor({
      transport,
      owner: 'o',
      repo: 'r',
      ref: 'main',
      defaultBranch: 'main',
    })
    const err = await pointRow(accessor, 'docs/a.txt').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(0)
    expect((err as GitHubApiError).message).toContain('carries no tree')
  })
})

function ledgered(): { gone: Evicted[]; index: IndexView } {
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

describe('refillSnapshot reports what left the repository', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The refill wipes the index before seeding the new tree, so without the
  // diff a file removed upstream keeps its cached bytes and overlay.
  it.each([
    ['a removed file', ['d1/a.txt'], [{ path: '/gh/d1/a.txt', folder: false }]],
    ['a removed folder once', ['d1/a.txt', 'd1/b.txt'], [{ path: '/gh/d1', folder: true }]],
  ])('reports %s', async (_label, removed, reported) => {
    const gh = new FakeGitHub({ 'd1/a.txt': 'a', 'd1/b.txt': 'b', 'top.txt': 't' })
    vi.stubGlobal('fetch', gh.fetch)
    const accessor = servedAccessor()
    const { gone, index } = ledgered()
    await refillSnapshot(accessor, index, '/gh')
    for (const path of removed) gh.files.delete(path)
    await refillSnapshot(accessor, index, '/gh')
    expect(gone).toEqual(reported)
  })

  // A truncated tree names only some paths, so a path missing from it is
  // not a path the repository lost.
  it.each([
    [true, false],
    [false, true],
  ])('reports nothing when truncated before=%s after=%s', async (before, after) => {
    const gh = new FakeGitHub({ 'd1/a.txt': 'a', 'top.txt': 't' })
    gh.truncatedRecursive = before
    vi.stubGlobal('fetch', gh.fetch)
    const accessor = servedAccessor()
    const { gone, index } = ledgered()
    await refillSnapshot(accessor, index, '/gh')
    gh.truncatedRecursive = after
    gh.files.delete('d1/a.txt')
    await refillSnapshot(accessor, index, '/gh')
    expect(gone).toEqual([])
  })

  it('reports nothing on the first refill', async () => {
    const gh = new FakeGitHub({ 'top.txt': 't' })
    vi.stubGlobal('fetch', gh.fetch)
    const { gone, index } = ledgered()
    await refillSnapshot(servedAccessor(), index, '/gh')
    expect(gone).toEqual([])
  })
})

describe('the head commit a tree response names', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stamps every folder of a refill with its head', async () => {
    const gh = new FakeGitHub({ 'd1/a.txt': 'a', 'd1/sub/b.txt': 'b', 'top.txt': 't' })
    vi.stubGlobal('fetch', gh.fetch)
    const accessor = servedAccessor()
    const index = new RAMIndexCacheStore()
    const snapshot = await refillSnapshot(accessor, index, '/gh')
    const head = await gh.head()
    expect(snapshot?.version).toBe(head)
    expect(accessor.treeVersion).toBe(head)
    for (const folder of ['/gh', '/gh/d1', '/gh/d1/sub']) {
      expect((await index.listDir(folder)).version).toBe(head)
    }
  })

  it.each([
    ['truncated', true, false],
    ['without a head', false, true],
  ])('stores no version for a refill %s', async (_label, truncated, dropSha) => {
    const gh = new FakeGitHub({ 'd1/a.txt': 'a', 'top.txt': 't' })
    gh.truncatedRecursive = truncated
    gh.dropSha = dropSha
    vi.stubGlobal('fetch', gh.fetch)
    const accessor = servedAccessor()
    const index = new RAMIndexCacheStore()
    const snapshot = await refillSnapshot(accessor, index, '/gh')
    expect(snapshot?.version ?? null).toBeNull()
    expect(accessor.treeVersion).toBeNull()
    expect((await index.listDir('/gh')).version ?? null).toBeNull()
  })
})

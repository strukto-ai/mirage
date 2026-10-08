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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RAMFileCacheStore } from '@struktoai/mirage-core/cache/file/ram'
import type { Evicted } from '@struktoai/mirage-core/cache/index/config'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { IndexView } from '@struktoai/mirage-core/cache/index/view'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { HfHubError } from './client.ts'
import {
  collect,
  deletionsFor,
  filterRepoPaths,
  refillSnapshot,
  fetchPath,
  fetchTree,
  indexRows,
  nextCursor,
  parseEntry,
  pathsInfoUrl,
  treeUrl,
} from './tree.ts'
import * as client from './client.ts'
import * as repo from './repo.ts'
import type { TreeEntry } from './tree_entry.ts'

// Every accessor here points at the real Hub, so the head a refill asks for
// before its walk is answered locally: '' by default, which walks the branch
// and stores no version, the way a mocked tree page alone used to behave.
beforeEach(() => {
  vi.spyOn(repo, 'headCommit').mockResolvedValue('')
})

function accessor(config: Record<string, unknown> = {}): HfHubAccessor {
  return new HfHubAccessor({ repoId: 'acme/widget', ...config } as never)
}

function fileRow(path: string, size = 10, extra: Record<string, unknown> = {}) {
  return { type: 'file', oid: `oid-${path}`, size, path, ...extra }
}

function dirRow(path: string) {
  return { type: 'directory', oid: `tree-${path}`, size: 0, path }
}

function page(rows: unknown[], next = '') {
  return {
    data: rows,
    status: 200,
    headers: next === '' ? {} : { link: `<${next}>; rel="next"` },
  }
}

describe('parseEntry', () => {
  it('keeps the LFS content size, not the pointer size', () => {
    // An LFS row carries both: `size` is the real content length and
    // `lfs.pointerSize` is the 135-byte stub git actually stores. Reporting
    // the stub makes wc -c and ls -l lie and risks a truncated copy.
    const entry = parseEntry({
      type: 'file',
      oid: 'abc',
      size: 4798702184,
      path: 'model.safetensors',
      lfs: { oid: 'sha256hex', size: 4798702184, pointerSize: 135 },
      xetHash: 'xethash',
    })
    expect(entry.size).toBe(4798702184)
    expect(entry.lfsOid).toBe('sha256hex')
    expect(entry.xetHash).toBe('xethash')
  })

  it('reads the last commit when expanded', () => {
    const entry = parseEntry({
      type: 'file',
      oid: 'abc',
      size: 1,
      path: 'f',
      lastCommit: { id: 'c1', date: '2025-01-01T00:00:00.000Z' },
    })
    expect(entry.lastModified).toBe('2025-01-01T00:00:00.000Z')
    expect(entry.lastCommit).toBe('c1')
  })

  it('leaves mtime empty without expansion', () => {
    expect(parseEntry(fileRow('f')).lastModified).toBe('')
  })
})

describe('nextCursor', () => {
  it('reads the link header', () => {
    expect(nextCursor({ link: '<https://h/next>; rel="next"' })).toBe('https://h/next')
  })

  it('is empty on the last page', () => {
    expect(nextCursor({})).toBe('')
    expect(nextCursor({ link: '<https://h/prev>; rel="prev"' })).toBe('')
  })
})

describe('treeUrl', () => {
  it('appends the key prefix without its trailing slash', () => {
    expect(treeUrl(accessor())).toContain('/api/models/acme/widget/tree/main')
    const prefixed = accessor({ keyPrefix: 'sub/dir/' })
    expect(prefixed.keyPrefix).toBe('sub/dir/')
    expect(treeUrl(prefixed)).toContain('/tree/main/sub/dir')
  })

  it('takes the revision it is given', () => {
    const head = 'c'.repeat(40)
    expect(treeUrl(accessor(), head)).toMatch(new RegExp(`/tree/${head}$`))
    expect(treeUrl(accessor())).toMatch(/\/tree\/main$/)
    expect(treeUrl(accessor({ keyPrefix: 'sub/dir/' }), head)).toMatch(
      new RegExp(`/tree/${head}/sub/dir$`),
    )
  })

  it('encodes a revision holding a slash', () => {
    // Unencoded, `feature/foo` names revision `feature` and subtree `foo`,
    // so the mount reads the wrong location or appears empty.
    expect(treeUrl(accessor({ revision: 'feature/foo' }))).toContain('/tree/feature%2Ffoo')
  })
})

describe('collect', () => {
  it('strips the key prefix', () => {
    const into = new Map<string, TreeEntry>()
    collect([fileRow('sub/dir/a.txt')], 'sub/dir/', into)
    expect([...into.keys()]).toEqual(['a.txt'])
  })

  it('drops the row naming the prefix itself', () => {
    // `kp.strip` cannot drop it: the prefix carries a trailing slash, so the
    // bare directory path does not start with it and comes back unchanged.
    const into = new Map<string, TreeEntry>()
    collect([dirRow('sub/dir'), fileRow('sub/dir/a.txt')], 'sub/dir/', into)
    expect([...into.keys()]).toEqual(['a.txt'])
  })
})

describe('fetchTree', () => {
  it('keeps one expanded page when the repo fits in it', async () => {
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValue(
        page([{ ...fileRow('a.txt'), lastCommit: { id: 'c', date: '2025-01-01T00:00:00.000Z' } }]),
      )
    const tree = await fetchTree(accessor())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[2]?.expand).toBe('true')
    expect(tree.get('a.txt')?.lastModified).toBe('2025-01-01T00:00:00.000Z')
    spy.mockRestore()
  })

  it('falls back to a bare walk when it does not fit', async () => {
    // Expansion drops the page from 1000 rows to 50, so a repo too big for one
    // expanded page re-walks bare rather than paying twenty times the requests.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValueOnce(page([fileRow('a.txt')], 'https://h/p2'))
      .mockResolvedValueOnce(page([fileRow('a.txt'), fileRow('b.txt')]))
    const tree = await fetchTree(accessor())
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1]?.[2]?.expand).toBe('false')
    expect([...tree.keys()].sort()).toEqual(['a.txt', 'b.txt'])
    spy.mockRestore()
  })

  it('forced expansion pages through the cursor', async () => {
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValueOnce(page([fileRow('a.txt')], 'https://h/p2'))
      .mockResolvedValueOnce(page([fileRow('b.txt')]))
    const tree = await fetchTree(accessor({ expandCommits: true }))
    expect(spy.mock.calls[1]?.[1]).toBe('https://h/p2')
    // The cursor URL carries the whole query already.
    expect(spy.mock.calls[1]?.[2]).toBeUndefined()
    expect([...tree.keys()].sort()).toEqual(['a.txt', 'b.txt'])
    spy.mockRestore()
  })

  it('forced bare never expands', async () => {
    const spy = vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page([fileRow('a.txt')]))
    await fetchTree(accessor({ expandCommits: false }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[2]?.expand).toBe('false')
    spy.mockRestore()
  })

  it('reads a missing subtree as empty', async () => {
    // A key_prefix that names no folder: the Hub answers 404 EntryNotFound,
    // and there really is nothing under it (measured against huggingface.co,
    // 2026-09-24).
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockRejectedValue(new HfHubError('nope', 404, 'EntryNotFound'))
    expect((await fetchTree(accessor())).size).toBe(0)
    spy.mockRestore()
  })

  it.each([
    [401, ''],
    [403, ''],
    [404, 'RevisionNotFound'],
    [404, 'RepoNotFound'],
  ])('raises %i %s for a repo it cannot see', async (status, code) => {
    // The tree is seeded as the whole index, so an empty one for a repo the
    // token cannot see would read every file as deleted; an error does not.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockRejectedValue(new HfHubError('nope', status, code))
    await expect(fetchTree(accessor())).rejects.toBeInstanceOf(HfHubError)
    spy.mockRestore()
  })

  it('raises for a missing subtree on a later page', async () => {
    // Folding here would keep page one as if it were the whole listing.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValueOnce(page([fileRow('a.txt')], 'https://h/p2'))
      .mockRejectedValueOnce(new HfHubError('gone', 404, 'EntryNotFound'))
    await expect(fetchTree(accessor({ expandCommits: false }))).rejects.toBeInstanceOf(HfHubError)
    spy.mockRestore()
  })

  it('raises for a missing subtree on the continuation', async () => {
    // The expanded walk continues in a second walkPages call, whose first
    // request is already a cursor page; "first page" is the request that
    // carries the first page's params, not the first turn of a loop.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValueOnce(page([fileRow('a.txt')], 'https://h/p2'))
      .mockRejectedValueOnce(new HfHubError('gone', 404, 'EntryNotFound'))
    await expect(fetchTree(accessor({ expandCommits: true }))).rejects.toBeInstanceOf(HfHubError)
    spy.mockRestore()
  })

  it('folds a missing subtree on the bare restart', async () => {
    // The bare walk restarts from the first page with fresh params and an
    // empty result, so a subtree gone by then is truthfully empty.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValueOnce(page([fileRow('a.txt')], 'https://h/p2'))
      .mockRejectedValueOnce(new HfHubError('gone', 404, 'EntryNotFound'))
    expect((await fetchTree(accessor())).size).toBe(0)
    spy.mockRestore()
  })

  it('rethrows a real failure', async () => {
    const spy = vi.spyOn(client, 'hubGetResponse').mockRejectedValue(new HfHubError('boom', 500))
    await expect(fetchTree(accessor())).rejects.toThrow('boom')
    spy.mockRestore()
  })
})

describe('indexRows', () => {
  it('gives the root a listing for an empty repo', () => {
    // Without it an empty repository is byte for byte a dropped index.
    const { entries, children } = indexRows(new Map(), '')
    expect(entries.size).toBe(0)
    expect(children.get('/')).toEqual([])
  })

  it('keys mount-absolute under a prefix', () => {
    const tree = new Map([['a.txt', parseEntry(fileRow('a.txt', 7))]])
    const { entries, children } = indexRows(tree, '/m')
    expect(entries.get('/m/a.txt')?.size).toBe(7)
    expect(children.get('/m')).toEqual(['/m/a.txt'])
  })

  // The implied folder gets a row of its own and a place in its parent's
  // listing, so every listed path has an entry: a versioned listing on Redis
  // reads EXPIRED when one of its children has none.
  it('implies a parent a page boundary split off', () => {
    const tree = new Map([['d/e/a.txt', parseEntry(fileRow('d/e/a.txt'))]])
    const { entries, children } = indexRows(tree, '/m')
    expect(children.get('/m/d/e')).toEqual(['/m/d/e/a.txt'])
    expect(children.get('/m/d')).toEqual(['/m/d/e'])
    expect(children.get('/m')).toEqual(['/m/d'])
    for (const key of ['/m/d', '/m/d/e']) {
      expect(entries.get(key)?.resourceType).toBe('folder')
      expect(entries.get(key)?.name).toBe(key.slice(key.lastIndexOf('/') + 1))
    }
    expect(new Set(entries.keys())).toEqual(new Set([...children.values()].flat()))
  })

  it('leaves a directory size unset', () => {
    const tree = new Map([['d', parseEntry(dirRow('d'))]])
    const { entries } = indexRows(tree, '')
    expect(entries.get('/d')?.size).toBeNull()
    expect(entries.get('/d')?.resourceType).toBe('folder')
  })
})

describe('fetchTree page ceiling', () => {
  it('refuses a listing it could not finish', async () => {
    // The listing is seeded as the mount's whole index, so a partial one
    // reads as complete and every file past the ceiling becomes a
    // confident false absence.
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValue(page([fileRow('a.txt')], 'https://h/next'))
    await expect(fetchTree(accessor())).rejects.toThrow(/listing exceeds/)
    spy.mockRestore()
  })
})

describe('pathsInfoUrl', () => {
  it.each([
    ['model', 'models'],
    ['dataset', 'datasets'],
    ['space', 'spaces'],
  ])('names the %s repo type', (kind, segment) => {
    const acc = new HfHubAccessor({ repoId: 'acme/widget' } as never, kind)
    expect(pathsInfoUrl(acc)).toBe(
      `https://huggingface.co/api/${segment}/acme/widget/paths-info/main`,
    )
  })

  it('encodes a revision and carries no prefix', () => {
    // The prefix belongs in the requested path, not the route: the route's
    // trailing segment is the whole revision.
    const acc = accessor({ revision: 'refs/pr/1', keyPrefix: 'sub/dir' })
    expect(pathsInfoUrl(acc)).toBe(
      'https://huggingface.co/api/models/acme/widget/paths-info/refs%2Fpr%2F1',
    )
  })
})

describe('fetchPath', () => {
  it('refuses an answer that is not a list', async () => {
    // Only an empty list says the path is missing; any other shape is an
    // answer the client cannot read, and must not become absence.
    const spy = vi.spyOn(client, 'hubPost').mockResolvedValue({ error: 'unexpected' })
    await expect(fetchPath(accessor(), 'a.txt')).rejects.toBeInstanceOf(client.HfHubError)
    spy.mockRestore()
  })

  it('reads an empty list as absence', async () => {
    const spy = vi.spyOn(client, 'hubPost').mockResolvedValue([])
    expect((await fetchPath(accessor(), 'a.txt')).size).toBe(0)
    spy.mockRestore()
  })

  it('asks for the prefixed path', async () => {
    const spy = vi.spyOn(client, 'hubPost').mockResolvedValue([
      { ...fileRow('a.txt'), oid: 'decoy' },
      { ...fileRow('sub/dir/a.txt'), oid: 'real' },
    ])
    const found = await fetchPath(accessor({ keyPrefix: 'sub/dir' }), 'a.txt')
    expect((spy.mock.calls[0]?.[2] as { paths: string[] }).paths).toEqual(['sub/dir/a.txt'])
    expect([...found.keys()]).toEqual(['a.txt'])
    expect(found.get('a.txt')?.oid).toBe('real')
    spy.mockRestore()
  })

  it.each([
    [true, true],
    [undefined, false],
    [false, false],
  ])('expands only when asked (%s)', async (expand, sent) => {
    const spy = vi.spyOn(client, 'hubPost').mockResolvedValue([])
    await fetchPath(accessor({ expandCommits: expand }), 'a.txt')
    expect((spy.mock.calls[0]?.[2] as { expand: boolean }).expand).toBe(sent)
    spy.mockRestore()
  })
})

it('returns the snapshot it wrote if another refill replaces the accessor tree', async () => {
  const acc = accessor()
  const index = new RAMIndexCacheStore()
  const write = index.setDir.bind(index)
  vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page([fileRow('a.txt')]))
  vi.spyOn(index, 'setDir').mockImplementation(async (...args) => {
    const gone = await write(...args)
    acc.tree = new Map([['other.txt', parseEntry(fileRow('other.txt'))]])
    return gone
  })
  try {
    const snapshot = await refillSnapshot(acc, index, '/m')
    expect(snapshot.children.get('/m')).toEqual(['/m/a.txt'])
    expect(snapshot.entries.get('/m/a.txt')?.id).toBe('oid-a.txt')
    expect((await index.listDir('/m')).entries).toEqual(['/m/a.txt'])
  } finally {
    vi.restoreAllMocks()
  }
})

function treeOf(...rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
}

describe('refillSnapshot reports what left the repository', () => {
  // The refill wipes the index before seeding the new tree, so without the
  // diff a file removed upstream keeps its cached bytes and overlay.
  it.each([
    [
      'a removed file',
      treeOf(fileRow('d/b.txt'), dirRow('d')),
      [{ path: '/m/a.txt', folder: false }],
    ],
    ['a removed folder once', treeOf(fileRow('a.txt')), [{ path: '/m/d', folder: true }]],
  ])('reports %s', async (_label, after, reported) => {
    const gone: Evicted[] = []
    const index = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/m',
      () => true,
      {
        onGone: (children) => {
          gone.push(...children)
          return Promise.resolve()
        },
      },
    )
    const acc = accessor()
    const spy = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValue(page([fileRow('a.txt'), fileRow('d/b.txt'), dirRow('d')]))
    try {
      await refillSnapshot(acc, index, '/m')
      expect(gone).toEqual([])
      spy.mockResolvedValue(page(after))
      await refillSnapshot(acc, index, '/m')
      expect(gone).toEqual(reported)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

// The watcher sets accessor.tree with no lock, so a walk at an older head can
// land while the refill awaits its invalidation. The refill seeds the tree it
// fetched itself, stamped with the head it walked at, never the accessor's
// tree re-read after an await.
it('seeds its own tree when the watcher swaps the accessor tree', async () => {
  const acc = accessor()
  const index = new RAMIndexCacheStore()
  const invalidate = index.invalidatePrefix.bind(index)
  vi.spyOn(repo, 'headCommit').mockResolvedValue('c'.repeat(40))
  vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page([fileRow('new.txt')]))
  vi.spyOn(index, 'invalidatePrefix').mockImplementation(async (...args) => {
    acc.tree = new Map([['old.txt', parseEntry(fileRow('old.txt'))]])
    await invalidate(...args)
  })
  try {
    const snapshot = await refillSnapshot(acc, index, '/m')
    const listing = await index.listDir('/m')
    expect(listing.entries).toEqual(['/m/new.txt'])
    expect(listing.version).toBe('c'.repeat(40))
    expect((await index.get('/m/new.txt')).entry?.id).toBe('oid-new.txt')
    expect((await index.get('/m/old.txt')).entry ?? null).toBeNull()
    expect(snapshot.children.get('/m')).toEqual(['/m/new.txt'])
  } finally {
    vi.restoreAllMocks()
  }
})

const HEAD = 'c'.repeat(40)

describe('refillSnapshot at the head', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The refill walks the tree at the commit the head named, passed to the walk
  // rather than written to the accessor, and stamps every folder with it.
  it('walks and stamps the head it resolved', async () => {
    vi.spyOn(repo, 'headCommit').mockResolvedValue(HEAD)
    const get = vi
      .spyOn(client, 'hubGetResponse')
      .mockResolvedValue(page([fileRow('a.txt'), fileRow('d/b.txt'), dirRow('d')]))
    const acc = accessor()
    const index = new RAMIndexCacheStore()
    await refillSnapshot(acc, index, '/m')
    expect(String(get.mock.calls[0]?.[1])).toMatch(new RegExp(`/tree/${HEAD}$`))
    expect(acc.revision).toBe('main')
    expect((await index.listDir('/m')).version).toBe(HEAD)
    expect((await index.listDir('/m/d')).version).toBe(HEAD)
  })

  // A head the Hub names as '' walks the branch and stores no version.
  it('walks the branch unversioned when the Hub names no head', async () => {
    const get = vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page([fileRow('a.txt')]))
    const index = new RAMIndexCacheStore()
    await refillSnapshot(accessor(), index, '/m')
    expect(String(get.mock.calls[0]?.[1])).toMatch(/\/tree\/main$/)
    const listing = await index.listDir('/m')
    expect(listing.entries).toEqual(['/m/a.txt'])
    expect(listing.version ?? null).toBeNull()
  })

  // The head failing is the refill failing: a transient error is not hidden
  // behind a branch walk that would store rows of an unknown commit.
  it('raises when the head fails', async () => {
    vi.spyOn(repo, 'headCommit').mockRejectedValue(new HfHubError('boom', 500))
    const get = vi.spyOn(client, 'hubGetResponse')
    await expect(refillSnapshot(accessor(), new RAMIndexCacheStore(), '/m')).rejects.toThrow('boom')
    expect(get).not.toHaveBeenCalled()
  })
})

describe('upstream glob patterns', () => {
  // huggingface_hub's filter_repo_objects: fnmatch over the whole path, so
  // `*` crosses `/`, and a trailing `/` names a folder.
  const files = ['.gitattributes', 'a.txt', 'data/b.json', 'data/sub/c.json', 'sub/d.bin']

  it.each([
    [['*.txt'], [], ['a.txt']],
    [['data/*.json'], [], ['data/b.json', 'data/sub/c.json']],
    [['data/'], [], ['data/b.json', 'data/sub/c.json']],
    [['**'], ['*.json'], ['.gitattributes', 'a.txt', 'sub/d.bin']],
    [[], ['sub/'], ['.gitattributes', 'a.txt', 'data/b.json', 'data/sub/c.json']],
  ])('include %j exclude %j keeps %j', (include, exclude, kept) => {
    expect(filterRepoPaths(files, include, exclude)).toEqual(kept)
  })

  it.each([
    [['**'], '', ['a.txt', 'data/b.json', 'data/sub/c.json', 'sub/d.bin']],
    [['*.json'], '', ['data/b.json', 'data/sub/c.json']],
    [['sub/'], '', ['sub/d.bin']],
    [['*.json'], 'data', ['data/b.json', 'data/sub/c.json']],
    [['sub/*'], 'data', ['data/sub/c.json']],
    [['nothing*'], '', []],
    [[], '', []],
  ])('deletes %j under %j as %j', (patterns, base, doomed) => {
    expect(deletionsFor(files, patterns, base)).toEqual(doomed)
  })
})

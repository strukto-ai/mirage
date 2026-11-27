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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAccessor } from '../../accessor/github.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { ContentType, type FileStat, FileType, PathSpec } from '../../types.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { readdir } from './readdir.ts'
import { stat, tree } from './stat.ts'
import { GitHubRepo, TREES, blobSha } from '../../../tests/core/github/repo.ts'

const ROOT = new PathSpec({ vfsPath: '', virtual: '/gh', directory: '/gh' })
const FILES = { 'src/main.py': 'x'.repeat(120), 'README.md': 'y'.repeat(50) }
const THREE = Object.fromEntries(
  ['d1', 'd2', 'd3'].flatMap((d) => ['a', 'b', 'c'].map((n) => [`${d}/${n}.txt`, 'x\n'])),
)

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
  it('answers a file with the row its folder lists', async () => {
    await repo.create(FILES)
    const found = await statAt(repo.accessor(), under('/gh/src/main.py'))
    const sha = blobSha('x'.repeat(120))
    expect([found.name, found.size, found.content, found.fingerprint, found.extra]).toEqual([
      'main.py',
      120,
      ContentType.TEXT,
      sha,
      { sha },
    ])
  })

  it('answers a folder and the root with no fingerprint', async () => {
    await repo.create(FILES)
    const accessor = repo.accessor()
    const found = await statAt(accessor, under('/gh/src'))
    const root = await stat(accessor, ROOT)
    expect([found.name, found.type, found.fingerprint]).toEqual(['src', FileType.DIRECTORY, null])
    expect([root.name, root.type, root.fingerprint]).toEqual(['/', FileType.DIRECTORY, null])
  })

  it('answers ENOENT for a path no listing names', async () => {
    await repo.create(FILES)
    await expect(statAt(repo.accessor(), under('/gh/nonexistent.py'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // A tree the backend refuses is no answer about the path, so the refusal
  // surfaces rather than ENOENT.
  it('propagates a listing failure', async () => {
    await repo.create(FILES)
    await repo.refuse('recursive', 500, 'boom')
    await expect(statAt(repo.accessor(), under('/gh/missing.py'))).rejects.toMatchObject({
      status: 500,
    })
  })
})

describe('the gate check', () => {
  it('asks the parent directory', async () => {
    await repo.create(FILES)
    const accessor = repo.accessor()
    const check = new ListingCheckStore()
    const found = await stat(accessor, under('/gh/src/main.py'), null, check)
    expect(found.fingerprint).toBe(blobSha('x'.repeat(120)))
    await expect(stat(accessor, under('/gh/src/nope.py'), null, check)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await repo.counts()).toEqual([2, 0, 0])
  })

  it('asks the whole tree past a cut listing', async () => {
    await repo.create(FILES)
    await repo.cutShort('src', 0)
    const found = await stat(
      repo.accessor(),
      under('/gh/src/main.py'),
      null,
      new ListingCheckStore(),
    )
    expect(found.size).toBe(120)
    expect(await repo.counts()).toEqual([1, 1, 0])
  })

  // A point lookup that cannot see the parent defers; a truncated tree then
  // walks down from the ref one folder at a time.
  it('walks a truncated tree by its folders', async () => {
    await repo.create({ 'top.txt': 't', 'docs/sub/b.txt': 'b' })
    await repo.truncate()
    const docs = (await repo.tree('main:docs')).sha
    const sub = (await repo.tree('main:docs/sub')).sha
    await repo.run.answerNext(
      'GET',
      TREES,
      404,
      { message: 'Not Found' },
      1,
      repo.treePath('main:docs/sub'),
    )
    const found = await stat(
      repo.accessor(),
      under('/gh/docs/sub/b.txt'),
      null,
      new ListingCheckStore(),
    )
    expect(found.size).toBe(1)
    const asked = (await repo.log()).map(([name, raw]) => `${name} ${decodeURIComponent(raw)}`)
    expect(asked).toEqual([
      'dir main:docs/sub',
      'recursive main',
      'dir main',
      `sha_dir ${docs}`,
      `sha_dir ${sub}`,
    ])
  })
})

describe('the root stat names the head commit', () => {
  // Through any store but the gate's check the root names no version and
  // asks nothing; only the check wants that request.
  it('asks nothing outside a check', async () => {
    const head = await repo.create(THREE)
    const accessor = repo.accessor()
    const found = await stat(accessor, ROOT)
    expect(found.fingerprint).toBeNull()
    expect(await repo.counts()).toEqual([0, 0, 0])
    const checked = await stat(accessor, ROOT, null, new ListingCheckStore())
    expect(checked.fingerprint).toBe(head)
  })

  // A refused head names no version, never falls into a refill, and says why
  // on stderr, the way Python logs it.
  it.each([404, 500])('names no version when the head answers %i', async (status) => {
    await repo.create(THREE)
    await repo.refuse('dir', status, 'refused')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const accessor = repo.accessor()
    const found = await stat(accessor, ROOT, null, new ListingCheckStore())
    expect(found.fingerprint).toBeNull()
    expect(await repo.count('recursive')).toBe(0)
    expect(accessor.tree).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^head of [^/]+\/[^ ]+ not answered: /)
    warn.mockRestore()
  })
})

describe('tree', () => {
  // Mirrors test_tree_answers_each_entry_as_its_listing_does.
  it('answers each entry as its listing does', async () => {
    await repo.create({ 'docs/a.txt': 'alpha', 'docs/sub/b.txt': 'bb', 'top.txt': 't' })
    const accessor = repo.accessor()
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
    await repo.create({ 'docs/a.txt': 'alpha', 'top.txt': 't' })
    const accessor = repo.accessor()
    expect(await tree(accessor, under('/gh/top.txt'))).toBeNull()
    expect(await tree(accessor, under('/gh/nope'))).toBeNull()
    await repo.truncate()
    const walker = repo.accessor()
    expect(await tree(walker, ROOT)).toBeNull()
    expect(await tree(walker, ROOT)).toBeNull()
    expect(await repo.count('recursive')).toBe(1)
  })
})

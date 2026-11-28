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
import { FileType, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DRIVES, FILES, GoogleAccount, UNTIL_CLEARED } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { PARENTS_PER_QUERY, iterTree, listLevel, tree } from './tree.ts'

const DOC_MIME = 'application/vnd.google-apps.document'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/gd' : `/gd/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

/** The folders and shared drive of each level a walk listed at once, since recording started. */
async function levels(): Promise<[string[], string | null][]> {
  return (await account.listings())
    .filter((l) => l.level)
    .map((l): [string[], string | null] => [l.folders, l.drive])
}

/** The page size of each level a walk listed at once, since recording started. */
async function levelSizes(): Promise<number[]> {
  return (await account.listings()).filter((l) => l.level).map((l) => l.pageSize)
}

describe('gdrive iterTree', () => {
  it('walks in name order, a level per query', async () => {
    const sub = await account.folder('sub')
    await account.upload('a.txt', 'aaaa')
    await account.upload('big.bin', 'x'.repeat(2048), sub)
    await account.upload('small.bin', 'x'.repeat(16), sub)
    await account.create('Report', DOC_MIME)
    await account.run.recordRequests()
    const walked: [string, boolean][] = []
    for await (const [rel, , isDir] of iterTree(account.driveAccessor(), scope(), 'root', null)) {
      walked.push([rel, isDir])
    }
    expect(walked).toEqual([
      ['Report.gdoc.json', false],
      ['a.txt', false],
      ['sub', true],
      ['sub/big.bin', false],
      ['sub/small.bin', false],
    ])
    expect(await levels()).toEqual([
      [['root'], null],
      [[sub], null],
    ])
  })
})

describe('gdrive tree', () => {
  it('lists a level per query', async () => {
    const sub = await account.folder('sub')
    const other = await account.folder('other')
    const deep = await account.folder('deep', sub)
    await account.upload('a.txt', 'a')
    await account.upload('b.txt', 'bb', sub)
    const c = await account.upload('c.txt', 'ccc', deep)
    await account.run.recordRequests()
    const found = await tree(account.driveAccessor(), scope())
    expect([...(found?.keys() ?? [])].sort()).toEqual([
      'a.txt',
      'other',
      'sub',
      'sub/b.txt',
      'sub/deep',
      'sub/deep/c.txt',
    ])
    expect(found?.get('sub/deep')?.type).toBe(FileType.DIRECTORY)
    expect(found?.get('sub/deep/c.txt')?.size).toBe(3)
    expect(found?.get('sub/deep/c.txt')?.extra.file_id).toBe(c)
    expect(await levels()).toEqual([
      [[other, sub], null],
      [[deep], null],
    ])
    expect((await account.listings()).filter((l) => !l.level)).toHaveLength(1)
  })

  it('splits a wide level into queries', async () => {
    for (let i = 0; i < PARENTS_PER_QUERY + 5; i++) {
      await account.folder(`d${String(i).padStart(2, '0')}`)
    }
    await account.run.recordRequests()
    const found = await tree(account.driveAccessor(), scope())
    expect(found?.size).toBe(PARENTS_PER_QUERY + 5)
    expect((await levels()).map(([ids]) => ids.length)).toEqual([PARENTS_PER_QUERY, 5])
  })

  it('starts a subfolder tree at its listing', async () => {
    const sub = await account.folder('sub')
    const deep = await account.folder('deep', sub)
    await account.upload('a.txt', 'a')
    await account.upload('c.txt', 'c', deep)
    const accessor = account.driveAccessor()
    const under = scope('sub')
    const found = await tree(accessor, under, await entryAt(readdir, accessor, under))
    expect([...(found?.keys() ?? [])].sort()).toEqual(['deep', 'deep/c.txt'])
  })

  it('raises for a missing folder what its listing raises', async () => {
    await expect(tree(account.driveAccessor(), scope('gone'), null)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('leaves a short root listing to the walk', async () => {
    await account.folder('sub')
    await account.refuse('GET', DRIVES, 403, 'Insufficient scope')
    await account.run.recordRequests()
    expect(await tree(account.driveAccessor(), scope())).toBeNull()
    expect(await levels()).toEqual([])
  })

  it('keeps the last of two rows with one name', async () => {
    const first = await account.folder('twin')
    const second = await account.folder('twin')
    // Drive lists newest first: the second folder, older, is the last row.
    await account.patch(first, { modifiedTime: '2021-01-01T00:00:00Z' })
    await account.patch(second, { modifiedTime: '2020-01-01T00:00:00Z' })
    await account.upload('one.txt', '1', first)
    await account.upload('two.txt', '2', second)
    const found = await tree(account.driveAccessor(), scope())
    expect([...(found?.keys() ?? [])].sort()).toEqual(['twin', 'twin/two.txt'])
    expect(found?.get('twin')?.extra.file_id).toBe(second)
  })
})

describe('gdrive listLevel', () => {
  it('asks a level per shared drive', async () => {
    const mine = await account.folder('mine')
    const drive = await account.sharedDrive('Team')
    const left = await account.folder('left', drive)
    const right = await account.folder('right', drive)
    const lone = await account.upload('x.txt', 'x', left)
    await account.upload('y.txt', 'y', right)
    await account.run.recordRequests()
    const children = await listLevel(account.driveAccessor(), [
      [mine, null],
      [left, drive],
      [right, drive],
    ])
    expect(await levels()).toEqual([
      [[mine], null],
      [[left, right], drive],
    ])
    expect(children.get(mine)).toEqual([])
    expect(children.get(left)?.map((item) => item.id)).toEqual([lone])
    expect(children.get(right)?.map((item) => item.name)).toEqual(['y.txt'])
  })
})

describe('gdrive tree failures', () => {
  it('leaves a level that fails to the walk', async () => {
    await account.folder('sub')
    // A walk that answers learns the query the level is asked with, so the
    // connection dropped is that level's and no other listing's.
    await account.run.recordRequests()
    expect(await tree(account.driveAccessor(), scope())).not.toBeNull()
    const level = (await account.listings()).find((l) => l.level)
    if (level === undefined) throw new Error('no level was listed')
    await account.run.answerNext(
      'GET',
      FILES,
      null,
      undefined,
      UNTIL_CLEARED,
      undefined,
      level.query,
    )
    expect(await tree(account.driveAccessor(new ManualClock()), scope())).toBeNull()
  })
})

// Twin of test_a_level_is_paged_no_further_than_a_walks_limit.
it('pages a level no further than a walk limit', async () => {
  const sub = await account.folder('sub')
  for (let i = 0; i < 5; i++) await account.upload(`f${String(i)}.txt`, 'x', sub)
  await account.run.recordRequests()
  expect(await tree(account.driveAccessor(), scope(), null, 3)).toBeNull()
  expect(await levelSizes()).toEqual([3])
})

// Twin of test_a_level_asks_no_query_past_a_walks_limit.
it('asks no query of a level past a walk limit', async () => {
  for (let i = 0; i < PARENTS_PER_QUERY + 1; i++) {
    const folder = await account.folder(`d${String(i).padStart(2, '0')}`)
    await account.upload('f.txt', 'x', folder)
  }
  await account.run.recordRequests()
  expect(await tree(account.driveAccessor(), scope(), null, PARENTS_PER_QUERY + 10)).toBeNull()
  expect(await levelSizes()).toEqual([10])
})

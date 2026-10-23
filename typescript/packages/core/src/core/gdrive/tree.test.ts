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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { FileType, PathSpec } from '../../types.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import {
  DOC_MIME,
  FakeDrive,
  driveError,
  makeGDriveAccessor,
} from '../../../tests/core/gdrive/_test_util.ts'
import { readdir } from './readdir.ts'
import { PARENTS_PER_QUERY, iterTree, listLevel, tree } from './tree.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ENC = new TextEncoder()
let fake: FakeDrive
let accessor: GDriveAccessor

beforeEach(() => {
  fake = new FakeDrive()
  accessor = makeGDriveAccessor(fake)
})

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/gd' : `/gd/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

describe('gdrive iterTree', () => {
  it('walks in name order, a level per query', async () => {
    const sub = fake.folder('sub')
    fake.add('a.txt', 'root', undefined, ENC.encode('aaaa'))
    fake.add('big.bin', sub, undefined, ENC.encode('x'.repeat(2048)))
    fake.add('small.bin', sub, undefined, ENC.encode('x'.repeat(16)))
    fake.add('Report', 'root', DOC_MIME)
    const walked: [string, boolean][] = []
    for await (const [rel, , isDir] of iterTree(accessor, scope(), 'root', null)) {
      walked.push([rel, isDir])
    }
    expect(walked).toEqual([
      ['Report.gdoc.json', false],
      ['a.txt', false],
      ['sub', true],
      ['sub/big.bin', false],
      ['sub/small.bin', false],
    ])
    expect(fake.childQueries).toEqual([
      [['root'], null],
      [[sub], null],
    ])
  })
})

describe('gdrive tree', () => {
  it('lists a level per query', async () => {
    const sub = fake.folder('sub')
    const other = fake.folder('other')
    const deep = fake.folder('deep', sub)
    fake.add('a.txt', 'root', undefined, ENC.encode('a'))
    fake.add('b.txt', sub, undefined, ENC.encode('bb'))
    const c = fake.add('c.txt', deep, undefined, ENC.encode('ccc'))
    const found = await tree(accessor, scope())
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
    expect(fake.childQueries).toEqual([
      [[other, sub], null],
      [[deep], null],
    ])
    expect(fake.listLimits).toHaveLength(1)
  })

  it('splits a wide level into queries', async () => {
    for (let i = 0; i < PARENTS_PER_QUERY + 5; i++) fake.folder(`d${String(i).padStart(2, '0')}`)
    const found = await tree(accessor, scope())
    expect(found?.size).toBe(PARENTS_PER_QUERY + 5)
    expect(fake.childQueries.map(([ids]) => ids.length)).toEqual([PARENTS_PER_QUERY, 5])
  })

  it('starts a subfolder tree at its listing', async () => {
    const sub = fake.folder('sub')
    const deep = fake.folder('deep', sub)
    fake.add('a.txt')
    fake.add('c.txt', deep)
    const under = scope('sub')
    const found = await tree(accessor, under, await entryAt(readdir, accessor, under))
    expect([...(found?.keys() ?? [])].sort()).toEqual(['deep', 'deep/c.txt'])
  })

  it('raises for a missing folder what its listing raises', async () => {
    await expect(tree(accessor, scope('gone'), null)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a short root listing to the walk', async () => {
    fake.folder('sub')
    vi.spyOn(fake, 'listSharedDrives').mockRejectedValue(driveError(403, 'Insufficient scope'))
    expect(await tree(accessor, scope())).toBeNull()
    expect(fake.childQueries).toEqual([])
  })

  it('keeps the last of two rows with one name', async () => {
    const first = fake.folder('twin')
    const second = fake.folder('twin')
    fake.add('one.txt', first)
    fake.add('two.txt', second)
    const found = await tree(accessor, scope())
    expect([...(found?.keys() ?? [])].sort()).toEqual(['twin', 'twin/two.txt'])
    expect(found?.get('twin')?.extra.file_id).toBe(second)
  })
})

describe('gdrive listLevel', () => {
  it('asks a level per shared drive', async () => {
    const mine = fake.folder('mine')
    const left = fake.add('left', 'drive-1', FOLDER_MIME, undefined, 'drive-1')
    const right = fake.add('right', 'drive-1', FOLDER_MIME, undefined, 'drive-1')
    const lone = fake.add('x.txt', left, undefined, undefined, 'drive-1')
    fake.add('y.txt', right, undefined, undefined, 'drive-1')
    const children = await listLevel(accessor, [
      [mine, null],
      [left, 'drive-1'],
      [right, 'drive-1'],
    ])
    expect(fake.childQueries).toEqual([
      [[mine], null],
      [[left, right], 'drive-1'],
    ])
    expect(children.get(mine)).toEqual([])
    expect(children.get(left)?.map((item) => item.id)).toEqual([lone])
    expect(children.get(right)?.map((item) => item.name)).toEqual(['y.txt'])
  })
})

describe('gdrive tree failures', () => {
  it('leaves a level that fails to the walk', async () => {
    fake.folder('sub')
    vi.spyOn(fake, 'listChildren').mockRejectedValue(new TypeError('fetch failed'))
    expect(await tree(accessor, scope())).toBeNull()
  })
})

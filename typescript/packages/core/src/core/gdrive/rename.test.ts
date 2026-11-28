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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { entryAt, handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { rename } from './rename.ts'

const DOC_MIME = 'application/vnd.google-apps.document'
const FILE = '/drive/v3/files/:id'
const DENIED = 'The user does not have sufficient permissions for this file.'
const REASON = 'insufficientFilePermissions'

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

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

async function renamed(src: string, dst: string): Promise<void> {
  const accessor = account.driveAccessor()
  await rename(
    accessor,
    spec(src),
    spec(dst),
    await handedAt(readdir, accessor, spec(src), spec(dst)),
  )
}

describe('gdrive rename', () => {
  it('renames in place', async () => {
    const id = await account.upload('old.txt', 'x')
    const before = await account.item(id)
    await renamed('/old.txt', '/new.txt')
    const item = await account.item(id)
    expect(item.name).toBe('new.txt')
    expect(item.parents).toEqual(['root'])
    // A rename is no change to the file's bytes: its time stays.
    expect(item.modifiedTime).toBe(before.modifiedTime)
  })

  it('moves between folders', async () => {
    const a = await account.folder('a')
    const b = await account.folder('b')
    const id = await account.upload('f.txt', 'x', a)
    await renamed('/a/f.txt', '/b/g.txt')
    const item = await account.item(id)
    expect(item.name).toBe('g.txt')
    expect(item.parents).toEqual([b])
  })

  it('replaces an existing file', async () => {
    const src = await account.upload('src.txt', 'new')
    await account.upload('dst.txt', 'old')
    await renamed('/src.txt', '/dst.txt')
    expect((await account.item(src)).name).toBe('dst.txt')
    expect(await account.items()).toHaveLength(1)
  })

  it('non-empty dir conflict raises ENOTEMPTY', async () => {
    await account.upload('src.txt', 'x')
    const d = await account.folder('d')
    await account.upload('f.txt', 'y', d)
    await account.upload('g.txt', 'z', d)
    await account.run.recordRequests()
    await expect(renamed('/src.txt', '/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    // The conflict probe is bounded, not a full listing: a listing follows
    // every nextPageToken, so asking it with a small page size made one
    // request per child to answer a yes/no. Two children, so a probe that
    // walked every page would make two.
    const probes = (await account.listings()).filter((l) => l.folders.join() === d)
    expect(probes.map((l) => l.pageSize)).toEqual([1])
  })

  it('replaces an empty dir', async () => {
    const src = await account.upload('src.txt', 'x')
    await account.folder('d')
    await renamed('/src.txt', '/d')
    expect((await account.item(src)).name).toBe('d')
    expect(await account.items()).toHaveLength(1)
  })

  it('missing src raises ENOENT', async () => {
    await expect(renamed('/missing.txt', '/x.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('strips the native suffix from the Drive name', async () => {
    const id = await account.create('Report', DOC_MIME)
    await renamed('/Report.gdoc.json', '/Plan.gdoc.json')
    expect((await account.item(id)).name).toBe('Plan')
  })

  it('a refused move keeps the destination', async () => {
    const src = await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.refuse('PATCH', FILE, 403, DENIED, { reason: REASON })
    await expect(renamed('/src.txt', '/dst.txt')).rejects.toMatchObject({ code: 'EACCES' })
    expect((await account.item(src)).name).toBe('src.txt')
    expect(await account.content(dst)).toBe('old')
  })

  it('a refused delete moves the item back', async () => {
    const a = await account.folder('a')
    const src = await account.upload('src.txt', 'new', a)
    const dst = await account.upload('dst.txt', 'old')
    const before = await account.item(src)
    await account.refuse('DELETE', FILE, 403, DENIED, { reason: REASON })
    await expect(renamed('/a/src.txt', '/dst.txt')).rejects.toMatchObject({ code: 'EACCES' })
    const item = await account.item(src)
    expect(item.name).toBe('src.txt')
    expect(item.parents).toEqual([a])
    expect(item.modifiedTime).toBe(before.modifiedTime)
    expect(await account.content(dst)).toBe('old')
  })

  it('keeps a folder given a child while the item moves', async () => {
    const src = await account.folder('src')
    const d = await account.folder('d')
    // Another client writes into the folder after the first emptiness probe,
    // while the move is on its way: the probe made just before the delete
    // sees it, so the folder stays and the move is undone.
    await account.run.beforeNext([['PATCH', FILE]], () => account.upload('late.txt', 'x', d))
    await expect(renamed('/src', '/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect((await account.item(src)).name).toBe('src')
    expect((await account.find('late.txt'))?.parents).toEqual([d])
  })

  it('does nothing onto the same item', async () => {
    const id = await account.upload('f.txt', 'data')
    const accessor = account.driveAccessor()
    const entry = await entryAt(readdir, accessor, spec('/f.txt'))
    // Drive lists a legacy item under each of its parents, so another
    // folder's row can name this same id. A row naming no folder is taken as
    // listed, which stands in for that second listing.
    const twin = new FileStat({ name: 'f.txt', type: FileType.FILE, extra: { file_id: id } })
    await account.run.recordRequests()
    await rename(accessor, spec('/f.txt'), spec('/b/f.txt'), { entry, dstEntry: twin })
    expect(await account.asked('PATCH', FILE)).toEqual([])
    expect(await account.asked('DELETE', FILE)).toEqual([])
    expect(await account.content(id)).toBe('data')
  })

  it('keeps the move when its delete went through but answered an error', async () => {
    // The file it named is gone, so moving the item back would leave nothing
    // at the name.
    const src = await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.run.beforeNext([['DELETE', FILE]], () => account.delete(dst), 502)
    await renamed('/src.txt', '/dst.txt')
    expect((await account.items()).map((item) => [item.id, item.name])).toEqual([[src, 'dst.txt']])
  })
})

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
import { PathSpec } from '../../types.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { rename } from './rename.ts'

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

  it('failure preserves destination file', async () => {
    const src = fake.add('src.txt', 'root', undefined, ENC.encode('src'))
    const dst = fake.add('dst.txt', 'root', undefined, ENC.encode('dst'))
    fake.patchFile = async () => {
      throw new Error('patch failed')
    }
    await expect(
      rename(
        accessor,
        spec('/src.txt'),
        spec('/dst.txt'),
        await handedAt(readdir, accessor, spec('/src.txt'), spec('/dst.txt')),
      ),
    ).rejects.toThrow('patch failed')
    expect(fake.items.get(dst)?.content).toEqual(ENC.encode('dst'))
    expect(fake.items.get(src)?.content).toEqual(ENC.encode('src'))
  })

  it('same drive id does not delete file', async () => {
    const folderA = fake.folder('a')
    const folderB = fake.folder('b')
    const fileId = fake.add('f.txt', folderA, undefined, ENC.encode('data'))
    fake.items.get(fileId)?.parents.push(folderB)

    await rename(
      accessor,
      spec('/a/f.txt'),
      spec('/b/f.txt'),
      await handedAt(readdir, accessor, spec('/a/f.txt'), spec('/b/f.txt')),
    )
    expect(fake.items.has(fileId)).toBe(true)
    expect(fake.items.get(fileId)?.content).toEqual(ENC.encode('data'))
  })
})

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
import { copy } from './copy.ts'

const FILE = '/drive/v3/files/:id'
const COPY = '/drive/v3/files/:id/copy'
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

async function copied(src: string, dst: string): Promise<void> {
  const accessor = account.driveAccessor()
  await copy(
    accessor,
    spec(src),
    spec(dst),
    undefined,
    await handedAt(readdir, accessor, spec(src), spec(dst)),
  )
}

describe('gdrive copy', () => {
  it('copies a file', async () => {
    await account.upload('src.txt', 'data')
    await copied('/src.txt', '/dst.txt')
    const dst = await account.find('dst.txt')
    expect(await account.content(dst?.id ?? '')).toBe('data')
    expect(await account.find('src.txt')).not.toBeNull()
  })

  it('overwrites an existing file', async () => {
    await account.upload('src.txt', 'new')
    await account.upload('dst.txt', 'old')
    await copied('/src.txt', '/dst.txt')
    const dst = await account.find('dst.txt')
    expect(await account.content(dst?.id ?? '')).toBe('new')
    expect(await account.items()).toHaveLength(2)
  })

  it('file onto dir raises EISDIR', async () => {
    await account.upload('src.txt', 'x')
    await account.folder('d')
    await expect(copied('/src.txt', '/d')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('copies a tree into a missing dir', async () => {
    const src = await account.folder('src')
    const sub = await account.folder('sub', src)
    await account.upload('f.txt', 'deep', sub)
    await account.upload('top.txt', 'top', src)
    await copied('/src', '/dst')
    expect(await account.find('dst')).not.toBeNull()
    const items = await account.items()
    for (const name of ['sub', 'f.txt', 'top.txt']) {
      expect(items.filter((i) => i.name === name)).toHaveLength(2)
    }
    const deep = items.filter((i) => i.name === 'f.txt')
    expect(await Promise.all(deep.map((i) => account.content(i.id)))).toEqual(['deep', 'deep'])
  })

  it('merges into an existing dir', async () => {
    const src = await account.folder('src')
    await account.upload('f.txt', 'x', src)
    const dst = await account.folder('dst')
    await account.upload('keep.txt', 'k', dst)
    await copied('/src', '/dst')
    const children = (await account.items()).filter((i) => i.parents.includes(dst))
    expect(new Set(children.map((i) => i.name))).toEqual(new Set(['keep.txt', 'f.txt']))
  })

  it('dir onto file raises ENOTDIR', async () => {
    await account.folder('src')
    await account.upload('f.txt', 'x')
    await expect(copied('/src', '/f.txt')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('missing src raises ENOENT', async () => {
    await expect(copied('/missing.txt', '/dst.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a refused copy keeps the destination', async () => {
    await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.refuse('POST', COPY, 403, 'This file cannot be copied by the user.', {
      reason: REASON,
    })
    await expect(copied('/src.txt', '/dst.txt')).rejects.toMatchObject({
      code: 'EACCES',
      virtualPath: spec('/src.txt').virtual,
    })
    expect(await account.content(dst)).toBe('old')
    expect(await account.items()).toHaveLength(2)
  })

  it('a refused delete drops the copy', async () => {
    await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.refuse('DELETE', FILE, 403, DENIED, {
      reason: REASON,
      path: `/drive/v3/files/${dst}`,
    })
    await expect(copied('/src.txt', '/dst.txt')).rejects.toMatchObject({
      code: 'EACCES',
      virtualPath: spec('/dst.txt').virtual,
    })
    expect(await account.content(dst)).toBe('old')
    expect(await account.items()).toHaveLength(2)
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
    await copy(accessor, spec('/f.txt'), spec('/b/f.txt'), undefined, {
      entry,
      dstEntry: twin,
    })
    expect(await account.asked('POST', COPY)).toEqual([])
    expect(await account.asked('DELETE', FILE)).toEqual([])
    expect(await account.items()).toHaveLength(1)
  })

  it('leaves a destination another client renamed while the copy landed', async () => {
    // It no longer holds the destination, and Drive deletes by id wherever an
    // item went, so the copy takes the name and that file is left as it is.
    await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.run.beforeNext([['POST', COPY]], () =>
      account.run.call('PATCH', `/drive/v3/files/${dst}`, { json: { name: 'kept.txt' } }),
    )
    await copied('/src.txt', '/dst.txt')
    const names = (await account.items()).map((item) => item.name).sort()
    expect(names).toEqual(['dst.txt', 'kept.txt', 'src.txt'])
    expect(await account.content(dst)).toBe('old')
  })

  it('keeps the copy when its delete went through but answered an error', async () => {
    // A relay's 502, say: the file it named is gone, so dropping the copy
    // would leave nothing at the destination.
    await account.upload('src.txt', 'new')
    const dst = await account.upload('dst.txt', 'old')
    await account.run.beforeNext([['DELETE', FILE]], () => account.delete(dst), 502)
    await copied('/src.txt', '/dst.txt')
    const items = await account.items()
    expect(items.map((item) => item.name).sort()).toEqual(['dst.txt', 'src.txt'])
    const made = items.find((item) => item.name === 'dst.txt')
    expect(await account.content(made?.id ?? '')).toBe('new')
  })
})

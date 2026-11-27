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
import { copy } from './copy.ts'

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

  it('failure preserves destination file', async () => {
    const src = fake.add('src.txt', 'root', undefined, ENC.encode('src'))
    const dst = fake.add('dst.txt', 'root', undefined, ENC.encode('dst'))
    fake.copyFile = async () => {
      throw new Error('copy failed')
    }
    await expect(
      copy(
        accessor,
        spec('/src.txt'),
        spec('/dst.txt'),
        undefined,
        await handedAt(readdir, accessor, spec('/src.txt'), spec('/dst.txt')),
      ),
    ).rejects.toThrow('copy failed')
    expect(fake.items.get(dst)?.content).toEqual(ENC.encode('dst'))
    expect(fake.items.get(src)?.content).toEqual(ENC.encode('src'))
  })
})

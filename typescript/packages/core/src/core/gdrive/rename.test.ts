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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import { PathSpec } from '../../types.ts'
import type { FakeDrive } from './_test_util.ts'
import { DOC_MIME, makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { rename } from './rename.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive rename', () => {
  it('renames in place', async () => {
    const id = fake.add('old.txt', 'root', undefined, ENC.encode('x'))
    await rename(accessor, spec('/old.txt'), spec('/new.txt'))
    expect(fake.items.get(id)?.name).toBe('new.txt')
    expect(fake.items.get(id)?.parents).toEqual(['root'])
  })

  it('moves between folders', async () => {
    const a = fake.folder('a')
    const b = fake.folder('b')
    const id = fake.add('f.txt', a, undefined, ENC.encode('x'))
    await rename(accessor, spec('/a/f.txt'), spec('/b/g.txt'))
    expect(fake.items.get(id)?.name).toBe('g.txt')
    expect(fake.items.get(id)?.parents).toEqual([b])
  })

  it('replaces an existing file', async () => {
    const src = fake.add('src.txt', 'root', undefined, ENC.encode('new'))
    fake.add('dst.txt', 'root', undefined, ENC.encode('old'))
    await rename(accessor, spec('/src.txt'), spec('/dst.txt'))
    expect(fake.items.get(src)?.name).toBe('dst.txt')
    expect(fake.items.size).toBe(1)
  })

  it('non-empty dir conflict raises ENOTEMPTY', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('x'))
    const d = fake.folder('d')
    fake.add('f.txt', d, undefined, ENC.encode('y'))
    await expect(rename(accessor, spec('/src.txt'), spec('/d'))).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
  })

  it('replaces an empty dir', async () => {
    const src = fake.add('src.txt', 'root', undefined, ENC.encode('x'))
    fake.folder('d')
    await rename(accessor, spec('/src.txt'), spec('/d'))
    expect(fake.items.get(src)?.name).toBe('d')
    expect(fake.items.size).toBe(1)
  })

  it('missing src raises ENOENT', async () => {
    await expect(rename(accessor, spec('/missing.txt'), spec('/x.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('strips the native suffix from the Drive name', async () => {
    const id = fake.add('Report', 'root', DOC_MIME)
    await rename(accessor, spec('/Report.gdoc.json'), spec('/Plan.gdoc.json'))
    expect(fake.items.get(id)?.name).toBe('Plan')
  })
})

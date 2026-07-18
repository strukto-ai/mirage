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

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function seedTree(): void {
  const sub = fake.folder('sub')
  fake.add('a.txt', 'root', undefined, ENC.encode('aaaa'))
  fake.add('big.bin', sub, undefined, ENC.encode('x'.repeat(2048)))
  fake.add('small.bin', sub, undefined, ENC.encode('x'.repeat(16)))
  fake.add('Report', 'root', DOC_MIME)
}

import { du, duAll } from './du.ts'

describe('gdrive core du', () => {
  it('sums file sizes across a nested tree', async () => {
    seedTree()
    expect(await du(accessor, spec('/'))).toBe(4 + 2048 + 16)
  })

  it('a file path resolves from its own stat', async () => {
    seedTree()
    expect(await du(accessor, spec('/a.txt'))).toBe(4)
    expect(await duAll(accessor, spec('/a.txt'))).toEqual([[], 4])
  })

  it('duAll returns per-file entries plus the total', async () => {
    seedTree()
    const [entries, total] = await duAll(accessor, spec('/sub'))
    expect(entries).toEqual([
      ['/sub/big.bin', 2048],
      ['/sub/small.bin', 16],
    ])
    expect(total).toBe(2064)
  })

  it('a missing root raises ENOENT', async () => {
    await expect(du(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

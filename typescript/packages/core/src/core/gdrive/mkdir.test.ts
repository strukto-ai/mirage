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
import { makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { FOLDER_MIME } from '../google/drive.ts'
import { mkdir } from './mkdir.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive mkdir', () => {
  it('creates a folder', async () => {
    await mkdir(accessor, spec('/d'))
    expect(fake.find('d')?.mimeType).toBe(FOLDER_MIME)
  })

  it('existing target raises EEXIST', async () => {
    fake.folder('d')
    await expect(mkdir(accessor, spec('/d'))).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('missing parent raises ENOENT', async () => {
    await expect(mkdir(accessor, spec('/no/d'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('-p builds the chain and is idempotent', async () => {
    await mkdir(accessor, spec('/a/b/c'), true)
    const a = fake.find('a')
    const b = fake.find('b')
    const c = fake.find('c')
    expect(a && b && c).toBeTruthy()
    expect(b?.parents).toEqual([a?.id])
    expect(c?.parents).toEqual([b?.id])
    await mkdir(accessor, spec('/a/b/c'), true)
    expect(fake.items.size).toBe(3)
  })

  it('-p over a file raises EEXIST at the leaf and ENOTDIR mid-path', async () => {
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await expect(mkdir(accessor, spec('/f.txt'), true)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(mkdir(accessor, spec('/f.txt/sub'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

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
import { write } from './write.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive write', () => {
  it('creates a file in an existing parent', async () => {
    fake.folder('a')
    await write(accessor, spec('/a/new.txt'), ENC.encode('hello'))
    const item = fake.find('new.txt')
    expect(item).not.toBeNull()
    expect(DEC.decode(item?.content)).toBe('hello')
  })

  it('overwrites the same id', async () => {
    const id = fake.add('f.txt', 'root', undefined, ENC.encode('old'))
    await write(accessor, spec('/f.txt'), ENC.encode('new'))
    expect(DEC.decode(fake.items.get(id)?.content)).toBe('new')
    expect(fake.items.size).toBe(1)
  })

  it('missing parent raises ENOENT', async () => {
    await expect(write(accessor, spec('/no/f.txt'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('writing a folder raises EISDIR', async () => {
    fake.folder('d')
    await expect(write(accessor, spec('/d'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('writing a google-native file raises EACCES', async () => {
    fake.add('Report', 'root', DOC_MIME)
    await expect(write(accessor, spec('/Report.gdoc.json'), ENC.encode('x'))).rejects.toMatchObject(
      { code: 'EACCES' },
    )
  })
})

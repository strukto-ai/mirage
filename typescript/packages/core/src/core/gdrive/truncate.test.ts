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

import { beforeEach, describe, expect, it } from 'vitest'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { PathSpec } from '../../types.ts'
import { FakeDrive, makeGDriveAccessor } from './_test_util.ts'
import { truncate } from './truncate.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive
let accessor: GDriveAccessor

beforeEach(() => {
  fake = new FakeDrive()
  accessor = makeGDriveAccessor(fake)
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive truncate', () => {
  it('shrinks', async () => {
    const id = fake.add('f.txt', 'root', undefined, ENC.encode('abcdef'))
    await truncate(accessor, spec('/f.txt'), 3)
    expect(DEC.decode(fake.items.get(id)?.content)).toBe('abc')
  })

  it('pads with NULs', async () => {
    const id = fake.add('f.txt', 'root', undefined, ENC.encode('ab'))
    await truncate(accessor, spec('/f.txt'), 4)
    expect(fake.items.get(id)?.content).toEqual(new Uint8Array([97, 98, 0, 0]))
  })

  it('creates a missing file', async () => {
    await truncate(accessor, spec('/new.txt'), 2)
    expect(fake.find('new.txt')?.content).toEqual(new Uint8Array([0, 0]))
  })

  it('folder raises EISDIR', async () => {
    fake.folder('d')
    await expect(truncate(accessor, spec('/d'), 0)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

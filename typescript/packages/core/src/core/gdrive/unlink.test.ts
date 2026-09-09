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
import { unlink } from './unlink.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
let accessor: GDriveAccessor

beforeEach(() => {
  fake = new FakeDrive()
  accessor = makeGDriveAccessor(fake)
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive unlink', () => {
  it('removes a file', async () => {
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await unlink(accessor, spec('/f.txt'))
    expect(fake.find('f.txt')).toBeNull()
  })

  it('missing target raises ENOENT', async () => {
    await expect(unlink(accessor, spec('/missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('folder target raises EISDIR', async () => {
    fake.folder('d')
    await expect(unlink(accessor, spec('/d'))).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

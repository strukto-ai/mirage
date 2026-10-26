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
import { MountMode, PathSpec } from '../../types.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { readdir } from './readdir.ts'
import { FakeDrive, makeGDriveAccessor } from '../../../tests/core/gdrive/_test_util.ts'
import { FOLDER_MIME } from '../google/drive.ts'
import { mkdir } from './mkdir.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
let accessor: GDriveAccessor

beforeEach(() => {
  fake = new FakeDrive()
  accessor = makeGDriveAccessor(fake)
})

function workspace(): Workspace {
  const vfs = new GoogleDriveVFS({ clientId: 'x', refreshToken: 'y' })
  Object.assign(vfs, { accessor })
  return new Workspace({ '/d/': vfs }, { mode: MountMode.WRITE })
}

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive mkdir', () => {
  it('creates a folder', async () => {
    await mkdir(accessor, spec('/d'), false, await handedAt(readdir, accessor, spec('/d')))
    expect(fake.find('d')?.mimeType).toBe(FOLDER_MIME)
  })

  it('missing parent raises ENOENT', async () => {
    await expect(
      mkdir(accessor, spec('/no/d'), false, await handedAt(readdir, accessor, spec('/no/d'))),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('-p builds the chain one level at a time and is idempotent', async () => {
    // -p is the mount's: it makes one level at a time, each handed the folder
    // the level above answered.
    const ws = workspace()
    try {
      await ws.dispatch('mkdir', '/d/a/b/c', [], { parents: true })
      const a = fake.find('a')
      const b = fake.find('b')
      const c = fake.find('c')
      expect(a && b && c).toBeTruthy()
      expect(b?.parents).toEqual([a?.id])
      expect(c?.parents).toEqual([b?.id])
      await ws.dispatch('mkdir', '/d/a/b/c', [], { parents: true })
      expect(fake.items.size).toBe(3)
    } finally {
      await ws.close()
    }
  })

  it('-p over a file raises EEXIST at the leaf and ENOTDIR mid-path', async () => {
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    const ws = workspace()
    try {
      await expect(ws.dispatch('mkdir', '/d/f.txt', [], { parents: true })).rejects.toMatchObject({
        code: 'EEXIST',
      })
      await expect(
        ws.dispatch('mkdir', '/d/f.txt/sub', [], { parents: true }),
      ).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await ws.close()
    }
  })
})

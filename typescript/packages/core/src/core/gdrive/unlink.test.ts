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
import { unlink } from './unlink.ts'

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

async function unlinked(path: string): Promise<void> {
  const accessor = account.driveAccessor()
  await unlink(accessor, spec(path), await handedAt(readdir, accessor, spec(path)))
}

describe('gdrive unlink', () => {
  it('removes the file at the path now', async () => {
    // The listing named a.txt; another client then renamed that file to b.txt
    // and made a new a.txt. The unlink removes the new a.txt.
    const moved = await account.upload('a.txt', 'old')
    const accessor = account.driveAccessor()
    const listed = await handedAt(readdir, accessor, spec('/a.txt'))
    await account.patch(moved, { name: 'b.txt' })
    const made = await account.upload('a.txt', 'other')
    await unlink(accessor, spec('/a.txt'), listed)
    const ids = (await account.items()).map((item) => item.id)
    expect(ids).not.toContain(made)
    expect(ids).toContain(moved)
  })

  it('removes a file', async () => {
    await account.upload('f.txt', 'x')
    await unlinked('/f.txt')
    expect(await account.find('f.txt')).toBeNull()
  })

  it('missing target raises ENOENT', async () => {
    await expect(unlinked('/missing.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('folder target raises EISDIR', async () => {
    await account.folder('d')
    await expect(unlinked('/d')).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

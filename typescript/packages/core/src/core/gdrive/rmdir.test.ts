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
import { rmdir } from './rmdir.ts'

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

async function removed(path: string): Promise<void> {
  const accessor = account.driveAccessor()
  await rmdir(accessor, spec(path), await handedAt(readdir, accessor, spec(path)))
}

describe('gdrive rmdir', () => {
  it('removes a dir', async () => {
    await account.folder('d')
    await removed('/d')
    expect(await account.find('d')).toBeNull()
  })

  it('missing target raises ENOENT', async () => {
    await expect(removed('/missing')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('file target raises ENOTDIR', async () => {
    await account.upload('f.txt', 'x')
    await expect(removed('/f.txt')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('refuses a folder holding a file and keeps both', async () => {
    const folder = await account.folder('d')
    await account.upload('a.txt', 'a', folder)
    await expect(removed('/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await account.find('d')).not.toBeNull()
    expect(await account.find('a.txt')).not.toBeNull()
  })

  it('refuses a folder holding a subfolder', async () => {
    const folder = await account.folder('d')
    await account.folder('sub', folder)
    await expect(removed('/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await account.find('d')).not.toBeNull()
    expect(await account.find('sub')).not.toBeNull()
  })
})

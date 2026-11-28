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
import { rmR } from './rm.ts'

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

describe('gdrive rm -r', () => {
  it('removes a tree', async () => {
    const d = await account.folder('d')
    const s = await account.folder('s', d)
    await account.upload('f.txt', 'x', s)
    const accessor = account.driveAccessor()
    await rmR(accessor, spec('/d'), await handedAt(readdir, accessor, spec('/d')))
    expect(await account.items()).toEqual([])
  })

  it('missing target raises ENOENT', async () => {
    const accessor = account.driveAccessor()
    await expect(
      rmR(accessor, spec('/missing'), await handedAt(readdir, accessor, spec('/missing'))),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

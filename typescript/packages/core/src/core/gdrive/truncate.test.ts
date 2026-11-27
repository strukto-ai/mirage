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
import { truncate } from './truncate.ts'

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

async function truncated(path: string, size: number): Promise<void> {
  const accessor = account.driveAccessor()
  await truncate(accessor, spec(path), size, false, await handedAt(readdir, accessor, spec(path)))
}

describe('gdrive truncate', () => {
  it('shrinks', async () => {
    const id = await account.upload('f.txt', 'abcdef')
    await truncated('/f.txt', 3)
    expect(await account.content(id)).toBe('abc')
  })

  it('pads with NULs', async () => {
    const id = await account.upload('f.txt', 'ab')
    await truncated('/f.txt', 4)
    expect(await account.content(id)).toBe('ab\0\0')
  })

  it('creates a missing file', async () => {
    await truncated('/new.txt', 2)
    const made = await account.find('new.txt')
    expect(await account.content(made?.id ?? '')).toBe('\0\0')
  })

  it('folder raises EISDIR', async () => {
    await account.folder('d')
    await expect(truncated('/d', 0)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

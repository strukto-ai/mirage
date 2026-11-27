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
import { exists } from './exists.ts'

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

describe('gdrive exists', () => {
  it('root, present and missing paths', async () => {
    await account.upload('f.txt', 'x')
    const accessor = account.driveAccessor()
    for (const [path, found] of [
      ['/', true],
      ['/f.txt', true],
      ['/missing.txt', false],
    ] as const) {
      expect(
        await exists(accessor, spec(path), (await handedAt(readdir, accessor, spec(path))).entry),
      ).toBe(found)
    }
  })
})

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
import { CapacityState } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { capacity } from './capacity.ts'

const ABOUT = '/drive/v3/about'

interface About {
  [key: string]: unknown
  storageQuota: { limit?: string; usage: string }
}

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

describe('gdrive capacity', () => {
  it("takes My Drive's quota as the capacity", async () => {
    await account.upload('a.bin', 'x'.repeat(400))
    const quota = (await account.run.call<About>('GET', ABOUT)).storageQuota
    const accessor = account.driveAccessor(undefined, { folderId: await account.folder('scope') })
    const total = Number(quota.limit)
    expect(await capacity(accessor)).toEqual({
      state: CapacityState.QUOTA,
      total,
      used: 400,
      available: total - 400,
    })
  })

  it('is elastic for a drive with no limit', async () => {
    // An account with unlimited storage: Drive answers its usage and no
    // limit, which the fake's own quota is answered without.
    const about = await account.run.call<About>('GET', ABOUT)
    delete about.storageQuota.limit
    await account.run.answerNext('GET', ABOUT, 200, about as never)
    const accessor = account.driveAccessor(undefined, { folderId: await account.folder('scope') })
    expect(await capacity(accessor)).toEqual({ state: CapacityState.ELASTIC })
  })

  it('asks no quota for a shared drive', async () => {
    const drive = await account.sharedDrive('Team')
    const accessor = account.driveAccessor(undefined, {
      folderId: await account.folder('scope', drive),
    })
    await account.run.recordRequests()
    expect(await capacity(accessor)).toEqual({ state: CapacityState.UNKNOWN })
    expect(accessor.rootDriveId).toBe(drive)
    expect((await account.log()).filter(([name]) => name === `GET ${ABOUT}`)).toEqual([])
  })
})

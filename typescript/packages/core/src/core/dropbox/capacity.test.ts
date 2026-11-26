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
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { capacity } from './capacity.ts'

const USAGE_ROUTE = '/2/users/get_space_usage'

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function quota(total: number, used: number): unknown {
  return { state: CapacityState.QUOTA, total, used, available: total - used }
}

describe('dropbox capacity', () => {
  // The fake's account is a Basic one, with the stored bytes as its use.
  it('takes an individual allocation as the quota', async () => {
    const usage = await account.run.call<{ allocation: { allocated: number } }>(
      'POST',
      USAGE_ROUTE,
    )
    await account.put('/a.txt', new Uint8Array(300))
    await account.run.recordRequests()
    const result = await capacity(account.accessor())
    expect(await account.run.bodies('POST', USAGE_ROUTE)).toEqual([null])
    expect(result).toEqual(quota(usage.allocation.allocated, 300))
  })

  it.each([
    [
      'member cap',
      { '.tag': 'team', used: 900, allocated: 5000, user_within_team_space_allocated: 1000 },
      300,
      1000,
    ],
    [
      'team pool',
      { '.tag': 'team', used: 900, allocated: 5000, user_within_team_space_allocated: 0 },
      900,
      5000,
    ],
  ])('takes the allocation that bounds a team account (%s)', async (_name, allocation, used, total) => {
    await account.run.answerNext('POST', USAGE_ROUTE, 200, { used: 300, allocation })
    expect(await capacity(account.accessor())).toEqual(quota(total, used))
  })
})

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
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { capacity } from './capacity.ts'
import { UNLIMITED_SPACE } from './constants.ts'

const ME_ROUTE = '/2.0/users/me'

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

beforeEach(() => {
  account = new BoxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

describe('box capacity', () => {
  // The fake's account is a Personal one, with Box's amount and the stored
  // bytes as its use.
  it('takes the space amount as the quota', async () => {
    const me = await account.run.call<{ space_amount: number }>('GET', ME_ROUTE)
    await account.put('a.txt', new Uint8Array(250))
    await account.run.recordRequests()
    const result = await capacity(account.accessor())
    expect(await account.run.requests()).toEqual([`GET ${ME_ROUTE}`])
    expect(result).toEqual({
      state: CapacityState.QUOTA,
      total: me.space_amount,
      used: 250,
      available: me.space_amount - 250,
    })
  })

  it('takes an unlimited space amount as elastic', async () => {
    await account.run.answerNext('GET', ME_ROUTE, 200, {
      type: 'user',
      space_amount: UNLIMITED_SPACE,
      space_used: 250,
    })
    expect(await capacity(account.accessor())).toEqual({ state: CapacityState.ELASTIC })
  })
})

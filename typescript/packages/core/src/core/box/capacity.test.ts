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

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, boxGet: vi.fn() }
})

import type { BoxAccessor } from '../../accessor/box.ts'
import { CapacityState, type CapacityResult } from '../../types.ts'
import { capacity } from './capacity.ts'
import * as client from './client.ts'
import { UNLIMITED_SPACE } from './constants.ts'

const accessor = { tokenManager: { apiBase: 'https://api.box.test/2.0' } } as unknown as BoxAccessor

describe('box capacity', () => {
  it.each<[number, CapacityResult]>([
    [1000, { state: CapacityState.QUOTA, total: 1000, used: 250, available: 750 }],
    [UNLIMITED_SPACE, { state: CapacityState.ELASTIC }],
  ])('takes the space amount %d as the quota', async (amount, expected) => {
    vi.mocked(client.boxGet).mockResolvedValueOnce({ space_amount: amount, space_used: 250 })
    expect(await capacity(accessor)).toEqual(expected)
    expect(vi.mocked(client.boxGet).mock.calls.at(-1)?.[1]).toBe(
      'https://api.box.test/2.0/users/me',
    )
  })
})

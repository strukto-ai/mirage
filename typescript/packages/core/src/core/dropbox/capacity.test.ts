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
  return { ...actual, dropboxRpc: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { CapacityState } from '../../types.ts'
import { capacity } from './capacity.ts'
import * as client from './client.ts'
import type { DropboxTokenManager } from './client.ts'

describe('dropbox capacity', () => {
  it.each([
    [{ '.tag': 'individual', allocated: 1000 }, 300, 1000],
    [
      { '.tag': 'team', used: 900, allocated: 5000, user_within_team_space_allocated: 1000 },
      300,
      1000,
    ],
    [
      { '.tag': 'team', used: 900, allocated: 5000, user_within_team_space_allocated: 0 },
      900,
      5000,
    ],
  ])('takes the allocation that bounds the account (%o)', async (allocation, used, total) => {
    vi.mocked(client.dropboxRpc).mockResolvedValueOnce({ used: 300, allocation })
    const accessor = new DropboxAccessor({ tokenManager: {} as DropboxTokenManager })
    expect(await capacity(accessor)).toEqual({
      state: CapacityState.QUOTA,
      total,
      used,
      available: total - used,
    })
    expect(vi.mocked(client.dropboxRpc).mock.calls.at(-1)?.slice(1)).toEqual([
      '/users/get_space_usage',
      null,
    ])
  })
})

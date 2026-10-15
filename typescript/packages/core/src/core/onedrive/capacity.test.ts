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
import type * as GraphModule from '../msgraph/client.ts'

vi.mock('../msgraph/client.ts', async () => {
  const actual = await vi.importActual<typeof GraphModule>('../msgraph/client.ts')
  return { ...actual, graphGet: vi.fn() }
})

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { CapacityState } from '../../types.ts'
import * as graph from '../msgraph/client.ts'
import { capacity } from './capacity.ts'

const accessor = new OneDriveAccessor({ accessToken: 'tok' })

describe('onedrive capacity', () => {
  it('takes the quota facet as the capacity', async () => {
    vi.mocked(graph.graphGet).mockResolvedValueOnce({
      quota: { total: 1000, used: 300, remaining: 650 },
    })
    expect(await capacity(accessor)).toEqual({
      state: CapacityState.QUOTA,
      total: 1000,
      used: 300,
      available: 650,
    })
    const call = vi.mocked(graph.graphGet).mock.calls.at(-1)
    expect(call?.[1]).toBe('https://graph.microsoft.com/v1.0/me/drive')
    expect(call?.[2]).toEqual({ $select: 'quota' })
  })
})

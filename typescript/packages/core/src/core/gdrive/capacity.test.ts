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
import type * as ClientModule from '../google/client.ts'
import type * as ResolveModule from './resolve.ts'

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn() }
})
vi.mock('./resolve.ts', async () => {
  const actual = await vi.importActual<typeof ResolveModule>('./resolve.ts')
  return { ...actual, rootContext: vi.fn() }
})

import { CapacityState, type CapacityResult } from '../../types.ts'
import * as client from '../google/client.ts'
import { makeGDriveAccessor } from './_test_util.ts'
import { capacity } from './capacity.ts'
import * as resolve from './resolve.ts'

describe('gdrive capacity', () => {
  it.each<[string | null, Record<string, string>, CapacityResult]>([
    [
      null,
      { limit: '1000', usage: '400' },
      { state: CapacityState.QUOTA, total: 1000, used: 400, available: 600 },
    ],
    [null, { usage: '400' }, { state: CapacityState.ELASTIC }],
    ['drive-1', {}, { state: CapacityState.UNKNOWN }],
  ])('takes the storage quota as the capacity (%s)', async (shared, quota, expected) => {
    vi.mocked(resolve.rootContext).mockResolvedValueOnce(['folder', shared])
    vi.mocked(client.googleGet).mockResolvedValueOnce({ storageQuota: quota })
    expect(await capacity(makeGDriveAccessor())).toEqual(expected)
  })
})

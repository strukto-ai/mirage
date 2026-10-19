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

import { describe, expect, it } from 'vitest'
import { CapacityState, type CapacityResult } from '../../types.ts'
import { makeScopedGDriveAccessor, stubDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { capacity } from './capacity.ts'

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
    const drive = stubDrive()
    drive.getFile.mockResolvedValueOnce({
      id: 'folder',
      name: 'folder',
      ...(shared === null ? {} : { driveId: shared }),
    })
    drive.storageQuota.mockResolvedValueOnce(quota)
    expect(await capacity(makeScopedGDriveAccessor('folder', drive))).toEqual(expected)
    expect(drive.getFile).toHaveBeenCalledWith('folder')
    expect(drive.storageQuota).toHaveBeenCalledTimes(shared === null ? 1 : 0)
  })
})

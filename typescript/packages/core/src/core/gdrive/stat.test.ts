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

import { stripSlash } from '../../utils/slash.ts'
import { describe, expect, it } from 'vitest'

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import { stat } from './stat.ts'

const STUB_TOKEN_MANAGER = {} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gdrive stat shared drives', () => {
  it('reports a shared drive as a directory', async () => {
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await index.put(
      '/Team Drive',
      new IndexEntry({
        id: 'drive1',
        name: 'Team Drive',
        resourceType: 'gdrive/shared_drive',
        vfsName: 'Team Drive',
        extra: { drive_id: 'drive1' },
      }),
    )
    const result = await stat(
      accessor,
      new PathSpec({
        resourcePath: stripSlash('/Team Drive'),
        virtual: '/Team Drive',
        directory: '/Team Drive',
      }),
      index,
    )
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.extra.file_id).toBe('drive1')
  })
})

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
import type * as ReaddirModule from './readdir.ts'
import type * as ResolveModule from './resolve.ts'

vi.mock('./readdir.ts', async () => {
  const actual = await vi.importActual<typeof ReaddirModule>('./readdir.ts')
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

vi.mock('./resolve.ts', async () => {
  const actual = await vi.importActual<typeof ResolveModule>('./resolve.ts')
  return { ...actual, resolveKey: vi.fn(actual.resolveKey) }
})

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import { makeGDriveAccessor, stubDrive } from './_test_util.ts'
import * as readdirModule from './readdir.ts'
import * as resolveModule from './resolve.ts'
import { stat } from './stat.ts'

function makeAccessor(): GDriveAccessor {
  return makeGDriveAccessor(stubDrive())
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
        resourcePath: 'Team Drive',
        virtual: '/Team Drive',
        directory: '/Team Drive',
      }),
      index,
    )
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.extra.file_id).toBe('drive1')
  })
})

// Mirrors test_stat_propagates_parent_refresh_failure: a listing that fails
// for any reason other than an absent parent must not read back as ENOENT,
// nor be retried as a single-file API probe.
describe('gdrive stat parent refresh', () => {
  it('propagates a failed parent listing instead of probing the API', async () => {
    vi.mocked(readdirModule.readdir).mockRejectedValueOnce(new Error('drive unavailable'))
    vi.mocked(resolveModule.resolveKey).mockRejectedValueOnce(
      new Error('should not reach statFromApi'),
    )
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({
          resourcePath: 'missing.txt',
          virtual: '/missing.txt',
          directory: '/missing.txt',
        }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toThrow(/drive unavailable/)
  })
})

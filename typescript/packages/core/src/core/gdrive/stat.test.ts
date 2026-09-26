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

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import * as readdirModule from './readdir.ts'
import * as resolveModule from './resolve.ts'
import { stat } from './stat.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gdrive stat shared drives', () => {
  it('reports a shared drive as a directory', async () => {
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [
      [
        'Team Drive',
        new IndexEntry({
          id: 'drive1',
          name: 'Team Drive',
          resourceType: 'gdrive/shared_drive',
          vfsName: 'Team Drive',
          extra: { drive_id: 'drive1' },
        }),
      ],
    ])
    const result = await stat(
      accessor,
      new PathSpec({
        vfsPath: 'Team Drive',
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
          vfsPath: 'missing.txt',
          virtual: '/missing.txt',
          directory: '/missing.txt',
        }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toThrow(/drive unavailable/)
  })
})

describe('the token stat stamps', () => {
  // Every step of the chain, because a chain pinned only at its first step
  // can be truncated to the md5 and stay green -- which is the read/stat
  // mismatch this backend exists to have removed, reintroduced on one side.
  const STAMP = '2026-04-01T00:00:00.000Z'

  async function statWith(extra: Record<string, unknown>) {
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [
      [
        'report.pdf',
        new IndexEntry({
          id: 'f1',
          name: 'report',
          resourceType: 'gdrive/file',
          remoteTime: STAMP,
          vfsName: 'report.pdf',
          extra,
        }),
      ],
    ])
    return stat(
      makeAccessor(),
      new PathSpec({ vfsPath: 'report.pdf', virtual: '/report.pdf', directory: '/report.pdf' }),
      index,
    )
  }

  it('prefers the md5', async () => {
    const st = await statWith({ md5_checksum: 'abc', head_revision_id: 'r3' })
    expect(st.fingerprint).toBe('abc')
  })

  it('falls to the head revision when there is no md5', async () => {
    const st = await statWith({ head_revision_id: 'r3' })
    expect(st.fingerprint).toBe('r3')
  })

  it('falls to the stamp when the item carries neither', async () => {
    // The native google-apps case, and the reason the chain has three steps.
    const st = await statWith({})
    expect(st.fingerprint).toBe(STAMP)
  })
})

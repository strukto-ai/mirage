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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

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
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import * as readdirModule from './readdir.ts'
import * as resolveModule from './resolve.ts'
import { DOC_MIME, makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
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
  const STAMP = '2026-04-01T00:00:00.000Z'

  async function statWith(extra: Record<string, unknown>, resourceType = 'gdrive/file') {
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [
      [
        'report.pdf',
        new IndexEntry({
          id: 'f1',
          name: 'report',
          resourceType,
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

  it('stamps nothing for a file with content and neither token', async () => {
    const st = await statWith({})
    expect(st.fingerprint).toBeNull()
  })

  it('stamps a doc by its modified time', async () => {
    const st = await statWith({}, 'gdrive/gdoc')
    expect(st.fingerprint).toBe(STAMP)
  })
})

describe('gdrive stat with no index', () => {
  it('renders every kind in full', async () => {
    // Each kind's name suffix, size, token and extras.
    // An earlier test queues a one-shot rejection it never consumes.
    vi.mocked(resolveModule.resolveKey).mockReset()
    const fake = resetFakeDrive()
    fake.add('Report', 'root', DOC_MIME)
    fake.folder('d')
    fake.add('a.bin', 'root', undefined, new TextEncoder().encode('hello'))
    const accessor = makeGDriveAccessor()
    expect(await stat(accessor, PathSpec.fromStrPath('/Report'))).toEqual(
      new FileStat({
        name: 'Report.gdoc.json',
        size: null,
        type: FileType.FILE,
        content: ContentType.JSON,
        modified: '2026-01-01T00:00:00Z',
        fingerprint: '2026-01-01T00:00:00Z',
        extra: { file_id: 'id1', resource_type: 'gdrive/gdoc' },
      }),
    )
    expect(await stat(accessor, PathSpec.fromStrPath('/d'))).toEqual(
      new FileStat({
        name: 'd',
        type: FileType.DIRECTORY,
        modified: '2026-01-01T00:00:00Z',
        extra: { file_id: 'id2' },
      }),
    )
    expect(await stat(accessor, PathSpec.fromStrPath('/a.bin'))).toEqual(
      new FileStat({
        name: 'a.bin',
        size: 5,
        type: FileType.FILE,
        content: ContentType.BINARY,
        modified: '2026-01-01T00:00:00Z',
        fingerprint: '5d41402abc4b2a76b9719d911017c592',
        extra: { file_id: 'id3', resource_type: 'gdrive/file' },
      }),
    )
  })
})

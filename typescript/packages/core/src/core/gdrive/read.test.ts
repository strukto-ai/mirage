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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'
import type * as VersionsModule from './versions.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listFiles: vi.fn(), downloadFile: vi.fn() }
})

vi.mock('./versions.ts', async () => {
  const actual = await vi.importActual<typeof VersionsModule>('./versions.ts')
  return { ...actual, downloadRevision: vi.fn(), captureFileMetadata: vi.fn() }
})

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import { runWithRevisions } from '../../observe/context.ts'
import * as drive from '../google/drive.ts'
import { read, readFileVersioned } from './read.ts'
import * as versions from './versions.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gdrive read auto-bootstrap', () => {
  it('refetches root listing when entry is evicted from index', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockResolvedValue(new TextEncoder().encode('pdf-bytes'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      resourcePath: 'report.pdf',
      virtual: '/report.pdf',
      directory: '/report.pdf',
    })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toBe('pdf-bytes')
  })

  it('throws ENOENT when file missing even after recursion', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'other.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      resourcePath: 'missing.txt',
      virtual: '/missing.txt',
      directory: '/missing.txt',
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws EISDIR when reading a shared drive root', async () => {
    vi.mocked(drive.downloadFile).mockRejectedValue(new Error('should not call downloadFile'))
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
    const path = new PathSpec({
      resourcePath: 'Team Drive',
      virtual: '/Team Drive',
      directory: '/Team Drive',
    })
    await expect(read(accessor, path, index)).rejects.toThrow(/EISDIR/)
    expect(vi.mocked(drive.downloadFile)).not.toHaveBeenCalled()
  })
})

describe('gdrive versioned reads', () => {
  it('a pinned path reads that revision, not live content', async () => {
    const enc = new TextEncoder()
    vi.mocked(versions.downloadRevision).mockResolvedValue(enc.encode('pinned'))
    const data = await runWithRevisions(new Map([['/data/f.txt', 'r1']]), () =>
      readFileVersioned(STUB_TOKEN_MANAGER, 'f1', '/data/f.txt', 'f.txt'),
    )
    expect(new TextDecoder().decode(data)).toBe('pinned')
    expect(versions.downloadRevision).toHaveBeenCalledWith(STUB_TOKEN_MANAGER, 'f1', 'r1')
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })

  it('an unpinned unrecorded read skips the metadata call', async () => {
    const enc = new TextEncoder()
    vi.mocked(drive.downloadFile).mockResolvedValue(enc.encode('live'))
    const data = await readFileVersioned(STUB_TOKEN_MANAGER, 'f1', '/data/f.txt', 'f.txt')
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(versions.captureFileMetadata).not.toHaveBeenCalled()
  })
})

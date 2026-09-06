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

import { beforeEach, describe, expect, it } from 'vitest'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { runWithRevisions } from '../../observe/context.ts'
import type { StubDrive } from './_test_util.ts'
import { makeGDriveAccessor, stubDrive } from './_test_util.ts'
import { read, readFileVersioned } from './read.ts'

let drive: StubDrive

function makeAccessor(): GDriveAccessor {
  return makeGDriveAccessor(drive)
}

beforeEach(() => {
  drive = stubDrive()
  // The account has no shared drives; readdir enumerates them on every
  // listing of the mount root, so this is what a bare My Drive answers.
  drive.listSharedDrives.mockResolvedValue([])
})

describe('gdrive read auto-bootstrap', () => {
  it('refetches root listing when entry is evicted from index', async () => {
    drive.listFiles.mockImplementation((opts) => {
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
    drive.downloadFile.mockResolvedValue(new TextEncoder().encode('pdf-bytes'))

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
    drive.listFiles.mockImplementation((opts) => {
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
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      resourcePath: 'missing.txt',
      virtual: '/missing.txt',
      directory: '/missing.txt',
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // Mirrors test_read_propagates_parent_refresh_failure: only an absent
  // parent may collapse into the operand's ENOENT.
  it('propagates a failed parent listing instead of reporting ENOENT', async () => {
    drive.listFiles.mockRejectedValue(new Error('drive unavailable'))
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      resourcePath: 'missing.txt',
      virtual: '/missing.txt',
      directory: '/missing.txt',
    })
    await expect(read(accessor, path, index)).rejects.toThrow(/drive unavailable/)
  })

  it('throws EISDIR when reading a shared drive root', async () => {
    drive.downloadFile.mockRejectedValue(new Error('should not call downloadFile'))
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
    // The stamped code is the signal, not the message: the message is the
    // bare operand, which is what the shell renders (`cat: /Team Drive: Is a
    // directory`) and what Python's IsADirectoryError(virtual) carries.
    await expect(read(accessor, path, index)).rejects.toMatchObject({
      code: 'EISDIR',
      virtualPath: '/Team Drive',
    })
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })
})

describe('gdrive versioned reads', () => {
  it('a pinned path reads that revision, not live content', async () => {
    const enc = new TextEncoder()
    drive.downloadRevision.mockResolvedValue(enc.encode('pinned'))
    const data = await runWithRevisions(new Map([['/data/f.txt', 'r1']]), () =>
      readFileVersioned(drive, 'f1', '/data/f.txt', 'f.txt'),
    )
    expect(new TextDecoder().decode(data)).toBe('pinned')
    expect(drive.downloadRevision).toHaveBeenCalledWith('f1', 'r1', undefined)
    expect(drive.downloadFile).not.toHaveBeenCalled()
  })

  it('an unpinned unrecorded read skips the metadata call', async () => {
    const enc = new TextEncoder()
    drive.downloadFile.mockResolvedValue(enc.encode('live'))
    const data = await readFileVersioned(drive, 'f1', '/data/f.txt', 'f.txt')
    expect(new TextDecoder().decode(data)).toBe('live')
    expect(drive.captureFileMetadata).not.toHaveBeenCalled()
  })
})

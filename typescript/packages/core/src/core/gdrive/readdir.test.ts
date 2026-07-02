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

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listFiles: vi.fn(), listSharedDrives: vi.fn() }
})

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as drive from '../google/drive.ts'
import { readdir } from './readdir.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

const STUB_TOKEN_MANAGER = {} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

beforeEach(() => {
  vi.mocked(drive.listSharedDrives).mockResolvedValue([])
})

describe('readdir parent recursion', () => {
  it('repopulates evicted subfolder entry by refetching parent', async () => {
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'folder1',
            name: 'docs',
            mimeType: FOLDER_MIME,
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      if (opts?.folderId === 'folder1') {
        return Promise.resolve([
          {
            id: 'f2',
            name: 'notes.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: 'docs', virtual: '/docs', directory: '/docs' }),
      index,
    )
    expect(out).toContain('/docs/notes.txt')
  })

  it('raises ENOENT when subfolder missing even after recursion', async () => {
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
      throw new Error(`should not list folderId=${String(opts?.folderId)}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await expect(
      readdir(
        accessor,
        new PathSpec({ resourcePath: 'docs', virtual: '/docs', directory: '/docs' }),
        index,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readdir shared drives', () => {
  it('surfaces shared drives as top-level directories', async () => {
    vi.mocked(drive.listFiles).mockResolvedValue([
      {
        id: 'f1',
        name: 'readme.txt',
        mimeType: 'text/plain',
        modifiedTime: '2026-04-01T00:00:00.000Z',
      },
    ])
    vi.mocked(drive.listSharedDrives).mockResolvedValue([{ id: 'drive1', name: 'Team Drive' }])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toContain('/readme.txt')
    expect(out).toContain('/Team Drive/')
    const entry = (await index.get('/Team Drive')).entry
    expect(entry).not.toBeNull()
    expect(entry?.extra.drive_id).toBe('drive1')
  })

  it('uniquifies duplicate shared drive names', async () => {
    vi.mocked(drive.listFiles).mockResolvedValue([])
    vi.mocked(drive.listSharedDrives).mockResolvedValue([
      { id: 'drive1', name: 'Team' },
      { id: 'drive2', name: 'Team' },
      { id: 'drive3', name: 'Team' },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toEqual(['/Team/', '/Team [Shared Drive]/', '/Team [Shared Drive 2]/'])
    expect((await index.get('/Team')).entry?.id).toBe('drive1')
    expect((await index.get('/Team [Shared Drive]')).entry?.id).toBe('drive2')
    expect((await index.get('/Team [Shared Drive 2]')).entry?.id).toBe('drive3')
  })

  it('still lists My Drive when shared drive enumeration fails', async () => {
    vi.mocked(drive.listFiles).mockResolvedValue([
      {
        id: 'f1',
        name: 'readme.txt',
        mimeType: 'text/plain',
        modifiedTime: '2026-04-01T00:00:00.000Z',
      },
    ])
    vi.mocked(drive.listSharedDrives).mockRejectedValue(new Error('no scope'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toContain('/readme.txt')
  })

  it('passes drive_id from the cached entry when listing inside a shared drive', async () => {
    vi.mocked(drive.listSharedDrives).mockResolvedValue([{ id: 'drive1', name: 'Team Drive' }])
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') return Promise.resolve([])
      if (opts?.folderId === 'drive1') {
        return Promise.resolve([
          {
            id: 'f2',
            name: 'spec.pdf',
            mimeType: 'application/pdf',
            driveId: 'drive1',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${String(opts?.folderId)}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(accessor, new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }), index)
    const out = await readdir(
      accessor,
      new PathSpec({
        resourcePath: 'Team Drive',
        virtual: '/Team Drive',
        directory: '/Team Drive',
      }),
      index,
    )
    expect(out).toContain('/Team Drive/spec.pdf')
    const innerCall = vi.mocked(drive.listFiles).mock.calls.find((c) => c[1]?.folderId === 'drive1')
    expect(innerCall?.[1]?.driveId).toBe('drive1')
  })
})

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
import { RedisIndexCacheStore } from '../../cache/index/redis.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

beforeEach(() => {
  vi.mocked(drive.listSharedDrives).mockResolvedValue([])
})

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `direct Drive stat with ${backend}`,
    () => {
      it.each(['updated', 'deleted', 'renamed-folder'])(
        'refreshes invalidated ids: %s',
        async (change) => {
          const url = process.env.REDIS_URL
          const index =
            backend === 'ram'
              ? new RAMIndexCacheStore()
              : new RedisIndexCacheStore({
                  ...(url === undefined ? {} : { url }),
                  keyPrefix: `drive-refresh:${crypto.randomUUID()}:`,
                })
          let refreshed = false
          const calls: string[] = []
          vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
            const folderId = opts?.folderId ?? 'root'
            calls.push(folderId)
            if (
              refreshed &&
              change === 'renamed-folder' &&
              folderId === 'root' &&
              opts?.name === 'docs'
            )
              return Promise.resolve([])
            if (folderId === 'root')
              return Promise.resolve([
                {
                  id: refreshed ? 'new-folder' : 'old-folder',
                  name: refreshed && change === 'renamed-folder' ? 'renamed' : 'docs',
                  mimeType: FOLDER_MIME,
                },
              ])
            expect(folderId).toBe(refreshed ? 'new-folder' : 'old-folder')
            if (refreshed && change === 'deleted') return Promise.resolve([])
            return Promise.resolve([
              {
                id: refreshed ? 'new-file' : 'old-file',
                name: 'report.pdf',
                mimeType: 'application/pdf',
                size: refreshed ? '42' : '3',
              },
            ])
          })
          try {
            const accessor = makeAccessor()
            await readdir(accessor, PathSpec.fromStrPath('/drive/docs', 'docs'), index)
            await index.invalidate()
            refreshed = true
            calls.length = 0
            const path = PathSpec.fromStrPath('/drive/docs/report.pdf', 'docs/report.pdf')
            if (change === 'updated') {
              const result = await stat(accessor, path, index)
              expect(result.extra.file_id).toBe('new-file')
              expect(result.size).toBe(42)
            } else
              await expect(stat(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
            expect(calls[0]).toBe('root')
            expect(calls).not.toContain('old-folder')
          } finally {
            await index.clear()
            await index.close()
          }
        },
      )
    },
  )
}

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
      new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
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
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
        index,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports ENOTDIR for an operand under a file', async () => {
    // Listing a file's own id answers with an empty child set rather than an
    // error, so the recursion has to refuse at the file itself or `/a.txt/x`
    // comes back ENOENT where opendir(2) says ENOTDIR.
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts) => {
      if (opts?.folderId === 'root') {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'a.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-04-01T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`should not list folderId=${String(opts?.folderId)}`)
    })

    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({ vfsPath: 'a.txt/x', virtual: '/a.txt/x', directory: '/a.txt/x' }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
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
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
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
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toEqual(['/Team/', '/Team [Shared Drive 2]/', '/Team [Shared Drive]/'])
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
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toContain('/readme.txt')
  })

  it('leaves the root uncached when shared drive enumeration fails', async () => {
    // Caching a short listing would keep the mount My-Drive-only until the
    // entry expires, long after the cause (a missing scope) is fixed. The
    // entries are real, so they stay cached; only the directory listing is
    // withheld, so the next readdir retries enumeration.
    const files = [
      {
        id: 'f1',
        name: 'readme.txt',
        mimeType: 'text/plain',
        modifiedTime: '2026-04-01T00:00:00.000Z',
      },
    ]
    vi.mocked(drive.listFiles).mockResolvedValue(files)
    vi.mocked(drive.listSharedDrives).mockRejectedValue(new Error('no scope'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const root = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
    await readdir(accessor, root, index)
    expect((await index.listDir('/')).entries).toBeUndefined()
    expect((await index.get('/readme.txt')).entry?.id).toBe('f1')

    vi.mocked(drive.listFiles).mockResolvedValue(files)
    vi.mocked(drive.listSharedDrives).mockResolvedValue([{ id: 'drive1', name: 'Team' }])
    const out = await readdir(accessor, root, index)
    expect(out).toContain('/Team/')
    expect((await index.listDir('/')).entries).toBeDefined()
  })

  it.each(['updated', 'deleted'])('revalidates an orphaned root child: %s', async (change) => {
    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    let phase: 'initial' | 'refresh' = 'initial'
    vi.mocked(drive.listFiles).mockImplementation(() => {
      if (phase === 'initial')
        return Promise.resolve([
          { id: 'old-file', name: 'readme.txt', mimeType: 'text/plain', size: '3' },
        ])
      if (change === 'deleted') return Promise.resolve([])
      return Promise.resolve([
        { id: 'new-file', name: 'readme.txt', mimeType: 'text/plain', size: '42' },
      ])
    })
    vi.mocked(drive.listSharedDrives).mockImplementation(() => {
      if (phase === 'initial') return Promise.reject(new Error('missing scope'))
      return Promise.resolve([])
    })
    try {
      const root = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
      await readdir(accessor, root, index)
      expect((await index.listDir('/')).entries).toBeUndefined()
      expect((await index.get('/readme.txt')).entry?.id).toBe('old-file')
      await index.invalidate()
      phase = 'refresh'
      const path = new PathSpec({
        vfsPath: 'readme.txt',
        virtual: '/readme.txt',
        directory: '/',
      })
      if (change === 'updated') {
        const result = await stat(accessor, path, index)
        expect(result.extra.file_id).toBe('new-file')
        expect(result.size).toBe(42)
      } else await expect(stat(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
      const cached = (await index.get('/readme.txt')).entry
      if (change === 'updated') expect(cached?.id).toBe('new-file')
      else expect(cached ?? null).toBeNull()
    } finally {
      await index.clear()
      await index.close()
    }
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
    await readdir(accessor, new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }), index)
    const out = await readdir(
      accessor,
      new PathSpec({
        vfsPath: 'Team Drive',
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

describe('readdir sizes', () => {
  it('keeps Drive size for binaries, moves google-apps source size to extra', async () => {
    vi.mocked(drive.listFiles).mockResolvedValue([
      {
        id: 'f1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-04-01T00:00:00.000Z',
        size: '2048',
      },
      {
        id: 'd1',
        name: 'My Document',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-04-01T00:00:00.000Z',
        quotaBytesUsed: '9999',
      },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(accessor, new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }), index)

    // Binary files download raw: Drive's size is the rendered byte length.
    const binary = (await index.get('/report.pdf')).entry
    expect(binary?.size).toBe(2048)
    // Google-apps files render to JSON: Drive's source size must not
    // become the entry size, it lives in extra only.
    const doc = (await index.get('/My Document.gdoc.json')).entry
    expect(doc?.size).toBeNull()
    expect(doc?.extra.source_size).toBe(9999)
  })
})

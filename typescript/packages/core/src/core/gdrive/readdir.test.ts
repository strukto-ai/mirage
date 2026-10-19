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
import { DirListing, FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { DriveFile } from '../google/drive.ts'
import {
  type StubDrive,
  makeGDriveAccessor,
  stubDrive,
} from '../../../tests/core/gdrive/_test_util.ts'
import { readdir } from './readdir.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DOC_MIME = 'application/vnd.google-apps.document'
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })

let drive: StubDrive

function makeAccessor(): GDriveAccessor {
  return makeGDriveAccessor(drive)
}

function file(
  id: string,
  name: string,
  mimeType = 'text/plain',
  more: Partial<DriveFile> = {},
): DriveFile {
  return { id, name, mimeType, modifiedTime: '2026-04-01T00:00:00.000Z', ...more }
}

function rows(listed: readonly FileStat[] | DirListing): Map<string, FileStat> {
  const found = listed instanceof DirListing ? listed.entries : listed
  return new Map(found.map((row) => [row.name, row]))
}

beforeEach(() => {
  drive = stubDrive()
  drive.listSharedDrives.mockResolvedValue([])
})

// Mirrors python's test_a_stat_after_the_listings_drop_lists_the_ids_again.
describe('a stat after the listings drop', () => {
  it.each(['updated', 'deleted', 'renamed-folder'])('lists the ids again: %s', async (change) => {
    let refreshed = false
    const calls: string[] = []
    drive.listFiles.mockImplementation((options) => {
      const folderId = options.folderId
      calls.push(folderId)
      if (folderId === 'root') {
        if (!refreshed) return Promise.resolve([file('old-folder', 'docs', FOLDER_MIME)])
        const name = change === 'renamed-folder' ? 'renamed' : 'docs'
        return Promise.resolve([file('new-folder', name, FOLDER_MIME)])
      }
      expect(folderId).toBe(refreshed ? 'new-folder' : 'old-folder')
      if (refreshed && change === 'deleted') return Promise.resolve([])
      return Promise.resolve([
        file(refreshed ? 'new-file' : 'old-file', 'report.pdf', 'application/pdf', {
          size: refreshed ? '42' : '3',
        }),
      ])
    })
    const vfs = new GoogleDriveVFS({ clientId: 'x', refreshToken: 'y' })
    Object.assign(vfs, { accessor: makeAccessor() })
    const ws = new Workspace(
      { '/drive/': vfs },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      await ws.dispatch('readdir', '/drive/docs')
      await ws.mount('/drive/').indexStore.invalidate()
      refreshed = true
      calls.length = 0
      if (change === 'updated') {
        const result = (await ws.dispatch('stat', '/drive/docs/report.pdf')) as FileStat
        expect(result.extra.file_id).toBe('new-file')
        expect(result.size).toBe(42)
      } else {
        await expect(ws.dispatch('stat', '/drive/docs/report.pdf')).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
      expect(calls[0]).toBe('root')
      expect(calls).not.toContain('old-folder')
    } finally {
      await ws.close()
    }
  })
})

describe('gdrive readdir', () => {
  it('lists the root', async () => {
    drive.listFiles.mockResolvedValue([file('f1', 'readme.txt')])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    expect(listed.get('readme.txt')?.extra.file_id).toBe('f1')
  })

  it('lists a folder by the id its row names, in its shared drive', async () => {
    drive.listFiles.mockResolvedValue([file('f2', 'notes.txt')])
    const folder = new FileStat({
      name: 'docs',
      type: FileType.DIRECTORY,
      extra: { file_id: 'folder1', drive_id: 'drive1' },
    })
    const listed = rows(
      await readdir(
        makeAccessor(),
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
        folder,
      ),
    )
    expect([...listed.keys()]).toEqual(['notes.txt'])
    expect(drive.listFiles.mock.calls[0]?.[0]).toEqual({
      folderId: 'folder1',
      driveId: 'drive1',
    })
  })

  it('answers ENOENT for nothing', async () => {
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers ENOTDIR under a file', async () => {
    // Listing a file's own id answers with an empty child set rather than an
    // error, so the row has to refuse at the file itself or `/a.txt/x` comes
    // back ENOENT where opendir(2) says ENOTDIR.
    const row = new FileStat({ name: 'a.txt', type: FileType.FILE, extra: { file_id: 'f1' } })
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/a.txt' }),
        row,
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(drive.listFiles).not.toHaveBeenCalled()
  })
})

describe('readdir shared drives', () => {
  it('surfaces shared drives as top-level directories', async () => {
    drive.listFiles.mockResolvedValue([file('f1', 'readme.txt')])
    drive.listSharedDrives.mockResolvedValue([{ id: 'drive1', name: 'Team Drive' }])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    expect(listed.has('readme.txt')).toBe(true)
    expect(listed.get('Team Drive')?.type).toBe(FileType.DIRECTORY)
    expect(listed.get('Team Drive')?.extra.drive_id).toBe('drive1')
  })

  it('uniquifies duplicate shared drive names', async () => {
    drive.listFiles.mockResolvedValue([])
    drive.listSharedDrives.mockResolvedValue([
      { id: 'drive1', name: 'Team' },
      { id: 'drive2', name: 'Team' },
      { id: 'drive3', name: 'Team' },
    ])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    expect([...listed.keys()]).toEqual(['Team', 'Team [Shared Drive 2]', 'Team [Shared Drive]'])
    expect(listed.get('Team')?.extra.file_id).toBe('drive1')
    expect(listed.get('Team [Shared Drive]')?.extra.file_id).toBe('drive2')
    expect(listed.get('Team [Shared Drive 2]')?.extra.file_id).toBe('drive3')
  })

  it('answers a root short of its shared drives as partial', async () => {
    // A short root listing must not be kept as the directory: it would hold
    // the mount My-Drive-only until it expires, long after the cause (a
    // missing scope) is fixed. The rows are real, so they come back as a
    // partial listing, and the next readdir retries enumeration.
    drive.listFiles.mockResolvedValue([file('f1', 'readme.txt')])
    drive.listSharedDrives.mockRejectedValue(new Error('no scope'))
    const short = await readdir(makeAccessor(), ROOT)
    expect(short).toBeInstanceOf(DirListing)
    expect((short as DirListing).partial).toBe(true)
    expect(rows(short).get('readme.txt')?.extra.file_id).toBe('f1')
    drive.listSharedDrives.mockResolvedValue([{ id: 'drive1', name: 'Team' }])
    const full = await readdir(makeAccessor(), ROOT)
    expect(full).not.toBeInstanceOf(DirListing)
    expect(rows(full).has('Team')).toBe(true)
  })

  it('leaves a shared drive root without a token', async () => {
    drive.listFiles.mockResolvedValue([])
    drive.listSharedDrives.mockResolvedValue([{ id: 'drive1', name: 'Team Drive' }])
    const row = rows(await readdir(makeAccessor(), ROOT)).get('Team Drive')
    expect(row?.extra.md5_checksum).toBeUndefined()
    expect(row?.fingerprint).toBeNull()
  })
})

describe('readdir rows', () => {
  it('render google-apps files with their extensions', async () => {
    drive.listFiles.mockResolvedValue([
      file('d1', 'My Document', DOC_MIME),
      file('s1', 'My Sheet', 'application/vnd.google-apps.spreadsheet'),
      file('p1', 'My Slides', 'application/vnd.google-apps.presentation'),
    ])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    expect([...listed.keys()].sort()).toEqual([
      'My Document.gdoc.json',
      'My Sheet.gsheet.json',
      'My Slides.gslide.json',
    ])
  })

  it('keep Drive size for binaries and move google-apps source size to extra', async () => {
    drive.listFiles.mockResolvedValue([
      file('f1', 'report.pdf', 'application/pdf', { size: '2048' }),
      file('d1', 'My Document', DOC_MIME, { quotaBytesUsed: '9999' }),
    ])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    // Binary files download raw: Drive's size is the rendered byte length.
    expect(listed.get('report.pdf')?.size).toBe(2048)
    // Google-apps files render to JSON: Drive's source size must not become
    // the row's size, it lives in extra only.
    const doc = listed.get('My Document.gdoc.json')
    expect(doc?.size).toBeNull()
    expect(doc?.extra.source_size).toBe(9999)
  })

  it.each([
    ['0', 0],
    ['42', 42],
    [undefined, null],
  ])('keep a binary size of %s and never use the quota', async (reported, expected) => {
    drive.listFiles.mockResolvedValue([
      file('binary', 'file.txt', 'text/plain', {
        quotaBytesUsed: '99',
        ...(reported === undefined ? {} : { size: reported }),
      }),
    ])
    const listed = rows(await readdir(makeAccessor(), PathSpec.fromStrPath('/drive', '')))
    expect(listed.get('file.txt')?.size).toBe(expected)
  })

  it('carry both content tokens for a binary file', async () => {
    drive.listFiles.mockResolvedValue([
      file('f1', 'report.pdf', 'application/pdf', {
        size: '2048',
        md5Checksum: '9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e',
        headRevisionId: 'f1-r3',
      }),
    ])
    const row = rows(await readdir(makeAccessor(), ROOT)).get('report.pdf')
    expect(row?.extra.md5_checksum).toBe('9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e')
    expect(row?.extra.head_revision_id).toBe('f1-r3')
    expect(row?.fingerprint).toBe('9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e')
  })

  it('omit what a native file does not have, and keep the drive beside the tokens', async () => {
    drive.listFiles.mockResolvedValue([
      file('f1', 'report.pdf', 'application/pdf', {
        size: '2048',
        driveId: 'drive1',
        md5Checksum: '9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e',
        headRevisionId: 'f1-r3',
      }),
      file('d1', 'My Document', DOC_MIME, { driveId: 'drive1', quotaBytesUsed: '9999' }),
    ])
    const listed = rows(await readdir(makeAccessor(), ROOT))
    const binary = listed.get('report.pdf')
    expect(binary?.extra.drive_id).toBe('drive1')
    expect(binary?.extra.md5_checksum).toBe('9f2b6c1d4e5a7b8c9d0e1f2a3b4c5d6e')
    const native = listed.get('My Document.gdoc.json')
    expect(native?.extra.drive_id).toBe('drive1')
    expect(native?.extra.source_size).toBe(9999)
    expect('md5_checksum' in (native?.extra ?? {})).toBe(false)
    expect('head_revision_id' in (native?.extra ?? {})).toBe(false)
  })
})

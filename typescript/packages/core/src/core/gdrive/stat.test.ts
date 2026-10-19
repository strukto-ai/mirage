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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { GoogleDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DOC_MIME, FakeDrive, makeGDriveAccessor } from '../../../tests/core/gdrive/_test_util.ts'
import { statFromItem } from './readdir.ts'
import { stat } from './stat.ts'

const STAMP = '2026-04-01T00:00:00.000Z'
let fake: FakeDrive
let accessor: GDriveAccessor

beforeEach(() => {
  fake = new FakeDrive()
  accessor = makeGDriveAccessor(fake)
})

async function workspace(): Promise<Workspace> {
  const vfs = new GoogleDriveVFS({ clientId: 'x', refreshToken: 'y' })
  Object.assign(vfs, { accessor })
  return new Workspace(
    { '/drive/': vfs },
    { mode: MountMode.READ, shellParser: await getTestParser() },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gdrive stat', () => {
  it('answers a directory for the mount root', async () => {
    const result = await stat(accessor, new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }))
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.name).toBe('/')
  })

  it('answers the row its parent listed', async () => {
    const row = statFromItem({
      id: 'f1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: '1024',
    })
    const result = await stat(accessor, PathSpec.fromStrPath('/report.pdf'), row)
    expect(result).toBe(row)
    expect(result.size).toBe(1024)
    expect(result.extra.resource_type).toBe('gdrive/file')
  })

  it('answers ENOENT for nothing', async () => {
    await expect(stat(accessor, PathSpec.fromStrPath('/nonexistent.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

// Mirrors python's test_a_cold_stat_lists_its_parent_once and
// test_a_failed_parent_listing_propagates.
describe('gdrive stat through a mount', () => {
  it('lists its parent once when cold', async () => {
    const id = fake.add('fresh.pdf', 'root', undefined, new TextEncoder().encode('xy'))
    const listed = vi.spyOn(fake, 'listFiles')
    const ws = await workspace()
    try {
      const result = (await ws.dispatch('stat', '/drive/fresh.pdf')) as FileStat
      expect(result.extra.file_id).toBe(id)
      expect(result.size).toBe(2)
      expect(listed).toHaveBeenCalledTimes(1)
    } finally {
      await ws.close()
    }
  })

  it('propagates a failed parent listing', async () => {
    vi.spyOn(fake, 'listFiles').mockRejectedValue(new Error('drive unavailable'))
    const ws = await workspace()
    try {
      await expect(ws.dispatch('stat', '/drive/missing.txt')).rejects.toThrow(/drive unavailable/)
    } finally {
      await ws.close()
    }
  })
})

describe('the token a listed row stamps', () => {
  function rowWith(tokens: Record<string, string>, mimeType = 'application/pdf'): FileStat {
    return statFromItem({ id: 'f1', name: 'report', mimeType, modifiedTime: STAMP, ...tokens })
  }

  it('prefers the md5', () => {
    expect(rowWith({ md5Checksum: 'abc', headRevisionId: 'r3' }).fingerprint).toBe('abc')
  })

  it('falls to the head revision when there is no md5', () => {
    expect(rowWith({ headRevisionId: 'r3' }).fingerprint).toBe('r3')
  })

  it('stamps nothing for a file with content and neither token', () => {
    expect(rowWith({}).fingerprint).toBeNull()
  })

  it('stamps a doc by its modified time', () => {
    expect(rowWith({}, DOC_MIME).fingerprint).toBe(STAMP)
  })
})

describe('a Drive item as a row', () => {
  it('renders every kind in full', () => {
    // Each kind's name suffix, size, token and extras.
    const doc = fake.add('Report', 'root', DOC_MIME)
    const folder = fake.folder('d')
    const blob = fake.add('a.bin', 'root', undefined, new TextEncoder().encode('hello'))
    expect(statFromItem(fake.public(doc))).toEqual(
      new FileStat({
        name: 'Report.gdoc.json',
        size: null,
        type: FileType.FILE,
        content: ContentType.JSON,
        modified: '2026-01-01T00:00:00Z',
        fingerprint: '2026-01-01T00:00:00Z',
        extra: {
          file_id: 'id1',
          mime_type: DOC_MIME,
          parents: ['root'],
          resource_type: 'gdrive/gdoc',
        },
      }),
    )
    expect(statFromItem(fake.public(folder))).toEqual(
      new FileStat({
        name: 'd',
        type: FileType.DIRECTORY,
        modified: '2026-01-01T00:00:00Z',
        extra: {
          file_id: 'id2',
          mime_type: 'application/vnd.google-apps.folder',
          parents: ['root'],
        },
      }),
    )
    expect(statFromItem(fake.public(blob))).toEqual(
      new FileStat({
        name: 'a.bin',
        size: 5,
        type: FileType.FILE,
        content: ContentType.BINARY,
        modified: '2026-01-01T00:00:00Z',
        fingerprint: '5d41402abc4b2a76b9719d911017c592',
        extra: {
          file_id: 'id3',
          mime_type: 'application/octet-stream',
          parents: ['root'],
          md5_checksum: '5d41402abc4b2a76b9719d911017c592',
          head_revision_id: 'id3-r1',
          resource_type: 'gdrive/file',
        },
      }),
    )
  })
})

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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return {
    ...actual,
    startPageToken: vi.fn(),
    listChanges: vi.fn(),
    getFile: vi.fn(),
    listFiles: vi.fn(),
    listSharedDrives: vi.fn(),
  }
})

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'
import { FOLDER_MIME, type DriveChange, type DriveFile } from '../google/drive.ts'
import { buildDeltaHook } from './watch.ts'

const ROOT = new PathSpec({
  virtual: '/drive',
  directory: '/drive',
  vfsPath: mountKey('/drive', '/drive'),
})

const FOLDERS: Record<string, DriveFile> = {
  root: { id: 'R', name: 'My Drive' },
  G: { id: 'G', name: 'Sub', parents: ['F'] },
  X: { id: 'X', name: 'Elsewhere' },
  D: { id: 'D', name: 'Drive', driveId: 'D' },
}

function item(
  fileId: string,
  name: string,
  parent: string,
  opts: { mime?: string; created?: string; modified?: string; trashed?: boolean } = {},
): DriveChange {
  return {
    fileId,
    file: {
      id: fileId,
      name,
      mimeType: opts.mime ?? 'text/plain',
      parents: [parent],
      createdTime: opts.created ?? '2020-01-01T00:00:00.000Z',
      modifiedTime: opts.modified ?? '2026-10-01T00:00:00.000Z',
      trashed: opts.trashed ?? false,
    },
  }
}

// Twin of test_changes_are_placed_by_their_parents.
describe('GDriveDeltaHook', () => {
  it('places changes by their parents', async () => {
    const hook = buildDeltaHook(
      new GDriveAccessor({
        tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
      }),
    )
    vi.mocked(drive.startPageToken).mockResolvedValue('1')
    vi.mocked(drive.getFile).mockImplementation((_tm, id) => {
      const found = FOLDERS[id]
      if (found === undefined) throw new Error(`no folder ${id}`)
      return Promise.resolve(found)
    })
    vi.mocked(drive.listFiles).mockResolvedValue([{ id: 'T', name: 'Team', mimeType: FOLDER_MIME }])
    vi.mocked(drive.listSharedDrives).mockResolvedValue([{ id: 'D', name: 'Team' }])
    vi.mocked(drive.listChanges)
      .mockResolvedValueOnce([
        [
          item('F', 'Docs', 'R', { mime: FOLDER_MIME }),
          item('a', 'a.txt', 'F', { created: '2026-10-01T00:00:00.000Z' }),
          item('b', 'b', 'G', { mime: 'application/vnd.google-apps.document' }),
          item('c', 'c.txt', 'X'),
          item('d', 'd.txt', 'D'),
        ],
        '2',
      ])
      .mockResolvedValueOnce([
        [
          item('F', 'Papers', 'R', { mime: FOLDER_MIME }),
          item('a', 'a.txt', 'F', { trashed: true }),
          { changeType: 'drive' },
          { fileId: 'unseen', removed: true },
        ],
        '3',
      ])
    const baseline = await hook.pull(ROOT, null)
    const first = await hook.pull(ROOT, baseline.checkpoint)
    const second = await hook.pull(ROOT, first.checkpoint)
    expect(baseline.changes).toEqual([])
    expect(first.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['update', '/drive/Docs'],
      ['create', '/drive/Docs/a.txt'],
      ['update', '/drive/Docs/Sub/b.gdoc.json'],
      ['update', '/drive/Team [Shared Drive]/d.txt'],
    ])
    expect(second.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['delete', '/drive/Docs'],
      ['create', '/drive/Papers'],
      ['delete', '/drive/Docs/a.txt'],
      ['unknown', '/drive'],
    ])
  })

  async function pulls(
    feed: [DriveChange[], string][],
    rootNames: string[][],
  ): Promise<string[][][]> {
    const hook = buildDeltaHook(
      new GDriveAccessor({
        tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
      }),
    )
    vi.mocked(drive.startPageToken).mockResolvedValue('1')
    vi.mocked(drive.getFile).mockImplementation((_tm, id) => {
      const found = FOLDERS[id]
      if (found === undefined) throw new Error(`no folder ${id}`)
      return Promise.resolve(found)
    })
    const listings = [...rootNames]
    vi.mocked(drive.listFiles).mockImplementation(() =>
      Promise.resolve(
        (listings.shift() ?? []).map((name) => ({ id: name, name, mimeType: FOLDER_MIME })),
      ),
    )
    vi.mocked(drive.listSharedDrives).mockResolvedValue([{ id: 'D', name: 'Team' }])
    const changes = vi.mocked(drive.listChanges).mockReset()
    for (const page of feed) changes.mockResolvedValueOnce(page)
    let delta = await hook.pull(ROOT, null)
    const out: string[][][] = []
    while (out.length < feed.length) {
      delta = await hook.pull(ROOT, delta.checkpoint)
      out.push(delta.changes.map((c) => [c.kind, c.path.virtual]))
    }
    return out
  }

  // Twin of test_a_child_listed_before_its_renamed_folder_lands_in_it.
  it('places a child listed before its renamed folder in that folder', async () => {
    const edited = '2026-10-01T00:00:00.000Z'
    const [first, second] = await pulls(
      [
        [[item('F', 'Docs', 'R', { mime: FOLDER_MIME })], '2'],
        [
          [
            item('c', 'a.txt', 'F', { created: edited, modified: edited }),
            item('F', 'Papers', 'R', { mime: FOLDER_MIME }),
          ],
          '3',
        ],
      ],
      [],
    )
    expect(first).toEqual([['update', '/drive/Docs']])
    expect(second).toEqual([
      ['create', '/drive/Papers/a.txt'],
      ['delete', '/drive/Docs'],
      ['create', '/drive/Papers'],
    ])
  })

  // Twin of test_a_shared_drive_is_named_as_the_root_listing_names_it_now: a My
  // Drive folder named like the drive arrives between two reads, and the root
  // listing renames the drive "Team [Shared Drive]".
  it('names a shared drive as the root listing names it now', async () => {
    const [first, second] = await pulls(
      [
        [[item('d', 'd.txt', 'D')], '2'],
        [[item('d', 'd.txt', 'D')], '3'],
      ],
      [[], ['Team']],
    )
    expect(first).toEqual([['update', '/drive/Team/d.txt']])
    expect(second).toEqual([
      ['delete', '/drive/Team/d.txt'],
      ['create', '/drive/Team [Shared Drive]/d.txt'],
    ])
  })

  // Twin of test_a_folder_taking_anothers_name_keeps_its_own_children: A
  // renamed to Z and B renamed to A in one read, B's child listed first: the
  // child is in the new A, and stays there for the next read.
  it("keeps a child in the folder that took another folder's name", async () => {
    const edited = '2026-10-01T00:00:00.000Z'
    const [, second, third] = await pulls(
      [
        [
          [
            item('A', 'A', 'R', { mime: FOLDER_MIME }),
            item('B', 'B', 'R', { mime: FOLDER_MIME }),
            item('c', 'c.txt', 'B'),
          ],
          '2',
        ],
        [
          [
            item('c', 'c.txt', 'B', { modified: edited }),
            item('A', 'Z', 'R', { mime: FOLDER_MIME }),
            item('B', 'A', 'R', { mime: FOLDER_MIME }),
          ],
          '3',
        ],
        [[item('c', 'c.txt', 'B', { trashed: true })], '4'],
      ],
      [],
    )
    expect(second).toEqual([
      ['delete', '/drive/B/c.txt'],
      ['create', '/drive/A/c.txt'],
      ['delete', '/drive/A'],
      ['create', '/drive/Z'],
      ['delete', '/drive/B'],
      ['create', '/drive/A'],
    ])
    expect(third).toEqual([['delete', '/drive/A/c.txt']])
  })
})

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
import type * as DriveModule from './drive.ts'

vi.mock('./drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('./drive.ts')
  return { ...actual, startPageToken: vi.fn(), listChanges: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { MIME } from '../gdocs/constants.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import type { TokenManager } from './client.ts'
import * as drive from './drive.ts'
import type { DriveChange } from './drive.ts'
import { appDeltaHook } from './events.ts'

const ROOT = new PathSpec({
  virtual: '/gdocs',
  directory: '/gdocs',
  vfsPath: mountKey('/gdocs', '/gdocs'),
})

function doc(
  fileId: string,
  name: string,
  modified: string,
  opts: { created?: string; mime?: string; mine?: boolean; trashed?: boolean } = {},
): DriveChange {
  return {
    fileId,
    file: {
      id: fileId,
      name,
      mimeType: opts.mime ?? MIME,
      createdTime: opts.created ?? '2020-01-01T00:00:00.000Z',
      modifiedTime: modified,
      owners: [{ me: opts.mine ?? true }],
      trashed: opts.trashed ?? false,
    },
  }
}

// Twin of test_changes_place_each_doc_where_the_app_lists_it.
describe('google app delta hook', () => {
  it('places each changed doc where the app lists it', async () => {
    const hook = appDeltaHook(
      new GDocsAccessor({
        tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
      }),
      MIME,
      makeFilename,
    )
    vi.mocked(drive.startPageToken).mockResolvedValue('1')
    vi.mocked(drive.listChanges)
      .mockResolvedValueOnce([
        [
          doc('old', 'Plan', '2026-10-01T09:00:00.000Z'),
          doc('new', 'Notes', '2099-01-01T09:00:00.000Z', {
            created: '2099-01-01T09:00:00.000Z',
            mine: false,
          }),
          doc('sheet', 'Budget', '2026-10-01T09:00:00.000Z', {
            mime: 'application/vnd.google-apps.spreadsheet',
          }),
        ],
        '2',
      ])
      .mockResolvedValueOnce([
        [
          doc('old', 'Plan', '2026-10-02T09:00:00.000Z'),
          doc('new', 'Notes', '2099-01-01T09:00:00.000Z', { trashed: true, mine: false }),
          { fileId: 'gone', removed: true },
        ],
        '3',
      ])
    const baseline = await hook.pull(ROOT, null)
    const first = await hook.pull(ROOT, baseline.checkpoint)
    const second = await hook.pull(ROOT, first.checkpoint)
    expect(baseline.changes).toEqual([])
    expect(first.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['update', '/gdocs/owned/2026-10-01_Plan__old.gdoc.json'],
      ['create', '/gdocs/shared/2099-01-01_Notes__new.gdoc.json'],
    ])
    expect(second.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['delete', '/gdocs/owned/2026-10-01_Plan__old.gdoc.json'],
      ['create', '/gdocs/owned/2026-10-02_Plan__old.gdoc.json'],
      ['delete', '/gdocs/shared/2099-01-01_Notes__new.gdoc.json'],
    ])
  })
})

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
  return { ...actual, listAllFiles: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { readdir } from '../gdocs/readdir.ts'
import { stat } from '../gdocs/stat.ts'
import type { TokenManager } from './client.ts'
import * as drive from './drive.ts'
import { appDeltaHook } from './watch.ts'

const ROOT = new PathSpec({
  virtual: '/gdocs',
  directory: '/gdocs',
  vfsPath: mountKey('/gdocs', '/gdocs'),
})

function listing(
  modified: string,
  complete = true,
): Awaited<ReturnType<typeof drive.listAllFiles>> {
  return {
    files: [{ id: 'doc1', name: 'Plan', modifiedTime: modified, owners: [{ me: true }] }],
    complete,
  }
}

describe('google app delta hook', () => {
  it('reads an edit as an update and refuses an unfinished listing', async () => {
    const hook = appDeltaHook(
      new GDocsAccessor({
        tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
      }),
      readdir,
      stat,
    )
    vi.mocked(drive.listAllFiles)
      .mockResolvedValueOnce(listing('2026-10-01T09:00:00.000Z'))
      .mockResolvedValueOnce(listing('2026-10-01T09:00:00.000Z'))
      .mockResolvedValueOnce(listing('2026-10-01T10:00:00.000Z'))
      .mockResolvedValueOnce(listing('2026-10-01T10:00:00.000Z'))
      .mockResolvedValueOnce(listing('2026-10-01T11:00:00.000Z', false))
    const baseline = await hook.pull(ROOT, null)
    const changed = await hook.pull(ROOT, baseline.checkpoint)
    await expect(hook.pull(ROOT, changed.checkpoint)).rejects.toMatchObject({ code: 'EIO' })
    expect(baseline.changes).toEqual([])
    expect(changed.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['update', '/gdocs/owned/2026-10-01_Plan__doc1.gdoc.json'],
    ])
  })
})

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
  return { ...actual, getFile: vi.fn(), patchFile: vi.fn(), listAllFiles: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { rename } from '../gdocs/rename.ts'
import type { TokenManager } from './client.ts'
import * as drive from './drive.ts'
import { appTitle } from './rename.ts'

const MODIFIED = '2026-10-01T09:00:00.000Z'
const OLD = '2026-10-01_Old_Plan__doc1.gdoc.json'
const NEW = '2026-10-01_New_Plan__doc1.gdoc.json'

const accessor = new GDocsAccessor({
  tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
})

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/gdocs') })
}

async function renamed(dst: string): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  const entry = new IndexEntry({
    id: 'doc1',
    name: 'Old Plan',
    resourceType: 'gdocs/file',
    remoteTime: MODIFIED,
    vfsName: OLD,
  })
  await index.setDir('/gdocs/owned', [[OLD, entry]])
  vi.mocked(drive.getFile).mockResolvedValueOnce({
    id: 'doc1',
    name: 'Old Plan',
    modifiedTime: MODIFIED,
  })
  vi.mocked(drive.patchFile).mockClear()
  await rename(accessor, spec(`/gdocs/owned/${OLD}`), spec(dst), index)
  return index
}

describe('appTitle', () => {
  it.each<[string, string | null]>([
    [NEW, 'New_Plan'],
    ['2026-09-30_New__doc1.gdoc.json', null],
    ['2026-10-01_New__doc2.gdoc.json', null],
    ['2026-10-01_New Plan__doc1.gdoc.json', null],
  ])('gives %s the title %s', (name, title) => {
    expect(appTitle(name, 'doc1', MODIFIED, '.gdoc.json')).toBe(title)
  })
})

describe('google app rename', () => {
  it('sets the title and keeps the modified time', async () => {
    const index = await renamed(`/gdocs/owned/${NEW}`)
    expect(vi.mocked(drive.patchFile).mock.lastCall?.slice(1)).toEqual([
      'doc1',
      { body: { name: 'New_Plan', modifiedTime: MODIFIED } },
    ])
    expect((await index.listDir('/gdocs/owned')).entries).toBeUndefined()
  })

  it.each(['/gdocs/owned/New_Plan.gdoc.json', `/gdocs/shared/${NEW}`])(
    'refuses %s with EPERM',
    async (dst) => {
      await expect(renamed(dst)).rejects.toMatchObject({ code: 'EPERM' })
      expect(vi.mocked(drive.patchFile)).not.toHaveBeenCalled()
    },
  )
})

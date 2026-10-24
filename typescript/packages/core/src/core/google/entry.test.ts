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

import { runInCommandScope } from '../../cache/index/scope.ts'
import { describe, expect, it } from 'vitest'
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { detectScope } from '../gdocs/scope.ts'
import { GoogleApiError, TokenManager } from './client.ts'
import type { DriveFile } from './drive.ts'
import { resolveAppEntry } from './entry.ts'
import { stubDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { installApi } from '../../../tests/core/google/_test_util.ts'

const ITEM = {
  id: 'doc1',
  name: 'Notes',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-04-01T12:00:00Z',
  owners: [{ me: true }],
  size: '1000',
}
const NAME = makeFilename(ITEM.name, ITEM.id, ITEM.modifiedTime)
const PATH = new PathSpec({
  virtual: `/docs/owned/${NAME}`,
  directory: `/docs/owned/${NAME}`,
  vfsPath: `owned/${NAME}`,
})
const TM = new TokenManager({ accessToken: 't' })

describe('a direct lookup proves the file', () => {
  it.each([
    'updated',
    'renamed',
    'date',
    'trashed',
    'mime',
    'owner',
    'deleted',
    'forbidden',
    'unavailable',
  ])('%s', async (outcome) => {
    const drive = stubDrive()
    const item: DriveFile = { ...ITEM }
    if (outcome === 'renamed') item.name = 'Renamed'
    if (outcome === 'date') item.modifiedTime = '2026-04-02T12:00:00Z'
    if (outcome === 'trashed') item.trashed = true
    if (outcome === 'mime') item.mimeType = 'text/plain'
    if (outcome === 'owner') item.owners = []
    const statuses: Record<string, number> = { deleted: 404, forbidden: 403, unavailable: 503 }
    const status = statuses[outcome]
    const error = status === undefined ? null : new GoogleApiError('failed', status)
    if (error) drive.getFile.mockRejectedValue(error)
    else drive.getFile.mockResolvedValue(item)
    const result = resolveAppEntry(drive, detectScope(PATH), PATH, ITEM.mimeType, makeFilename)
    if (outcome === 'updated') {
      const row = await result
      expect(row.modified).toBe(ITEM.modifiedTime)
      expect(row.size).toBeNull()
      expect(row.extra).toEqual({ doc_id: 'doc1', doc_name: 'Notes', source_size: 1000 })
    } else if (outcome === 'forbidden' || outcome === 'unavailable') {
      await expect(result).rejects.toBe(error)
    } else {
      await expect(result).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(drive.getFile).toHaveBeenCalledExactlyOnceWith('doc1')
  })
})

describe('only a complete listing proves absence', () => {
  it.each([true, false])('complete %s', async (complete) => {
    const drive = stubDrive()
    drive.getFile.mockResolvedValue(ITEM)
    drive.listAllFiles.mockResolvedValue({ files: [], complete })
    installApi({ drive })
    const vfs = Object.assign(
      new GDocsVFS({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' }),
      { accessor: new GDocsAccessor({ tokenManager: TM }) },
    )
    const ws = new Workspace({ '/docs/': vfs })
    // One command lists and stats, so its own complete listing is proof.
    await runInCommandScope(async () => {
      await ws.dispatch('readdir', '/docs/owned')
      const stat = ws.dispatch('stat', PATH.virtual) as Promise<FileStat>
      if (complete) {
        await expect(stat).rejects.toMatchObject({ code: 'ENOENT' })
        expect(drive.getFile).not.toHaveBeenCalled()
      } else {
        expect((await stat).extra.doc_id).toBe(ITEM.id)
        expect(drive.getFile).toHaveBeenCalledExactlyOnceWith('doc1')
      }
    })
  })
})

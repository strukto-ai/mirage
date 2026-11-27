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

import { commandScope } from '../../cache/index/scope.ts'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { detectScope } from '../gdocs/scope.ts'
import { GoogleApiError } from './client.ts'
import { resolveAppEntry } from './entry.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { FILE, FILES, GoogleAccount, UNTIL_CLEARED } from '../../../tests/core/google/account.ts'

const MIME = 'application/vnd.google-apps.document'
const MODIFIED = '2026-04-01T12:00:00.000Z'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

/** A doc named Notes stamped `MODIFIED`: its id, its name on the mount and its path. */
async function notes(): Promise<[string, string, PathSpec]> {
  const made = await account.create('Notes', MIME)
  await account.patch(made, { modifiedTime: MODIFIED })
  const name = makeFilename('Notes', made, MODIFIED)
  const path = new PathSpec({
    virtual: `/docs/owned/${name}`,
    directory: `/docs/owned/${name}`,
    vfsPath: `owned/${name}`,
  })
  return [made, name, path]
}

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
    const [made, , path] = await notes()
    const item = await account.item(made)
    // Drive's own answer with the source size it gives a native file, which
    // the fake keeps none of.
    if (outcome === 'updated')
      await account.run.answerNext('GET', FILE, 200, { ...item, size: '1000' })
    if (outcome === 'renamed') await account.patch(made, { name: 'Renamed' })
    if (outcome === 'date') await account.patch(made, { modifiedTime: '2026-04-02T12:00:00Z' })
    if (outcome === 'trashed') await account.patch(made, { trashed: true })
    if (outcome === 'mime') {
      await account.run.answerNext('GET', FILE, 200, { ...item, mimeType: 'text/plain' })
    }
    // Shared with the account by another: Drive names no owner it is.
    if (outcome === 'owner') await account.run.answerNext('GET', FILE, 200, { ...item, owners: [] })
    if (outcome === 'deleted') await account.delete(made)
    if (outcome === 'forbidden') await account.refuse('GET', FILE, 403, 'forbidden')
    if (outcome === 'unavailable') {
      await account.refuse('GET', FILE, 503, 'unavailable', {
        reason: 'backendError',
        times: UNTIL_CLEARED,
      })
    }
    const drive = account.driveAccessor(new ManualClock()).drive
    await account.run.recordRequests()
    const result = resolveAppEntry(drive, detectScope(path), path, MIME, makeFilename)
    if (outcome === 'updated') {
      const row = await result
      expect(row.modified).toBe(MODIFIED)
      expect(row.size).toBeNull()
      expect(row.extra).toEqual({ doc_id: made, doc_name: 'Notes', source_size: 1000 })
    } else if (outcome === 'forbidden' || outcome === 'unavailable') {
      await expect(result).rejects.toBeInstanceOf(GoogleApiError)
      await expect(result).rejects.toMatchObject({ message: outcome })
    } else {
      await expect(result).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const asked = await account.log()
    expect(new Set(asked.map(([name, d]) => `${name} ${d}`))).toEqual(new Set([`get ${made}`]))
    if (outcome !== 'unavailable') expect(asked).toHaveLength(1)
  })
})

describe('only a complete listing proves absence', () => {
  it.each([true, false])('complete %s', async (complete) => {
    const [made, , path] = await notes()
    // Drive answers no doc: proof of absence only when it finished.
    await account.run.answerNext('GET', FILES, 200, { files: [], incompleteSearch: !complete })
    const vfs = Object.assign(new GDocsVFS(account.config()), {
      accessor: new GDocsAccessor({ tokenManager: account.tokenManager() }),
    })
    const ws = new Workspace({ '/docs/': vfs })
    await account.run.recordRequests()
    // One command lists and stats, so its own complete listing is proof.
    await commandScope(async () => {
      await ws.dispatch('readdir', '/docs/owned')
      const stat = ws.dispatch('stat', path.virtual) as Promise<FileStat>
      const gets = async (): Promise<string[]> =>
        (await account.log()).filter(([name]) => name === 'get').map(([, d]) => d)
      if (complete) {
        await expect(stat).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await gets()).toEqual([])
      } else {
        expect((await stat).extra.doc_id).toBe(made)
        expect(await gets()).toEqual([made])
      }
    })
  })
})

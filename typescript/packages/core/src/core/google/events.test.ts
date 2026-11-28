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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { MIME } from '../gdocs/constants.ts'
import { makeFilename } from '../../vfs/gdocs/doc_entry.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { appDeltaHook } from './events.ts'

const ROOT = new PathSpec({
  virtual: '/gdocs',
  directory: '/gdocs',
  vfsPath: mountKey('/gdocs', '/gdocs'),
})
const CHANGES = '/drive/v3/changes'
const SHEET = 'application/vnd.google-apps.spreadsheet'
const FIRST = '2026-10-01T09:00:00.000Z'
const SECOND = '2026-10-02T09:00:00.000Z'

interface Change {
  [key: string]: JsonValue
  fileId: string
}

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

async function pageToken(): Promise<string> {
  return (await account.run.call<{ startPageToken: string }>('GET', `${CHANGES}/startPageToken`))
    .startPageToken
}

/**
 * Answer the next change read with the fake's own page, the doc `shared` in
 * it owned by another: every file the fake holds is the account's own, and
 * Drive names another owner for one shared with it.
 */
async function sharedIn(since: string, shared: string): Promise<void> {
  const page = await account.run.call<{ [key: string]: JsonValue; changes: Change[] }>(
    'GET',
    `${CHANGES}?pageToken=${since}`,
  )
  for (const change of page.changes) {
    const file = change.file
    if (change.fileId === shared && file !== undefined && file !== null && !Array.isArray(file)) {
      ;(file as Record<string, JsonValue>).owners = [{ me: false }]
    }
  }
  await account.run.answerNext('GET', CHANGES, 200, page)
}

// Twin of test_changes_place_each_doc_where_the_app_lists_it.
describe('google app delta hook', () => {
  it('places each changed doc where the app lists it', async () => {
    const old = await account.create('Plan', MIME)
    const sheet = await account.create('Budget', SHEET)
    const hook = appDeltaHook(
      new GDocsAccessor({ tokenManager: account.tokenManager() }),
      MIME,
      makeFilename,
    )
    const baseline = await hook.pull(ROOT, null)

    let since = await pageToken()
    await account.patch(old, { modifiedTime: FIRST })
    const fresh = await account.create('Notes', MIME)
    await account.patch(sheet, { modifiedTime: FIRST })
    const made = (await account.item(fresh)).modifiedTime
    await sharedIn(since, fresh)
    const first = await hook.pull(ROOT, baseline.checkpoint)

    since = await pageToken()
    await account.patch(old, { modifiedTime: SECOND })
    await account.patch(fresh, { trashed: true, modifiedTime: made })
    await account.delete(await account.create('Gone', MIME))
    await sharedIn(since, fresh)
    const second = await hook.pull(ROOT, first.checkpoint)

    const notes = `/gdocs/shared/${makeFilename('Notes', fresh, made)}`
    expect(baseline.changes).toEqual([])
    expect(first.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['update', `/gdocs/owned/${makeFilename('Plan', old, FIRST)}`],
      ['create', notes],
    ])
    expect(second.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      ['delete', `/gdocs/owned/${makeFilename('Plan', old, FIRST)}`],
      ['create', `/gdocs/owned/${makeFilename('Plan', old, SECOND)}`],
      ['delete', notes],
    ])
  })
})

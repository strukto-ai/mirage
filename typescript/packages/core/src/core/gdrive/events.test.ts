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
import { PathSpec, type Delta } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { FILE, FILES, GoogleAccount } from '../../../tests/core/google/account.ts'
import { buildDeltaHook } from './events.ts'

const ROOT = new PathSpec({
  virtual: '/drive',
  directory: '/drive',
  vfsPath: mountKey('/drive', '/drive'),
})
const CHANGES = '/drive/v3/changes'
const DOC_MIME = 'application/vnd.google-apps.document'
// Stamped on an item to change it: an item whose modified time is no longer
// its creation time is an update, never a create.
const EDITED = '2030-01-01T00:00:00.000Z'
const EDITED_AGAIN = '2030-01-02T00:00:00.000Z'

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

function kinds(delta: Delta): string[][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

async function pageToken(): Promise<string> {
  return (await account.run.call<{ startPageToken: string }>('GET', `${CHANGES}/startPageToken`))
    .startPageToken
}

// Twin of test_changes_are_placed_by_their_parents.
describe('GDriveDeltaHook', () => {
  it('places changes by their parents', async () => {
    const docs = await account.folder('Docs')
    const sub = await account.folder('Sub', docs)
    const doc = await account.create('b', DOC_MIME, sub)
    const elsewhere = await account.folder('Elsewhere')
    const stray = await account.upload('c.txt', 'c', elsewhere)
    // A My Drive folder takes the shared drive's name in the root listing.
    await account.folder('Team')
    const drive = await account.sharedDrive('Team')
    const inDrive = await account.upload('d.txt', 'd', drive)
    const hook = buildDeltaHook(account.driveAccessor())
    const baseline = await hook.pull(ROOT, null)

    await account.patch(docs, { modifiedTime: EDITED })
    const made = await account.upload('a.txt', 'a', docs)
    for (const id of [doc, stray, inDrive]) await account.patch(id, { modifiedTime: EDITED })
    // A folder shared with the account rather than kept in its Drive: Drive
    // names no parent for it, so nothing in it is on the mount.
    const shared: Record<string, JsonValue> = { ...(await account.item(elsewhere)) }
    delete shared.parents
    await account.run.answerNext('GET', FILE, 200, shared, 1, `${FILES}/${elsewhere}`)
    const first = await hook.pull(ROOT, baseline.checkpoint)

    const afterFirst = await pageToken()
    await account.patch(docs, { name: 'Papers', modifiedTime: EDITED_AGAIN })
    await account.patch(made, { trashed: true })
    await account.delete(await account.upload('unseen.txt', 'u'))
    // The shared drive itself changed: the fake's feed names files only, so
    // its own page is answered with Drive's drive change added.
    const page = await account.run.call<{ [key: string]: JsonValue; changes: JsonValue[] }>(
      'GET',
      `${CHANGES}?pageToken=${afterFirst}`,
    )
    page.changes.push({ kind: 'drive#change', changeType: 'drive', driveId: drive })
    await account.run.answerNext('GET', CHANGES, 200, page)
    const second = await hook.pull(ROOT, first.checkpoint)

    expect(baseline.changes).toEqual([])
    expect(kinds(first)).toEqual([
      ['update', '/drive/Docs'],
      ['create', '/drive/Docs/a.txt'],
      ['update', '/drive/Docs/Sub/b.gdoc.json'],
      ['update', '/drive/Team [Shared Drive]/d.txt'],
    ])
    expect(kinds(second)).toEqual([
      ['delete', '/drive/Docs'],
      ['create', '/drive/Papers'],
      ['delete', '/drive/Docs/a.txt'],
      ['unknown', '/drive'],
    ])
  })

  // Twin of test_a_child_listed_before_its_renamed_folder_lands_in_it.
  it('places a child listed before its renamed folder in that folder', async () => {
    const docs = await account.folder('Docs')
    const hook = buildDeltaHook(account.driveAccessor())
    const baseline = await hook.pull(ROOT, null)
    await account.patch(docs, { modifiedTime: EDITED })
    const first = await hook.pull(ROOT, baseline.checkpoint)
    // The new file is listed before the rename of the folder it is in.
    await account.upload('a.txt', 'a', docs)
    await account.patch(docs, { name: 'Papers', modifiedTime: EDITED_AGAIN })
    const second = await hook.pull(ROOT, first.checkpoint)
    expect(kinds(first)).toEqual([['update', '/drive/Docs']])
    expect(kinds(second)).toEqual([
      ['create', '/drive/Papers/a.txt'],
      ['delete', '/drive/Docs'],
      ['create', '/drive/Papers'],
    ])
  })

  // Twin of test_a_shared_drive_is_named_as_the_root_listing_names_it_now: a My
  // Drive folder named like the drive arrives between two reads, and the root
  // listing renames the drive "Team [Shared Drive]".
  it('names a shared drive as the root listing names it now', async () => {
    const drive = await account.sharedDrive('Team')
    const inDrive = await account.upload('d.txt', 'd', drive)
    const hook = buildDeltaHook(account.driveAccessor())
    const baseline = await hook.pull(ROOT, null)
    await account.patch(inDrive, { modifiedTime: EDITED })
    const first = await hook.pull(ROOT, baseline.checkpoint)
    await account.folder('Team')
    await account.patch(inDrive, { modifiedTime: EDITED_AGAIN })
    const second = await hook.pull(ROOT, first.checkpoint)
    expect(kinds(first)).toEqual([['update', '/drive/Team/d.txt']])
    expect(kinds(second)).toEqual([
      ['create', '/drive/Team'],
      ['delete', '/drive/Team/d.txt'],
      ['create', '/drive/Team [Shared Drive]/d.txt'],
    ])
  })

  // Twin of test_a_folder_taking_anothers_name_keeps_its_own_children: A
  // renamed to Z and B renamed to A in one read, B's child listed first: the
  // child is in the new A, and stays there for the next read.
  it("keeps a child in the folder that took another folder's name", async () => {
    const firstFolder = await account.folder('A')
    const secondFolder = await account.folder('B')
    const child = await account.upload('c.txt', 'c', secondFolder)
    const hook = buildDeltaHook(account.driveAccessor())
    const baseline = await hook.pull(ROOT, null)
    for (const id of [firstFolder, secondFolder, child]) {
      await account.patch(id, { modifiedTime: EDITED })
    }
    const first = await hook.pull(ROOT, baseline.checkpoint)
    await account.patch(child, { modifiedTime: EDITED_AGAIN })
    await account.patch(firstFolder, { name: 'Z', modifiedTime: EDITED_AGAIN })
    await account.patch(secondFolder, { name: 'A', modifiedTime: EDITED_AGAIN })
    const second = await hook.pull(ROOT, first.checkpoint)
    await account.patch(child, { trashed: true })
    const third = await hook.pull(ROOT, second.checkpoint)
    expect(kinds(second)).toEqual([
      ['delete', '/drive/B/c.txt'],
      ['create', '/drive/A/c.txt'],
      ['delete', '/drive/A'],
      ['create', '/drive/Z'],
      ['delete', '/drive/B'],
      ['create', '/drive/A'],
    ])
    expect(kinds(third)).toEqual([['delete', '/drive/A/c.txt']])
  })
})

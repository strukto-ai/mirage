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

import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { FileChangeKind, PathSpec } from '../../types.ts'
import type { Delta } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount, HISTORY } from '../../../tests/core/google/account.ts'
import { buildDeltaHook } from './events.ts'

const ROOT = PathSpec.fromStrPath('/gmail', '')
const JAN_5 = 'Mon, 5 Jan 2026 09:00:00 +0000'
const JAN_6 = 'Tue, 6 Jan 2026 09:00:00 +0000'
const JAN_7 = 'Wed, 7 Jan 2026 09:00:00 +0000'
const JAN_8 = 'Thu, 8 Jan 2026 09:00:00 +0000'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

// The account with Gmail's system labels and no message yet.
beforeEach(async () => {
  account = new GoogleAccount(origin)
  await account.reset()
})

afterEach(async () => {
  await account.run.close()
})

function pairs(delta: Delta): [string, string][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

// Twin of test_events_follow_each_message_s_labels.
it("follows each message's labels", async () => {
  const a1 = await account.message('Budget review', 'numbers for travel', {
    sender: 'Ana Lima <ana@example.com>',
    date: JAN_5,
    attachments: [['plan.txt', 'text/plain', 'plan\n']],
  })
  // A message no pull names before it goes.
  const z9 = await account.message('Gone', 'soon', { date: JAN_6 })
  const hook = buildDeltaHook(account.gmailAccessor())
  const baseline = await hook.pull(ROOT, null)
  expect(baseline.changes).toEqual([])
  await account.trash(a1)
  const n3 = await account.message('Hi', 'hey', { sender: 'Cy <cy@example.com>', date: JAN_7 })
  await account.deleteMessage(z9)
  const moved = await hook.pull(ROOT, baseline.checkpoint)
  const old = '/gmail/INBOX/2026-01-05'
  const now = '/gmail/TRASH/2026-01-05'
  expect(pairs(moved)).toEqual([
    [FileChangeKind.DELETE, `${old}/Budget_review__${a1}.gmail.json`],
    [FileChangeKind.DELETE, `${old}/Budget_review__${a1}`],
    [FileChangeKind.CREATE, `${now}/Budget_review__${a1}.gmail.json`],
    [FileChangeKind.CREATE, `${now}/Budget_review__${a1}`],
    [FileChangeKind.CREATE, `/gmail/INBOX/2026-01-07/Hi__${n3}.gmail.json`],
    [FileChangeKind.UNKNOWN, '/gmail'],
  ])
  // A message a pull has seen leaves the paths it was when it goes.
  await account.deleteMessage(a1)
  const deleted = await hook.pull(ROOT, moved.checkpoint)
  expect(pairs(deleted)).toEqual([
    [FileChangeKind.DELETE, `${now}/Budget_review__${a1}.gmail.json`],
    [FileChangeKind.DELETE, `${now}/Budget_review__${a1}`],
  ])
  // A history id Gmail no longer keeps reinventories the root, from the one
  // the mailbox is at now.
  await account.message('Later', 'after', { date: JAN_8 })
  await account.refuse('GET', HISTORY, 404, 'Requested entity was not found.', {
    reason: 'notFound',
  })
  const lost = await hook.pull(ROOT, deleted.checkpoint)
  expect(pairs(lost)).toEqual([[FileChangeKind.UNKNOWN, '/gmail']])
  const at = await account.historyId()
  expect(lost.checkpoint).toContain(`"history":"${at}"`)
  expect(deleted.checkpoint).not.toContain(`"history":"${at}"`)
})

// Twin of test_events_follow_the_label_folders: history records no label
// created, renamed or deleted, so each pull compares the folders, and a message
// below a renamed one moves with it.
it('follows the label folders', async () => {
  const work = await account.label('Work')
  const hook = buildDeltaHook(account.gmailAccessor())
  const baseline = await hook.pull(ROOT, null)
  const w1 = await account.message('Plan', 'go', {
    labels: ['Work'],
    sender: 'Di <di@example.com>',
    date: JAN_8,
  })
  const seen = await hook.pull(ROOT, baseline.checkpoint)
  const plan = `2026-01-08/Plan__${w1}.gmail.json`
  expect(pairs(seen)).toEqual([[FileChangeKind.CREATE, `/gmail/Work/${plan}`]])
  await account.renameLabel(work, 'Projects')
  const empty = await account.label('Empty')
  await account.modify(w1, ['INBOX'])
  const renamed = await hook.pull(ROOT, seen.checkpoint)
  expect(pairs(renamed)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Work'],
    [FileChangeKind.CREATE, '/gmail/Projects'],
    [FileChangeKind.CREATE, '/gmail/Empty'],
    [FileChangeKind.CREATE, `/gmail/INBOX/${plan}`],
    [FileChangeKind.UPDATE, `/gmail/Projects/${plan}`],
  ])
  // One label takes the name another gives up: each path moves once.
  await account.renameLabel(empty, 'Archive')
  await account.renameLabel(work, 'Empty')
  await account.deleteMessage(w1)
  const swapped = await hook.pull(ROOT, renamed.checkpoint)
  expect(pairs(swapped)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Projects'],
    [FileChangeKind.DELETE, '/gmail/Empty'],
    [FileChangeKind.CREATE, '/gmail/Empty'],
    [FileChangeKind.CREATE, '/gmail/Archive'],
    [FileChangeKind.DELETE, `/gmail/Empty/${plan}`],
    [FileChangeKind.DELETE, `/gmail/INBOX/${plan}`],
  ])
  await account.deleteLabel(work)
  await account.deleteLabel(empty)
  const removed = await hook.pull(ROOT, swapped.checkpoint)
  expect(pairs(removed)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Empty'],
    [FileChangeKind.DELETE, '/gmail/Archive'],
  ])
})

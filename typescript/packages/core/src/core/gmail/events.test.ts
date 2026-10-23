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

import { expect, it } from 'vitest'

const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'TRASH', name: 'TRASH', type: 'system' },
  { id: 'Label_1', name: 'Work', type: 'user' },
]

const box = {
  history: new Map<string, unknown>(),
  now: '100',
  messages: new Map<string, unknown>(),
  LABELS,
  labels: LABELS,
}

/** Gmail's history and messages, scripted per pull. Mirrors Python's `Mailbox`. */
const MAILBOX: GmailApi = {
  currentHistoryId: () => Promise.resolve(box.now),
  listHistory: (start: string) => {
    const answer = box.history.get(start)
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer as [Record<string, unknown>[], string])
  },
  listMessages: () => Promise.reject(new Error('the test Mailbox lists no messages')),
  getAttachment: () => Promise.reject(new Error('the test Mailbox holds no attachments')),
  listLabels: () => Promise.resolve(box.labels),
  getMessageRaw: (id: string) => Promise.resolve(box.messages.get(id) as GmailMessageRaw),
}

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { GmailApi } from './api.ts'
import type { GmailMessageRaw } from './messages.ts'
import { FileChangeKind, PathSpec } from '../../types.ts'
import type { Delta } from '../../types.ts'
import { buildDeltaHook } from './events.ts'

const ROOT = PathSpec.fromStrPath('/gmail', '')

function message(
  mid: string,
  labelIds: string[],
  day: string,
  subject: string,
  attachment = '',
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ mimeType: 'text/plain', body: { data: '' } }]
  if (attachment !== '') {
    parts.push({
      filename: attachment,
      mimeType: 'text/plain',
      body: { attachmentId: `A${mid}`, size: 5 },
    })
  }
  return {
    id: mid,
    threadId: mid,
    labelIds,
    internalDate: String(Date.parse(`${day}T09:00:00Z`)),
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: subject }], parts },
  }
}

function pairs(delta: Delta): [string, string][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

// Twin of test_events_follow_each_message_s_labels.
it("follows each message's labels", async () => {
  box.messages.set('a1', message('a1', ['TRASH'], '2026-01-05', 'Budget review', 'plan.txt'))
  box.messages.set('n3', message('n3', ['INBOX'], '2026-01-07', 'Hi'))
  const hook = buildDeltaHook({ gmail: MAILBOX } as unknown as GmailAccessor)
  const baseline = await hook.pull(ROOT, null)
  expect(baseline.changes).toEqual([])
  box.history.set('100', [
    [
      { labelsAdded: [{ message: { id: 'a1' }, labelIds: ['TRASH'] }] },
      { labelsRemoved: [{ message: { id: 'a1' }, labelIds: ['INBOX'] }] },
      { messagesAdded: [{ message: { id: 'n3' } }] },
      { messagesDeleted: [{ message: { id: 'z9' } }] },
    ],
    '120',
  ])
  const moved = await hook.pull(ROOT, baseline.checkpoint)
  const old = '/gmail/INBOX/2026-01-05'
  const now = '/gmail/TRASH/2026-01-05'
  expect(pairs(moved)).toEqual([
    [FileChangeKind.DELETE, `${old}/Budget_review__a1.gmail.json`],
    [FileChangeKind.DELETE, `${old}/Budget_review__a1`],
    [FileChangeKind.CREATE, `${now}/Budget_review__a1.gmail.json`],
    [FileChangeKind.CREATE, `${now}/Budget_review__a1`],
    [FileChangeKind.CREATE, '/gmail/INBOX/2026-01-07/Hi__n3.gmail.json'],
    [FileChangeKind.UNKNOWN, '/gmail'],
  ])
  // A message a pull has seen leaves the paths it was when it goes.
  box.history.set('120', [[{ messagesDeleted: [{ message: { id: 'a1' } }] }], '130'])
  const deleted = await hook.pull(ROOT, moved.checkpoint)
  expect(pairs(deleted)).toEqual([
    [FileChangeKind.DELETE, `${now}/Budget_review__a1.gmail.json`],
    [FileChangeKind.DELETE, `${now}/Budget_review__a1`],
  ])
  // A history id Gmail no longer keeps reinventories the root.
  box.history.set('130', Object.assign(new Error('gone'), { status: 404 }))
  box.now = '200'
  const lost = await hook.pull(ROOT, deleted.checkpoint)
  expect(pairs(lost)).toEqual([[FileChangeKind.UNKNOWN, '/gmail']])
  expect(lost.checkpoint).toContain('"history":"200"')
})

// Twin of test_events_follow_the_label_folders: history records no label
// created, renamed or deleted, so each pull compares the folders, and a message
// below a renamed one moves with it.
it('follows the label folders', async () => {
  box.labels = box.LABELS
  const work = message('w1', ['Label_1'], '2026-01-08', 'Plan')
  box.messages.set('w1', work)
  const hook = buildDeltaHook({ gmail: MAILBOX } as unknown as GmailAccessor)
  const baseline = await hook.pull(ROOT, null)
  box.history.set(box.now, [[{ messagesAdded: [{ message: { id: 'w1' } }] }], '110'])
  const seen = await hook.pull(ROOT, baseline.checkpoint)
  const plan = '2026-01-08/Plan__w1.gmail.json'
  expect(pairs(seen)).toEqual([[FileChangeKind.CREATE, `/gmail/Work/${plan}`]])
  box.labels = [
    ...box.LABELS.slice(0, 2),
    { id: 'Label_1', name: 'Projects', type: 'user' },
    { id: 'Label_2', name: 'Empty', type: 'user' },
  ]
  box.messages.set('w1', { ...work, labelIds: ['Label_1', 'INBOX'] })
  box.history.set('110', [
    [{ labelsAdded: [{ message: { id: 'w1' }, labelIds: ['INBOX'] }] }],
    '120',
  ])
  const renamed = await hook.pull(ROOT, seen.checkpoint)
  expect(pairs(renamed)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Work'],
    [FileChangeKind.CREATE, '/gmail/Projects'],
    [FileChangeKind.CREATE, '/gmail/Empty'],
    [FileChangeKind.CREATE, `/gmail/INBOX/${plan}`],
    [FileChangeKind.UPDATE, `/gmail/Projects/${plan}`],
  ])
  // One label takes the name another gives up: each path moves once.
  box.labels = [
    ...box.LABELS.slice(0, 2),
    { id: 'Label_1', name: 'Empty', type: 'user' },
    { id: 'Label_2', name: 'Archive', type: 'user' },
  ]
  box.history.set('120', [[{ messagesDeleted: [{ message: { id: 'w1' } }] }], '130'])
  const swapped = await hook.pull(ROOT, renamed.checkpoint)
  expect(pairs(swapped)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Projects'],
    [FileChangeKind.DELETE, '/gmail/Empty'],
    [FileChangeKind.CREATE, '/gmail/Empty'],
    [FileChangeKind.CREATE, '/gmail/Archive'],
    [FileChangeKind.DELETE, `/gmail/Empty/${plan}`],
    [FileChangeKind.DELETE, `/gmail/INBOX/${plan}`],
  ])
  box.labels = box.LABELS.slice(0, 2)
  box.history.set('130', [[], '140'])
  const removed = await hook.pull(ROOT, swapped.checkpoint)
  expect(pairs(removed)).toEqual([
    [FileChangeKind.DELETE, '/gmail/Empty'],
    [FileChangeKind.DELETE, '/gmail/Archive'],
  ])
})

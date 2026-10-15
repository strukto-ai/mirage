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

import { expect, it, vi } from 'vitest'
import type * as MessagesModule from './messages.ts'

const box = vi.hoisted(() => ({
  history: new Map<string, unknown>(),
  now: '100',
  messages: new Map<string, unknown>(),
}))

vi.mock('./history.ts', () => ({
  currentHistoryId: () => Promise.resolve(box.now),
  listHistory: (_tm: unknown, start: string) => {
    const answer = box.history.get(start)
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  },
}))
vi.mock('./labels.ts', () => ({
  listLabels: () =>
    Promise.resolve([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'TRASH', name: 'TRASH', type: 'system' },
      { id: 'Label_1', name: 'Work', type: 'user' },
    ]),
}))
vi.mock('./messages.ts', async () => {
  const actual = await vi.importActual<typeof MessagesModule>('./messages.ts')
  return {
    ...actual,
    getMessageRaw: (_tm: unknown, id: string) => Promise.resolve(box.messages.get(id)),
  }
})

import type { GmailAccessor } from '../../accessor/gmail.ts'
import { FileChangeKind, PathSpec } from '../../types.ts'
import type { Delta } from '../../types.ts'
import { buildDeltaHook } from './watch.ts'

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

// Twin of test_a_watch_follows_each_message_s_labels.
it("follows each message's labels", async () => {
  box.messages.set('a1', message('a1', ['TRASH'], '2026-01-05', 'Budget review', 'plan.txt'))
  box.messages.set('n3', message('n3', ['INBOX'], '2026-01-07', 'Hi'))
  const hook = buildDeltaHook({ tokenManager: {} } as unknown as GmailAccessor)
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

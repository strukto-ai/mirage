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

import {
  type Attachment,
  type GoogleAccount,
  MESSAGE,
  MESSAGES,
  UNTIL_CLEARED,
} from './google_account.ts'

/** One message of the seeded mailbox, by the key a test names it by. */
interface Mail {
  key: string
  labels: string[]
  date: string
  sender: string
  subject: string
  body: string
  attachments?: Attachment[]
}

// Each a weekday at 09:00 UTC, the Date header Gmail files it by.
const JAN_5 = 'Mon, 5 Jan 2026 09:00:00 +0000'
const JAN_6 = 'Tue, 6 Jan 2026 09:00:00 +0000'
const JAN_7 = 'Wed, 7 Jan 2026 09:00:00 +0000'
const JAN_8 = 'Thu, 8 Jan 2026 09:00:00 +0000'
const PLAN = 'plan\n'

export const MAILBOX: readonly Mail[] = [
  {
    key: 'a1',
    labels: ['INBOX'],
    date: JAN_5,
    sender: 'Ana Lima <ana@example.com>',
    subject: 'Budget review',
    body: 'numbers for travel',
    attachments: [['plan.txt', 'text/plain', PLAN]],
  },
  {
    key: 'b2',
    labels: ['INBOX', 'Work'],
    date: JAN_6,
    sender: 'Bo <bo@example.com>',
    subject: 'Lunch',
    body: 'deploy friday',
  },
  {
    key: 'c3',
    labels: ['TRASH'],
    date: JAN_6,
    sender: 'Cy <cy@example.com>',
    subject: 'Old',
    body: 'deploy',
  },
  {
    key: 'd4',
    labels: ['INBOX'],
    date: JAN_7,
    sender: 'Di <di@example.com>',
    subject: 'Notes',
    body: 'quiet',
  },
  {
    key: 'e5',
    labels: ['INBOX'],
    date: JAN_7,
    sender: 'Ed <ed@example.com>',
    subject: 'Report',
    body: 'see attached',
    attachments: [['report', 'application/rtf', PLAN]],
  },
  {
    key: 'f6',
    labels: ['INBOX'],
    date: JAN_7,
    sender: 'Fa <fa@example.com>',
    subject: 'Formats',
    body: 'rtf beats doc',
  },
  {
    key: 'g7',
    labels: ['INBOX'],
    date: JAN_8,
    sender: 'Gi <gi@example.com>',
    subject: 'Trip',
    body: 'the traveler program',
  },
  {
    key: 'h8',
    labels: ['INBOX'],
    date: JAN_8,
    sender: 'Ha <ha@example.com>',
    subject: 'Hike',
    body: 'the mountain trail',
  },
  {
    key: 'i9',
    labels: ['INBOX'],
    date: 'Thu, 8 Jan 2026 09:00:00 -0700 (Mountain Standard Time)',
    sender: 'Io <io@example.com>',
    subject: 'Ping',
    body: 'quiet',
  },
  {
    key: 'j10',
    labels: ['INBOX'],
    date: JAN_8,
    sender: 'Jo <jo@example.com>',
    subject: 'Links',
    body: 'notes at example.com/wombat/guide',
  },
]

/**
 * Fill the account's mailbox with `MAILBOX` and answer each message's key by
 * the id the fake gave it.
 *
 * Gmail cuts a snippet where it likes; g7's is answered as Gmail may give it,
 * cut inside `traveler`, so `travel` is in g7's text only there.
 */
export async function seed(account: GoogleAccount): Promise<Map<string, string>> {
  await account.reset()
  const keys = new Map<string, string>()
  for (const mail of MAILBOX) {
    const made = await account.message(mail.subject, mail.body, {
      labels: mail.labels,
      sender: mail.sender,
      date: mail.date,
      attachments: mail.attachments ?? [],
    })
    keys.set(made, mail.key)
  }
  const g7 = [...keys].find(([, key]) => key === 'g7')?.[0] ?? ''
  const answer = { ...(await account.mail(g7)), snippet: 'the travel' }
  await account.run.answerNext('GET', MESSAGE, 200, answer, UNTIL_CLEARED, `${MESSAGES}/${g7}`)
  return keys
}

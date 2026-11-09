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

import { describe, expect, it } from 'vitest'
import type { fetchMessage } from './client.ts'
import { envelopeDocuments } from './render.ts'

type Message = Awaited<ReturnType<typeof fetchMessage>>

const MESSAGE = {
  uid: '101',
  from: { name: 'Alice', email: 'alice@example.com' },
  reply_to: [],
  to: [],
  cc: [],
  subject: 'Hello',
  date: 'Tue, 06 Jan 2026 08:45:00 +0200',
  body_text: 'hi there',
  body_html: '<p>hi there</p>',
  snippet: 'hi there',
  message_id: '<a@b>',
  in_reply_to: '<x@y> <z@w>',
  references: [],
  has_attachments: true,
  attachments: [],
  attached: true,
  flags: ['\\Flagged', '\\Recent', 'custom', '\\Seen'],
  internalDate: '',
  rawSize: 42,
} as unknown as Message

function listing(message: Message, withAttachment = false): Record<string, unknown>[] {
  const decoded = JSON.stringify({
    queued: 0,
    envelopes: envelopeDocuments([message], withAttachment),
  })
  return (JSON.parse(decoded) as { envelopes: Record<string, unknown>[] }).envelopes
}

describe('envelopeDocuments', () => {
  it("uses upstream's field forms", () => {
    const [row] = listing(MESSAGE)
    expect(row).toEqual({
      id: '101',
      'message-id': 'a@b',
      'in-reply-to': ['x@y', 'z@w'],
      flags: [
        { raw: '\\Seen', iana: 'seen' },
        { raw: '\\Flagged', iana: 'flagged' },
        { raw: 'custom', iana: null },
      ],
      subject: 'Hello',
      from: [{ name: 'Alice', email: 'alice@example.com' }],
      to: [],
      date: '2026-01-06T08:45:00+02:00',
      size: 42,
      'has-attachment': null,
    })
  })

  it('reports attachments only when asked', () => {
    expect(listing(MESSAGE, true)[0]?.['has-attachment']).toBe(true)
  })

  it('renders a UTC date with Z and an unreadable one as null', () => {
    const utc = { ...MESSAGE, date: 'Tue, 06 Jan 2026 08:45:00 GMT' } as Message
    expect(listing(utc)[0]?.date).toBe('2026-01-06T08:45:00Z')
    expect(listing({ ...MESSAGE, date: 'soon' } as Message)[0]?.date).toBeNull()
  })
})

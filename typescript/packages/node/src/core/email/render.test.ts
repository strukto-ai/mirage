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
import type { FetchedMessage } from './_client.ts'
import { messageJsonBytes } from './render.ts'

const MESSAGE: FetchedMessage = {
  from: { name: 'Alice', email: 'alice@example.com' },
  reply_to: [],
  to: [{ name: '', email: 'bob@example.com' }],
  cc: [],
  subject: 'Hello',
  date: '',
  body_text: 'hi there',
  body_html: '',
  snippet: 'hi there',
  message_id: '<one@example.com>',
  in_reply_to: null,
  references: [],
  has_attachments: false,
  attachments: [],
  uid: '101',
  flags: [],
  internalDate: '2026-08-07T20:54:05.000Z',
}

const decoder = new TextDecoder()

describe('messageJsonBytes', () => {
  it('leaves INTERNALDATE out of the rendered message', () => {
    const body = JSON.parse(decoder.decode(messageJsonBytes(MESSAGE))) as Record<string, unknown>

    expect('internalDate' in body).toBe(false)
    expect(body.uid).toBe('101')
    expect(body.date).toBe('')
  })

  // readdir sizes a listed message with this renderer and read() serves it
  // with the same one, so the two must agree byte for byte.
  it('renders the same bytes whether or not INTERNALDATE is present', () => {
    const withOut = { ...MESSAGE, internalDate: '' }

    expect(messageJsonBytes(MESSAGE)).toEqual(messageJsonBytes(withOut))
  })
})

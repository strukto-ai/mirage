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
import type { FetchedMessage } from './client.ts'
import { envelopesJsonBytes, messageJsonBytes } from './render.ts'

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

const FULL: FetchedMessage = {
  ...MESSAGE,
  body_html: '<p>hi there</p>',
  has_attachments: true,
  attachments: [{ filename: 'a.txt', content_type: 'text/plain', size: 3 }],
}

describe('envelopesJsonBytes', () => {
  it('carries no body', () => {
    // Listing a mailbox fetches every full source, because attachment
    // metadata lives in the MIME structure, but the listing itself is the
    // envelope: 25 HTML bodies do not belong in it (#1067).
    const [row] = JSON.parse(decoder.decode(envelopesJsonBytes([FULL]))) as Record<
      string,
      unknown
    >[]
    expect(row).toBeDefined()
    expect('body_text' in (row ?? {})).toBe(false)
    expect('body_html' in (row ?? {})).toBe(false)
    expect('snippet' in (row ?? {})).toBe(false)
    expect('internalDate' in (row ?? {})).toBe(false)
  })

  it('keeps identifiers, headers, flags and attachment metadata', () => {
    const [row] = JSON.parse(decoder.decode(envelopesJsonBytes([FULL]))) as Record<
      string,
      unknown
    >[]
    expect(row?.uid).toBe('101')
    expect(row?.subject).toBe('Hello')
    expect(row?.from).toEqual({ name: 'Alice', email: 'alice@example.com' })
    expect(row?.flags).toEqual([])
    expect(row?.has_attachments).toBe(true)
    expect(row?.attachments).toEqual(FULL.attachments)
  })

  it('leaves the document renderer carrying the body', () => {
    // The projection is the listing's alone: `cat` of the .email.json and
    // `message read` serve the whole message, at the byte length readdir
    // advertised.
    const body = JSON.parse(decoder.decode(messageJsonBytes(FULL))) as Record<string, unknown>
    expect(body.body_text).toBe('hi there')
    expect(body.body_html).toBe('<p>hi there</p>')
    expect(body.snippet).toBe('hi there')
  })
})

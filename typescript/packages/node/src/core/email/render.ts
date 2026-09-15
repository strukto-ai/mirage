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

import type { FetchedMessage } from './client.ts'

const encoder = new TextEncoder()

/**
 * Projects a fetched message onto the document mirage serves.
 *
 * INTERNALDATE is dropped: it is the mailbox's own arrival stamp, which
 * picks the date directory when the `Date:` header is missing, not a
 * field of the message. The gmail backend keeps its internalDate out of
 * the rendered JSON the same way.
 */
function messageDocument(message: FetchedMessage): Partial<FetchedMessage> {
  const body: Partial<FetchedMessage> = { ...message }
  delete body.internalDate
  return body
}

export function messageJsonText(message: FetchedMessage): string {
  return JSON.stringify(messageDocument(message))
}

export function messageJsonBytes(message: FetchedMessage): Uint8Array {
  // Single renderer for .email.json: the listing fetches the full message
  // source and parses it exactly like read() does, so sizing a listed
  // header dict here yields the byte length read() will return. Every
  // other serializer of a fetched message routes through here too, so
  // `himalaya message read` cannot drift from `cat`.
  return encoder.encode(messageJsonText(message))
}

export type Envelope = Omit<FetchedMessage, 'internalDate' | 'body_text' | 'body_html' | 'snippet'>

/**
 * Projects a fetched message onto its envelope.
 *
 * The envelope is the message without its body: identifiers, headers,
 * flags and attachment metadata stay; `body_text`, `body_html` and the
 * body-derived `snippet` go, along with INTERNALDATE. Listing a mailbox
 * fetches every full source because attachment names live in the MIME
 * structure, but a page of envelopes must not carry a page of HTML
 * bodies. Those are `message read`'s and the mounted .email.json's,
 * which render through `messageDocument`.
 */
function envelopeDocument(message: FetchedMessage): Envelope {
  const body = messageDocument(message)
  delete body.body_text
  delete body.body_html
  delete body.snippet
  return body as Envelope
}

export function envelopesJsonBytes(messages: readonly FetchedMessage[]): Uint8Array {
  return encoder.encode(JSON.stringify(messages.map((m) => envelopeDocument(m))))
}

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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { FetchedMessage } from '../../../../core/email/_client.ts'
import { build, type Attachment, type Compose, type Source } from './builder.ts'

// The fixture is generated from the python builder
// (EmailMessage.as_bytes(policy=SMTP)), which is the reference
// implementation. Both test suites assert against the same bytes, so a
// pass here proves the two builders serialize identically.
const FIXTURE = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/himalaya/mime_parity.json', import.meta.url),
)

interface FixtureCompose {
  sender: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string | null
  body: string
  signature: string | null
  attachments: { filename: string; contentType: string; dataB64: string }[]
  source?: Record<string, unknown>
  mode?: 'reply' | 'forward'
  postingStyle?: 'top' | 'bottom'
  quoteHeadline?: string
}

interface FixtureCase {
  compose: FixtureCompose
  bytesB64: string
}

const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, FixtureCase>

function toCompose(fixture: FixtureCompose): Compose {
  const attachments: Attachment[] = fixture.attachments.map((entry) => ({
    filename: entry.filename,
    contentType: entry.contentType,
    data: new Uint8Array(Buffer.from(entry.dataB64, 'base64')),
  }))
  return {
    sender: fixture.sender,
    to: fixture.to,
    cc: fixture.cc,
    bcc: fixture.bcc,
    subject: fixture.subject,
    body: fixture.body,
    signature: fixture.signature,
    attachments,
  }
}

function toSource(fixture: FixtureCompose): Source | null {
  if (fixture.source === undefined) return null
  return {
    message: fixture.source as unknown as FetchedMessage,
    mode: fixture.mode ?? 'reply',
    postingStyle: fixture.postingStyle ?? 'top',
    quoteHeadline: fixture.quoteHeadline ?? '',
  }
}

describe('mime parity with the python builder', () => {
  it.each(Object.keys(CASES).sort())('serializes %s byte-for-byte', (name) => {
    const entry = CASES[name]
    if (entry === undefined) throw new Error(`missing fixture case ${name}`)
    const raw = build(toCompose(entry.compose), toSource(entry.compose))
    const expected = Buffer.from(entry.bytesB64, 'base64')
    expect(Buffer.from(raw).toString('latin1')).toBe(expected.toString('latin1'))
  })
})

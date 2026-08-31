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

// The one RFC822 builder in this repo. It used to live inside the typescript
// runner's adapters, where the GreenMail seeder and the gws mail seeder both
// called it; the mail fake needs the same bytes to expand the same manifest, so
// it moved here rather than being copied. A second builder would be two
// definitions of what a fixture message IS, and the two would diverge exactly
// where a MIME parser notices.

export interface MailEntry {
  account?: string
  from: string
  to: string
  cc?: string[]
  subject: string
  date: string
  body: string
  labels?: string[]
  folder?: string
  seen?: boolean
  attachments?: { filename: string; content: string }[]
}

export function mimeTextPart(content: string, filename?: string): string {
  const lines = [
    'Content-Type: text/plain; charset="utf-8"',
    'MIME-Version: 1.0',
    'Content-Transfer-Encoding: base64',
  ]
  if (filename !== undefined) {
    lines.push(`Content-Disposition: attachment; filename="${filename}"`)
  }
  return `${lines.join('\r\n')}\r\n\r\n${Buffer.from(content, 'utf-8').toString('base64')}`
}

// The same constrained shape python's email.mime emits: one base64 text/plain
// body plus base64 text attachments under multipart/mixed.
export function buildRfc822(entry: MailEntry): string {
  const headers = [`From: ${entry.from}`, `To: ${entry.to}`]
  if (entry.cc !== undefined && entry.cc.length > 0) headers.push(`Cc: ${entry.cc.join(', ')}`)
  headers.push(`Subject: ${entry.subject}`, `Date: ${entry.date}`)
  const attachments = entry.attachments ?? []
  if (attachments.length === 0) {
    return `${headers.join('\r\n')}\r\n${mimeTextPart(entry.body)}`
  }
  const boundary = 'integ-mime-boundary'
  const parts = [
    mimeTextPart(entry.body),
    ...attachments.map((att) => mimeTextPart(att.content, att.filename)),
  ]
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
  ].join('\r\n')
}

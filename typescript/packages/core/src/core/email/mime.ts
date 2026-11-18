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

import { openStreamSync } from '../../rs/stream.ts'

interface Address {
  name: string | null
  address: string | null
}

export interface Attachment {
  id: string
  filename: string | null
  mime: string | null
  size: number
  inline: boolean
  payload: Uint8Array
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export function renderMime(
  raw: Uint8Array,
  view: 'json' | 'read' | 'template' | 'attachments' | 'addresses',
  payloads = false,
): Uint8Array {
  const stream = openStreamSync('mime', { view, payloads, node: true })
  try {
    stream.feed(raw)
    return stream.finish()
  } finally {
    stream.close()
  }
}

export function parseAddresses(value: string): Address[] {
  return JSON.parse(
    DECODER.decode(renderMime(ENCODER.encode(`${value}\n`), 'addresses')),
  ) as Address[]
}

export function parseAttachments(raw: Uint8Array, payloads: boolean): Attachment[] {
  const output = renderMime(raw, 'attachments', payloads)
  const end = output.byteLength - 4
  const metadata = end - new DataView(output.buffer, output.byteOffset + end, 4).getUint32(0, true)
  const rows = JSON.parse(DECODER.decode(output.subarray(metadata, end))) as Omit<
    Attachment,
    'payload'
  >[]
  const empty = new Uint8Array()
  let start = 0
  return rows.map((row) => {
    const finish = start + row.size
    const payload = payloads ? output.subarray(start, finish) : empty
    start = finish
    return { ...row, payload }
  })
}

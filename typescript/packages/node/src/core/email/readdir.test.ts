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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'
import type * as FoldersModule from './folders.ts'

function message(overrides: Partial<ClientModule.FetchedMessage>): ClientModule.FetchedMessage {
  return {
    from: { name: 'Alice', email: 'alice@example.com' },
    reply_to: [],
    to: [{ name: '', email: 'bob@example.com' }],
    cc: [],
    subject: 'Hello',
    date: 'Mon, 15 Jan 2024 10:00:00 +0000',
    body_text: 'hi there',
    body_html: '',
    snippet: 'hi there',
    message_id: '<one@example.com>',
    in_reply_to: null,
    references: [],
    has_attachments: false,
    attachments: [],
    uid: '101',
    flags: ['\\Seen'],
    internalDate: '2024-03-18T08:00:00.000Z',
    ...overrides,
  }
}

const HEADERS = [message({})]
const NO_DATE_HEADERS = [message({ date: '', internalDate: '2026-08-07T20:54:05.000Z' })]
let headersList = HEADERS

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return {
    ...actual,
    listMessageUids: vi.fn(() => Promise.resolve(['101'])),
    fetchHeaders: vi.fn(() => Promise.resolve(headersList)),
  }
})

vi.mock('./folders.ts', async () => {
  const actual = await vi.importActual<typeof FoldersModule>('./folders.ts')
  return { ...actual, listFolders: vi.fn(() => Promise.resolve(['INBOX'])) }
})

import { PathSpec, RAMIndexCacheStore } from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { dateBucket, readdir } from './readdir.ts'
import { messageJsonBytes } from './render.ts'

const ACCESSOR = { config: { maxMessages: 50 } } as unknown as EmailAccessor

const SPEC = new PathSpec({
  virtual: '/INBOX',
  directory: '/INBOX',
  resourcePath: 'INBOX',
})

describe('email readdir', () => {
  afterEach(() => {
    headersList = HEADERS
  })

  it('stores the rendered message size on each listing entry', async () => {
    const index = new RAMIndexCacheStore()

    const dates = await readdir(ACCESSOR, SPEC, index)

    expect(dates).toEqual(['/INBOX/2024-01-15'])
    const listing = await index.listDir('/INBOX/2024-01-15')
    const child = listing.entries?.[0] ?? ''
    const lookup = await index.get(child)
    expect(lookup.entry?.size).toBe(messageJsonBytes(message({})).byteLength)
  })

  // Without INTERNALDATE every message a sender left undated lands in one
  // 1970 directory, which is the mount's only organizing axis.
  it('buckets a message with no Date header by its INTERNALDATE', async () => {
    headersList = NO_DATE_HEADERS
    const index = new RAMIndexCacheStore()

    const dates = await readdir(ACCESSOR, SPEC, index)

    expect(dates).toEqual(['/INBOX/2026-08-07'])
  })
})

describe('dateBucket', () => {
  it('prefers the Date header', () => {
    expect(dateBucket(message({}))).toBe('2024-01-15')
  })

  it('falls back to INTERNALDATE when the header is missing', () => {
    expect(dateBucket(message({ date: '', internalDate: '2026-08-07T20:54:05.000Z' }))).toBe(
      '2026-08-07',
    )
  })

  it('falls back to INTERNALDATE when the header does not parse', () => {
    expect(
      dateBucket(message({ date: 'yesterday-ish', internalDate: '2026-08-07T20:54:05.000Z' })),
    ).toBe('2026-08-07')
  })

  it('reaches the epoch only when neither timestamp parses', () => {
    expect(dateBucket(message({ date: '', internalDate: '' }))).toBe('1970-01-01')
  })

  it('reads offsets in UTC', () => {
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 23:30:00 -0500' }))).toBe('2026-01-06')
  })
})

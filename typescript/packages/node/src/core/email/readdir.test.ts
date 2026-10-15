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
import type * as ClientModule from './client.ts'
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

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
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

import { DirListing, FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import type { EmailAccessor } from '../../accessor/email.ts'
import { dateBucket, readdir } from './readdir.ts'
import { messageJsonBytes } from './render.ts'

const ACCESSOR = { config: { maxMessages: 50 } } as unknown as EmailAccessor

const SPEC = new PathSpec({
  virtual: '/INBOX',
  directory: '/INBOX',
  vfsPath: 'INBOX',
})

// The folder's row, as the mount root's listing names it.
const FOLDER = new FileStat({ name: 'INBOX', type: FileType.DIRECTORY })

async function folderListing(): Promise<DirListing> {
  return (await readdir(ACCESSOR, SPEC, FOLDER)) as DirListing
}

describe('email readdir', () => {
  afterEach(() => {
    headersList = HEADERS
  })

  it('sizes each message row as rendered', async () => {
    const listed = await folderListing()

    expect(listed.entries.map((row) => row.name)).toEqual(['2024-01-15'])
    const [child] = listed.seeds.get('2024-01-15') ?? []
    expect(child?.size).toBe(messageJsonBytes(message({})).byteLength)
  })

  // Without INTERNALDATE every message a sender left undated lands in one
  // 1970 directory, which is the mount's only organizing axis.
  it('buckets a message with no Date header by its INTERNALDATE', async () => {
    headersList = NO_DATE_HEADERS

    const listed = await folderListing()

    expect(listed.entries.map((row) => row.name)).toEqual(['2026-08-07'])
  })
})

describe('email readdir windows', () => {
  it('lists a folder and the days it seeds as windows', async () => {
    // The folder fetch stops at maxMessages, so its days, and the days
    // seeded from it, name only the messages that fit. A listing's seeds are
    // kept with its own window.
    const listed = await folderListing()
    expect(listed.window).toBe(true)
    expect(listed.seeds.has('2024-01-15')).toBe(true)
  })

  it('lists a day re-listed on its own as a window', async () => {
    // With the day's own listing dropped, the day lister runs itself rather
    // than the folder's seed answering for it.
    const day = new PathSpec({
      virtual: '/INBOX/2024-01-15',
      directory: '/INBOX/2024-01-15',
      vfsPath: 'INBOX/2024-01-15',
    })
    const listed = await readdir(
      ACCESSOR,
      day,
      new FileStat({ name: '2024-01-15', type: FileType.DIRECTORY }),
    )
    expect(listed).toBeInstanceOf(DirListing)
    expect((listed as DirListing).entries).toHaveLength(1)
    expect((listed as DirListing).window).toBe(true)
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

  // RFC 3501 compares SENTON/SENTBEFORE/SENTSINCE (and ON/BEFORE/SINCE)
  // "disregarding time and timezone", so a message written late on the 5th
  // in -0500 answers a search for the 5th and belongs in the 5th's
  // directory. Converting to UTC would file it under the 6th.
  it('keeps the calendar date as written', () => {
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 23:30:00 -0500' }))).toBe('2026-01-05')
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 01:30:00 +0900' }))).toBe('2026-01-05')
  })

  it('reads the obsolete zone names RFC 5322 still allows', () => {
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 23:30:00 EST' }))).toBe('2026-01-05')
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 23:30:00 GMT' }))).toBe('2026-01-05')
  })

  // A header with no zone at all: the wall clock is the answer, and it
  // must not shift with the host's timezone.
  it('keeps a zone-less header at its written wall clock', () => {
    expect(dateBucket(message({ date: 'Mon, 05 Jan 2026 23:30:00' }))).toBe('2026-01-05')
  })
})

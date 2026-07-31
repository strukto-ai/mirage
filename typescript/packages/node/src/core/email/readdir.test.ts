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

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './_client.ts'
import type * as FoldersModule from './folders.ts'

const HEADERS = [
  {
    from: { name: 'Alice', email: 'alice@example.com' },
    to: [{ name: '', email: 'bob@example.com' }],
    subject: 'Hello',
    date: 'Mon, 15 Jan 2024 10:00:00 +0000',
    body_text: 'hi there',
    attachments: [],
    uid: '101',
    flags: ['\\Seen'],
  },
]

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return {
    ...actual,
    listMessageUids: vi.fn(() => Promise.resolve(['101'])),
    fetchHeaders: vi.fn(() => Promise.resolve(HEADERS)),
  }
})

vi.mock('./folders.ts', async () => {
  const actual = await vi.importActual<typeof FoldersModule>('./folders.ts')
  return { ...actual, listFolders: vi.fn(() => Promise.resolve(['INBOX'])) }
})

import { PathSpec, RAMIndexCacheStore } from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { readdir } from './readdir.ts'
import { messageJsonBytes } from './render.ts'

const ACCESSOR = { config: { maxMessages: 50 } } as unknown as EmailAccessor

describe('email readdir', () => {
  it('stores the rendered message size on each listing entry', async () => {
    const index = new RAMIndexCacheStore()
    const spec = new PathSpec({
      virtual: '/INBOX',
      directory: '/INBOX',
      resourcePath: 'INBOX',
    })

    const dates = await readdir(ACCESSOR, spec, index)

    expect(dates).toEqual(['/INBOX/2024-01-15'])
    const listing = await index.listDir('/INBOX/2024-01-15')
    const child = listing.entries?.[0] ?? ''
    const lookup = await index.get(child)
    expect(lookup.entry?.size).toBe(messageJsonBytes(HEADERS[0]).byteLength)
  })
})

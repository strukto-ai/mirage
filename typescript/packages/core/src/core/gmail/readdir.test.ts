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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MessagesModule from './messages.ts'
import type * as LabelsModule from './labels.ts'

vi.mock('./messages.ts', async () => {
  const actual = await vi.importActual<typeof MessagesModule>('./messages.ts')
  return { ...actual, listMessages: vi.fn(), getMessageRaw: vi.fn() }
})

vi.mock('./labels.ts', async () => {
  const actual = await vi.importActual<typeof LabelsModule>('./labels.ts')
  return { ...actual, listLabels: vi.fn() }
})

import { GmailAccessor } from '../../accessor/gmail.ts'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { TokenManager } from '../google/client.ts'
import * as labelsMod from './labels.ts'
import * as messagesMod from './messages.ts'
import { readdir } from './readdir.ts'

const ACCESSOR = new GmailAccessor({ tokenManager: {} as TokenManager, config: {} })

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/gmail') })
}

function row(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { label_id: 'INBOX' } })
}

describe('gmail readdir windows', () => {
  beforeEach(() => {
    vi.mocked(labelsMod.listLabels).mockResolvedValue([{ id: 'INBOX', type: 'system' }])
    vi.mocked(messagesMod.listMessages).mockResolvedValue([{ id: 'x1' }])
    vi.mocked(messagesMod.getMessageRaw).mockResolvedValue({
      id: 'x1',
      internalDate: String(Date.UTC(2026, 3, 27)),
      payload: { headers: [{ name: 'Subject', value: 'Hi 27' }] },
    })
  })

  it('lists a label as a window that seeds its days', async () => {
    // Both fetches stop at MAX_MESSAGES, so what they name is a window: a
    // message outside it has not gone anywhere.
    const listing = await readdir(ACCESSOR, spec('/gmail/INBOX'), row('INBOX'))
    expect(listing).toBeInstanceOf(DirListing)
    expect((listing as DirListing).window).toBe(true)
    expect([...(listing as DirListing).seeds.keys()]).toEqual(['2026-04-27'])
  })

  it('lists a day on its own as a window', async () => {
    // The label listing seeds its days, so a day read after it never reaches
    // the day lister; listing the day first is what exercises that lister.
    const listing = await readdir(ACCESSOR, spec('/gmail/INBOX/2026-04-27'), row('2026-04-27'))
    expect(listing).toBeInstanceOf(DirListing)
    expect((listing as DirListing).window).toBe(true)
    expect((listing as DirListing).entries.map((one) => one.name)).toEqual(['Hi_27__x1.gmail.json'])
  })
})

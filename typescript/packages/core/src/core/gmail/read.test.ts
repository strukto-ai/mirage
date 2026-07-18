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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import type * as MessagesModule from './messages.ts'
import type * as LabelsModule from './labels.ts'

vi.mock('./messages.ts', async () => {
  const actual = await vi.importActual<typeof MessagesModule>('./messages.ts')
  return {
    ...actual,
    listMessages: vi.fn(),
    getMessageRaw: vi.fn(),
    getMessageProcessed: vi.fn(),
  }
})

vi.mock('./labels.ts', async () => {
  const actual = await vi.importActual<typeof LabelsModule>('./labels.ts')
  return { ...actual, listLabels: vi.fn() }
})

import { GmailAccessor } from '../../accessor/gmail.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as labelsMod from './labels.ts'
import * as messagesMod from './messages.ts'
import { read } from './read.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GmailAccessor {
  return new GmailAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gmail read auto-bootstrap', () => {
  it('refetches parent listing when message entry is evicted from index', async () => {
    vi.mocked(labelsMod.listLabels).mockResolvedValue([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
    ])
    vi.mocked(messagesMod.listMessages).mockResolvedValue([{ id: 'msg-1', threadId: 't-1' }])
    vi.mocked(messagesMod.getMessageRaw).mockResolvedValue({
      id: 'msg-1',
      threadId: 't-1',
      internalDate: String(Date.UTC(2026, 3, 27)),
      sizeEstimate: 1024,
      labelIds: ['INBOX'],
      snippet: 'hello',
      payload: { headers: [{ name: 'Subject', value: 'Hello World' }] },
    })
    vi.mocked(messagesMod.getMessageProcessed).mockResolvedValue({
      id: 'msg-1',
      thread_id: 't-1',
      from: { name: 'Alice', email: 'alice@example.com' },
      to: [],
      cc: [],
      subject: 'Hello World',
      date: '',
      body_text: 'hi',
      snippet: 'hello',
      labels: ['INBOX'],
      attachments: [],
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gmail/INBOX/2026-04-27/Hello_World__msg-1.gmail.json',
      directory: '/gmail/INBOX/2026-04-27',
      resourcePath: mountKey('/gmail/INBOX/2026-04-27/Hello_World__msg-1.gmail.json', '/gmail'),
    })
    const out = await read(accessor, path, index)
    const parsed = JSON.parse(new TextDecoder().decode(out)) as { subject: string }
    expect(parsed.subject).toBe('Hello World')
  })

  it('throws ENOENT when parent refresh does not contain the message', async () => {
    vi.mocked(labelsMod.listLabels).mockResolvedValue([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
    ])
    vi.mocked(messagesMod.listMessages).mockResolvedValue([])
    vi.mocked(messagesMod.getMessageRaw).mockRejectedValue(new Error('should not be called'))
    vi.mocked(messagesMod.getMessageProcessed).mockRejectedValue(new Error('should not be called'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gmail/INBOX/2026-04-27/Missing__msg-x.gmail.json',
      directory: '/gmail/INBOX/2026-04-27',
      resourcePath: mountKey('/gmail/INBOX/2026-04-27/Missing__msg-x.gmail.json', '/gmail'),
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

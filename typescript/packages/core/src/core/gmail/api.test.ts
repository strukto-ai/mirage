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
import type * as HistoryModule from './history.ts'
import type * as LabelsModule from './labels.ts'
import type * as MessagesModule from './messages.ts'

vi.mock('./history.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof HistoryModule>()),
  currentHistoryId: vi.fn(),
  listHistory: vi.fn(),
}))
vi.mock('./labels.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof LabelsModule>()),
  listLabels: vi.fn(),
}))
vi.mock('./messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof MessagesModule>()),
  listMessages: vi.fn(),
  getMessageRaw: vi.fn(),
  getAttachment: vi.fn(),
}))

import type { TokenManager } from '../google/client.ts'
import { GmailClient, type GmailApi } from './api.ts'
import * as history from './history.ts'
import * as labels from './labels.ts'
import * as messages from './messages.ts'

const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager

interface Delegation {
  args: unknown[]
  wire: (...args: never[]) => unknown
  sent: unknown[]
}

const DELEGATIONS: { [K in keyof GmailApi]: Delegation & { args: Parameters<GmailApi[K]> } } = {
  listLabels: { args: [], wire: labels.listLabels, sent: [] },
  listMessages: {
    args: [{ labelId: 'L1', query: 'q', maxResults: 5 }],
    wire: messages.listMessages,
    sent: [{ labelId: 'L1', query: 'q', maxResults: 5 }],
  },
  getMessageRaw: { args: ['m1'], wire: messages.getMessageRaw, sent: ['m1'] },
  getAttachment: { args: ['m1', 'a1'], wire: messages.getAttachment, sent: ['m1', 'a1'] },
  currentHistoryId: { args: [], wire: history.currentHistoryId, sent: [] },
  listHistory: { args: ['h1'], wire: history.listHistory, sent: ['h1'] },
}

describe('GmailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(Object.entries<Delegation>(DELEGATIONS))(
    '%s sends its wire call the token manager and its arguments',
    async (method, row) => {
      const reply = Symbol(method)
      vi.mocked(row.wire).mockReturnValue(reply)
      const client = new GmailClient(TOKEN_MANAGER)
      const call = Reflect.get(client, method) as (...a: unknown[]) => unknown
      expect(await call.apply(client, row.args)).toBe(reply)
      expect(row.wire).toHaveBeenCalledExactlyOnceWith(TOKEN_MANAGER, ...row.sent)
    },
  )
})

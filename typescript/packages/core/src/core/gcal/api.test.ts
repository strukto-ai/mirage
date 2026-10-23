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
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  syncEvents: vi.fn(),
  deleteEvent: vi.fn(),
}))

import type { TokenManager } from '../google/client.ts'
import { TimeRange } from '../time_range.ts'
import { CalendarClient, type CalendarApi } from './api.ts'
import * as client from './client.ts'

const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager
const SCOPE = new TimeRange('2026-08-01T00:00:00Z', undefined)

interface Delegation {
  args: unknown[]
  wire: (...args: never[]) => unknown
  sent: unknown[]
}

const DELEGATIONS: {
  [K in keyof CalendarApi]: Delegation & { args: Parameters<CalendarApi[K]> }
} = {
  listCalendars: { args: ['writer'], wire: client.listCalendars, sent: ['writer'] },
  listEvents: {
    args: ['c1', null, 'hi', 'UTC', SCOPE, 'lunch'],
    wire: client.listEvents,
    sent: ['c1', null, 'hi', 'UTC', SCOPE, 'lunch'],
  },
  syncEvents: { args: ['c1', 't1', 'UTC'], wire: client.syncEvents, sent: ['c1', 't1', 'UTC'] },
  deleteEvent: { args: ['c1', 'e1'], wire: client.deleteEvent, sent: ['c1', 'e1'] },
}

describe('CalendarClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(Object.entries<Delegation>(DELEGATIONS))(
    '%s sends its wire call the token manager and its arguments',
    async (method, row) => {
      const reply = Symbol(method)
      vi.mocked(row.wire).mockReturnValue(reply)
      const calendar = new CalendarClient(TOKEN_MANAGER)
      const call = Reflect.get(calendar, method) as (...a: unknown[]) => unknown
      expect(await call.apply(calendar, row.args)).toBe(reply)
      expect(row.wire).toHaveBeenCalledExactlyOnceWith(TOKEN_MANAGER, ...row.sent)
    },
  )

  it('lists over the whole range when asked for none', async () => {
    await new CalendarClient(TOKEN_MANAGER).listEvents('c1', 'lo', 'hi')
    expect(vi.mocked(client.listEvents).mock.lastCall?.[5]).toEqual(new TimeRange())
  })
})

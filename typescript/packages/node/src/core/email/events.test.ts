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

import { FileChangeKind, PathSpec, type JsonValue } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { EmailEventHook } from './events.ts'

const ROOT = new PathSpec({ virtual: '/mail', directory: '/mail', vfsPath: '' })

async function map(eventType: string, payload: JsonValue): Promise<[FileChangeKind, string][]> {
  const events = await new EmailEventHook().toEvents(ROOT, eventType, payload)
  return events.map((e) => [e.kind, e.path.virtual])
}

describe('EmailEventHook', () => {
  it('is UNKNOWN on the folder for each mailbox change', async () => {
    for (const name of ['EXISTS', 'EXPUNGE', 'FETCH', 'VANISHED', 'exists']) {
      expect(await map(name, { mailbox: 'INBOX' })).toEqual([
        [FileChangeKind.UNKNOWN, '/mail/INBOX'],
      ])
    }
  })

  it("keeps the server's spelling of the folder", async () => {
    expect(await map('EXISTS', { mailbox: 'Archive/2026' })).toEqual([
      [FileChangeKind.UNKNOWN, '/mail/Archive/2026'],
    ])
  })

  it('maps RECENT and a missing mailbox to nothing', async () => {
    expect(await map('RECENT', { mailbox: 'INBOX' })).toEqual([])
    expect(await map('EXISTS', {})).toEqual([])
    expect(await map('EXISTS', 'INBOX')).toEqual([])
  })
})

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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MountMode } from '../../types.ts'
import { GmailVFS } from '../../vfs/gmail/gmail.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

// The account with Gmail's system labels and no message yet.
beforeEach(async () => {
  account = new GoogleAccount(origin)
  await account.reset()
})

afterEach(async () => {
  await account.run.close()
})

async function readAt(path: string): Promise<Uint8Array> {
  const ws = new Workspace({ '/gmail/': new GmailVFS(account.config()) }, { mode: MountMode.READ })
  try {
    return (await ws.dispatch('read', path)) as Uint8Array
  } finally {
    await ws.close()
  }
}

describe('gmail read through a mount', () => {
  it('lists its way to a message on a cold read', async () => {
    const msg = await account.message('Hello World', 'hi', {
      sender: 'Alice <alice@example.com>',
      date: 'Mon, 27 Apr 2026 00:00:00 +0000',
    })
    const out = await readAt(`/gmail/INBOX/2026-04-27/Hello_World__${msg}.gmail.json`)
    const parsed = JSON.parse(new TextDecoder().decode(out)) as { subject: string }
    expect(parsed.subject).toBe('Hello World')
  })

  it('throws ENOENT when the day does not list the message', async () => {
    await account.run.recordRequests()
    await expect(readAt('/gmail/INBOX/2026-04-27/Missing__msg-x.gmail.json')).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
    // The day's listing names no such message, so none is fetched.
    expect(await account.asked('GET', '/gmail/v1/users/me/messages/:id')).toEqual([])
  })
})

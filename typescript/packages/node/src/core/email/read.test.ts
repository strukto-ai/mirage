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
import { PathSpec } from '@struktoai/mirage-core/types'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import type * as ProbeModule from '@struktoai/mirage-core/core/hierarchy/probe'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, fetchHeaders: vi.fn() }
})
vi.mock('@struktoai/mirage-core/core/hierarchy/probe', async () => {
  const actual = await vi.importActual<typeof ProbeModule>(
    '@struktoai/mirage-core/core/hierarchy/probe',
  )
  return { ...actual, resolveEntry: vi.fn() }
})

import type { EmailAccessor } from '../../accessor/email.ts'
import * as client from './client.ts'
import * as probe from '@struktoai/mirage-core/core/hierarchy/probe'
import type { FetchedMessage } from './client.ts'
import { readMany } from './read.ts'
import { messageJsonBytes } from './render.ts'

const DAY = '/INBOX/2024-01-15'

function message(uid: string): FetchedMessage {
  return {
    from: { name: 'Alice', email: 'alice@example.com' },
    reply_to: [],
    to: [],
    cc: [],
    subject: `Note ${uid}`,
    date: 'Mon, 15 Jan 2024 10:00:00 +0000',
    body_text: 'hi',
    body_html: '',
    snippet: 'hi',
    message_id: `<${uid}@example.com>`,
    in_reply_to: null,
    references: [],
    has_attachments: false,
    attachments: [],
    uid,
    flags: [],
    internalDate: '2024-01-15T10:00:00.000Z',
  }
}

// Twin of test_a_batch_fetches_a_folders_messages_at_once.
it('fetches a folder’s messages of a batch at once', async () => {
  const names = new Map(['101', '102'].map((uid) => [`${DAY}/note__${uid}.email.json`, uid]))
  vi.mocked(probe.resolveEntry).mockImplementation((_readdir, _accessor, path) => {
    const uid = names.get(typeof path === 'string' ? path : path.virtual)
    return Promise.resolve(uid === undefined ? null : ({ id: uid } as never))
  })
  const fetch = vi.mocked(client.fetchHeaders).mockResolvedValue([message('102'), message('101')])
  const answers = await readMany(
    {} as EmailAccessor,
    [...names.keys(), `${DAY}/gone__103.email.json`].map((p) => PathSpec.fromStrPath(p)),
    new RAMIndexCacheStore(),
  )
  expect(answers).toEqual(
    new Map([...names].map(([path, uid]) => [path, messageJsonBytes(message(uid))])),
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.slice(1)).toEqual(['INBOX', ['101', '102']])
})

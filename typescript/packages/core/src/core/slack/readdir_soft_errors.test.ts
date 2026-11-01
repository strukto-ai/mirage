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

import { describe, expect, it } from 'vitest'
import { SlackAccessor } from '../../accessor/slack.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SlackApiError, type SlackResponse, type SlackTransport } from './client.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'

// Mirrors python/tests/core/slack/test_readdir_soft_errors.py: a Slack history
// refusal like `not_in_channel` / `missing_scope` is EACCES on the path, never
// an empty conversation.

const CHANNEL = '/slack/channels/private__C_INACCESSIBLE'
const DAY = `${CHANNEL}/2026-05-10`

class FakeTransport implements SlackTransport {
  constructor(private readonly responder: (endpoint: string) => SlackResponse | Error) {}
  call(endpoint: string): Promise<SlackResponse> {
    const result = this.responder(endpoint)
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(result)
  }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/slack') })
}

function historyFails(code: string): FakeTransport {
  return new FakeTransport((endpoint) => {
    if (endpoint === 'conversations.list') {
      return {
        ok: true,
        channels: [{ id: 'C_INACCESSIBLE', name: 'private', created: 1 }],
        response_metadata: { next_cursor: '' },
      }
    }
    if (endpoint === 'conversations.history') {
      return new SlackApiError('conversations.history', code)
    }
    throw new Error(`unexpected ${endpoint}`)
  })
}

function row(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { channel_id: 'C_INACCESSIBLE' } })
}

describe('a channel Slack refuses', () => {
  it.each(['not_in_channel', 'channel_not_found', 'missing_scope', 'is_archived', 'not_authed'])(
    'is EACCES on %s',
    async (code) => {
      const ws = new Workspace({
        '/slack/': new SlackVFS({ accessor: new SlackAccessor(historyFails(code)) }),
      })
      await ws.dispatch('readdir', '/slack/channels')
      await expect(ws.dispatch('readdir', CHANNEL)).rejects.toMatchObject({
        code: 'EACCES',
        virtualPath: CHANNEL,
      })
    },
  )

  it('propagates any other Slack error', async () => {
    const ws = new Workspace({
      '/slack/': new SlackVFS({ accessor: new SlackAccessor(historyFails('ratelimited')) }),
    })
    await ws.dispatch('readdir', '/slack/channels')
    await expect(ws.dispatch('readdir', CHANNEL)).rejects.toThrow(/ratelimited/)
  })
})

describe('a day Slack refuses', () => {
  it.each(['', '/files'])('lists as EACCES at %s', async (below) => {
    const own = row(below === '' ? '2026-05-10' : 'files')
    await expect(
      readdir(new SlackAccessor(historyFails('not_in_channel')), spec(DAY + below), own),
    ).rejects.toMatchObject({ code: 'EACCES', virtualPath: DAY + below })
  })

  it('reads chat.jsonl as EACCES', async () => {
    const chat = `${DAY}/chat.jsonl`
    await expect(
      read(new SlackAccessor(historyFails('not_in_channel')), spec(chat), null, row('2026-05-10')),
    ).rejects.toMatchObject({ code: 'EACCES', virtualPath: chat })
  })
})

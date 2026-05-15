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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { SlackApiError, type SlackResponse, type SlackTransport } from './_client.ts'
import { latestMessageTs, readdir } from './readdir.ts'

// Mirrors python/tests/core/slack/test_readdir_soft_errors.py — guards the
// behavior that Slack history errors like `not_in_channel` / `missing_scope`
// degrade to "no messages" rather than aborting a workspace-wide walk.

class FakeTransport implements SlackTransport {
  constructor(private readonly responder: (endpoint: string) => SlackResponse | Error) {}
  call(endpoint: string): Promise<SlackResponse> {
    const result = this.responder(endpoint)
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(result)
  }
}

describe('latestMessageTs soft errors', () => {
  it('returns null on not_in_channel', async () => {
    const t = new FakeTransport(() => new SlackApiError('conversations.history', 'not_in_channel'))
    const ts = await latestMessageTs(new SlackAccessor(t), 'C_INACCESSIBLE')
    expect(ts).toBeNull()
  })

  it('returns null on missing_scope', async () => {
    const t = new FakeTransport(
      () =>
        new SlackApiError(
          'conversations.history',
          'missing_scope',
          'channels:history',
          'channels:read',
        ),
    )
    const ts = await latestMessageTs(new SlackAccessor(t), 'C_NO_SCOPE')
    expect(ts).toBeNull()
  })

  it('returns null on channel_not_found', async () => {
    const t = new FakeTransport(
      () => new SlackApiError('conversations.history', 'channel_not_found'),
    )
    const ts = await latestMessageTs(new SlackAccessor(t), 'C_GONE')
    expect(ts).toBeNull()
  })

  it('returns null on is_archived', async () => {
    const t = new FakeTransport(() => new SlackApiError('conversations.history', 'is_archived'))
    const ts = await latestMessageTs(new SlackAccessor(t), 'C_ARCH')
    expect(ts).toBeNull()
  })

  it('re-raises unrelated errors (rate_limited)', async () => {
    const t = new FakeTransport(() => new SlackApiError('conversations.history', 'rate_limited'))
    await expect(latestMessageTs(new SlackAccessor(t), 'C1')).rejects.toThrow(/rate_limited/)
  })
})

describe('readdir on inaccessible channel', () => {
  it('returns [] dates instead of throwing when conversations.history fails', async () => {
    const idx = new RAMIndexCacheStore()
    const channelsPage = {
      ok: true,
      channels: [{ id: 'C_INACCESSIBLE', name: 'private', created: 1 }],
      response_metadata: { next_cursor: '' },
    }
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') return channelsPage
      if (endpoint === 'conversations.history') {
        return new SlackApiError('conversations.history', 'not_in_channel')
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const accessor = new SlackAccessor(t)
    // Prime parent (mirrors a prior `ls /slack/channels`).
    await readdir(
      accessor,
      new PathSpec({ original: '/slack/channels', directory: '/slack/channels', prefix: '/slack' }),
      idx,
    )
    const dates = await readdir(
      accessor,
      new PathSpec({
        original: '/slack/channels/private__C_INACCESSIBLE',
        directory: '/slack/channels/private__C_INACCESSIBLE',
        prefix: '/slack',
      }),
      idx,
    )
    expect(dates).toEqual([])
  })
})

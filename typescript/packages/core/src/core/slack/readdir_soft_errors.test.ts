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
import { describe, expect, it } from 'vitest'
import { SlackAccessor } from '../../accessor/slack.ts'
import type { DirListing } from '../../types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SlackApiError, type SlackResponse, type SlackTransport } from './client.ts'
import { latestMessageTs, listFiles, readdir } from './readdir.ts'

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
    const ws = new Workspace({ '/slack/': new SlackVFSBase({ accessor: new SlackAccessor(t) }) })
    // Lists the channels first, as a prior `ls /slack/channels` does.
    await ws.dispatch('readdir', '/slack/channels')
    const dates = await ws.dispatch('readdir', '/slack/channels/private__C_INACCESSIBLE')
    expect(dates).toEqual([])
  })
})

describe('readdir of a soft-error day', () => {
  it('lists the empty day as a window', async () => {
    // An empty day from not_in_channel is not the backend saying the day's
    // messages are gone, so it must not evict what an earlier listing held.
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return new SlackApiError('conversations.history', 'not_in_channel')
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const day = '/slack/channels/foo__C_INACCESSIBLE/2026-05-10'
    const own = new FileStat({
      name: '2026-05-10',
      type: FileType.DIRECTORY,
      extra: { channel_id: 'C_INACCESSIBLE' },
    })
    const out = (await readdir(
      new SlackAccessor(t),
      new PathSpec({ virtual: day, directory: day, vfsPath: mountKey(day, '/slack') }),
      own,
    )) as DirListing
    expect(out.entries).toEqual([])
    expect(out.window).toBe(true)
  })
})

describe('listFiles of a soft-error day', () => {
  // Reached when the files listing was evicted but the day survived; a soft
  // error there must not evict the attachments it listed before.
  it('writes the files listing as a window too', async () => {
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return new SlackApiError('conversations.history', 'not_in_channel')
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const own = new FileStat({
      name: 'files',
      type: FileType.DIRECTORY,
      extra: { channel_id: 'C1' },
    })
    const listing = await listFiles(
      new SlackAccessor(t),
      {
        kind: 'files',
        vfsPath: 'channels/c__C1/2026-05-10/files',
        slots: { day: '2026-05-10' },
      } as never,
      own,
    )
    expect((listing as DirListing).window).toBe(true)
  })
})

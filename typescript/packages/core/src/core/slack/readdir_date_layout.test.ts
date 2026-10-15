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
import { rowsOf } from '../hierarchy/probe.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
import { readdir } from './readdir.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (endpoint: string) => SlackResponse | Error) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    const result = this.responder(endpoint)
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(result)
  }
}

const PREFIX = '/mnt/slack'

function p(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, PREFIX) })
}

// A day's row as its channel's listing names it.
function dayRow(channel: string): FileStat {
  return new FileStat({
    name: '2024-01-01',
    type: FileType.DIRECTORY,
    extra: { channel_id: channel },
  })
}

const HISTORY: SlackResponse = {
  ok: true,
  messages: [
    {
      ts: '1704067300.0',
      text: 'hi',
      files: [
        {
          id: 'F1',
          name: 'design.pdf',
          size: 12,
          mimetype: 'application/pdf',
          url_private_download: 'https://files.slack.com/F1',
          timestamp: 100,
        },
      ],
    },
  ],
  response_metadata: { next_cursor: '' },
}

describe('readdir: date directory layout', () => {
  it('readdir(<chan>/<date>) returns ["chat.jsonl", "files"] and seeds the files', async () => {
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') return HISTORY
      throw new Error(`unexpected ${endpoint}`)
    })
    const day = `${PREFIX}/channels/general__C1/2024-01-01`
    const out = (await readdir(new SlackAccessor(t), p(day), dayRow('C1'))) as DirListing
    expect(rowsOf(out).map((row) => `${day}/${row.name}`)).toEqual([
      `${day}/chat.jsonl`,
      `${day}/files`,
    ])
    expect((out.seeds.get('files') ?? []).map((row) => row.name)).toEqual(['design__F1.pdf'])
  })

  it('readdir(<chan>/<date>/files) is served from the day listing', async () => {
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') {
        return {
          ok: true,
          channels: [{ id: 'C1', name: 'general', created: 0 }],
          response_metadata: { next_cursor: '' },
        }
      }
      if (endpoint === 'conversations.history') return HISTORY
      throw new Error(`unexpected ${endpoint}`)
    })
    const ws = new Workspace({
      [`${PREFIX}/`]: new SlackVFSBase({ accessor: new SlackAccessor(t) }),
    })
    const day = `${PREFIX}/channels/general__C1/2024-01-01`
    await ws.dispatch('readdir', day)
    const before = t.calls.length
    const out = await ws.dispatch('readdir', `${day}/files`)
    expect(out).toEqual([`${day}/files/design__F1.pdf`])
    expect(t.calls).toHaveLength(before)
  })

  it('readdir(<chan>/<date>) seals empty when conversations.history hits not_in_channel', async () => {
    const t = new FakeTransport(() => {
      const err = new Error('Slack API error (conversations.history): not_in_channel')
      return err
    })
    const out = await readdir(
      new SlackAccessor(t),
      p(`${PREFIX}/channels/priv__CX/2024-01-01`),
      dayRow('CX'),
    )
    expect(rowsOf(out)).toEqual([])
  })
})

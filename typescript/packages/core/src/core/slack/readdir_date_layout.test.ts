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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'
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

function p(original: string): PathSpec {
  return new PathSpec({ original, directory: original, prefix: PREFIX })
}

describe('readdir: date directory layout', () => {
  it('readdir(<chan>/<date>) returns ["chat.jsonl", "files"] and seals via fetch_day', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir(`${PREFIX}/channels`, [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    await idx.setDir(`${PREFIX}/channels/general__C1`, [
      [
        '2024-01-01',
        new IndexEntry({
          id: 'C1:2024-01-01',
          name: '2024-01-01',
          resourceType: 'slack/date_dir',
          vfsName: '2024-01-01',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return {
          ok: true,
          messages: [
            {
              ts: '100.0',
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
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const out = await readdir(
      new SlackAccessor(t),
      p(`${PREFIX}/channels/general__C1/2024-01-01`),
      idx,
    )
    expect(out).toEqual([
      `${PREFIX}/channels/general__C1/2024-01-01/chat.jsonl`,
      `${PREFIX}/channels/general__C1/2024-01-01/files`,
    ])
    const filesListing = await idx.listDir(`${PREFIX}/channels/general__C1/2024-01-01/files`)
    expect(filesListing.entries).toEqual([
      `${PREFIX}/channels/general__C1/2024-01-01/files/design__F1.pdf`,
    ])
  })

  it('readdir(<chan>/<date>/files) returns cached blob names', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir(`${PREFIX}/channels`, [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    await idx.setDir(`${PREFIX}/channels/general__C1`, [
      [
        '2024-01-01',
        new IndexEntry({
          id: 'C1:2024-01-01',
          name: '2024-01-01',
          resourceType: 'slack/date_dir',
          vfsName: '2024-01-01',
        }),
      ],
    ])
    await idx.setDir(`${PREFIX}/channels/general__C1/2024-01-01`, [
      [
        'chat.jsonl',
        new IndexEntry({
          id: 'C1:2024-01-01:chat',
          name: 'chat.jsonl',
          resourceType: 'slack/chat_jsonl',
          vfsName: 'chat.jsonl',
        }),
      ],
      [
        'files',
        new IndexEntry({
          id: 'C1:2024-01-01:files',
          name: 'files',
          resourceType: 'slack/files_dir',
          vfsName: 'files',
        }),
      ],
    ])
    await idx.setDir(`${PREFIX}/channels/general__C1/2024-01-01/files`, [
      [
        'spec__F1.pdf',
        new IndexEntry({
          id: 'F1',
          name: 'spec.pdf',
          resourceType: 'slack/file',
          vfsName: 'spec__F1.pdf',
          extra: { mimetype: 'application/pdf' },
        }),
      ],
    ])
    const t = new FakeTransport(() => {
      throw new Error('should not be called')
    })
    const out = await readdir(
      new SlackAccessor(t),
      p(`${PREFIX}/channels/general__C1/2024-01-01/files`),
      idx,
    )
    expect(out).toEqual([`${PREFIX}/channels/general__C1/2024-01-01/files/spec__F1.pdf`])
    expect(t.calls).toHaveLength(0)
  })

  it('readdir(<chan>/<date>) seals empty when conversations.history hits not_in_channel', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir(`${PREFIX}/channels`, [
      [
        'priv__CX',
        new IndexEntry({
          id: 'CX',
          name: 'priv',
          resourceType: 'slack/channel',
          vfsName: 'priv__CX',
          remoteTime: '0',
        }),
      ],
    ])
    await idx.setDir(`${PREFIX}/channels/priv__CX`, [
      [
        '2024-01-01',
        new IndexEntry({
          id: 'CX:2024-01-01',
          name: '2024-01-01',
          resourceType: 'slack/date_dir',
          vfsName: '2024-01-01',
        }),
      ],
    ])
    const t = new FakeTransport(() => {
      const err = new Error('Slack API error (conversations.history): not_in_channel')
      return err
    })
    const out = await readdir(
      new SlackAccessor(t),
      p(`${PREFIX}/channels/priv__CX/2024-01-01`),
      idx,
    )
    expect(out).toEqual([])
  })
})

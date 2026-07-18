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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { SlackResponse, SlackTransport } from '../../core/slack/_client.ts'
import { PathSpec, ResourceName } from '../../types.ts'
import { SLACK_VFS_OPS } from './index.ts'

const readOp = SLACK_VFS_OPS.find((o) => o.name === 'read' && o.filetype === null)
if (!readOp) throw new Error('slack read op not registered')

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse,
  ) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(endpoint, params))
  }
}

describe('ops/slack/read', () => {
  it('is registered against ResourceName.SLACK as a non-write read op', () => {
    expect(readOp.name).toBe('read')
    expect(readOp.resource).toBe(ResourceName.SLACK)
    expect(readOp.write).toBe(false)
    expect(readOp.filetype).toBeNull()
  })

  it('dispatches to coreRead using the resource accessor', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/users', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'slack/user',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'users.info') {
        return { ok: true, user: { id: 'U1', name: 'alice' } }
      }
      return { ok: true }
    })
    const accessor = new SlackAccessor(t)
    const out = (await readOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/slack/users/alice__U1.json',
        directory: '/mnt/slack/users/alice__U1.json',
        resourcePath: mountKey('/mnt/slack/users/alice__U1.json', '/mnt/slack'),
      }),
      [],
      { index: idx },
    )) as Uint8Array
    const parsed = JSON.parse(new TextDecoder().decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({ id: 'U1', name: 'alice' })
    const infoCall = t.calls.find((c) => c.endpoint === 'users.info')
    expect(infoCall?.params?.user).toBe('U1')
  })
})

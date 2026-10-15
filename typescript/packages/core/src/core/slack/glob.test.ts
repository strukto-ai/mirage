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
import { PathSpec } from '../../types.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
import { readdir as slackReaddir } from './readdir.ts'

class FakeSlackTransport implements SlackTransport {
  public readonly calls: string[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse = () => ({ ok: true }),
  ) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push(endpoint)
    return Promise.resolve(this.responder(endpoint, params))
  }
}

async function listedPaths(accessor: SlackAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  return rowsOf(await slackReaddir(accessor, path)).map((row) => `${base}/${row.name}`)
}

const resolveSlackGlob = makeResolveGlob(listedPaths)

describe('resolveSlackGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const t = new FakeSlackTransport()
    const resolved = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/slack/channels/general__C1/',
      vfsPath: mountKey('/mnt/slack/channels/general__C1/2026-04-24.jsonl', '/mnt/slack'),
      resolved: true,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [resolved])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(t.calls).toHaveLength(0)
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const t = new FakeSlackTransport()
    const noPattern = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1',
      directory: '/mnt/slack/channels/general__C1',
      vfsPath: mountKey('/mnt/slack/channels/general__C1', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [noPattern])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(t.calls).toHaveLength(0)
  })
})

function blob(id: string, name: string, mimetype: string): Record<string, unknown> {
  return { id, name, mimetype, size: 1, url_private_download: 'u' }
}

describe('a glob through a mount', () => {
  it("matches a day's files by their names", async () => {
    const latest = Date.UTC(2026, 3, 10, 12) / 1000
    const t = new FakeSlackTransport((endpoint, params) => {
      if (endpoint === 'conversations.list') {
        return {
          ok: true,
          channels: [{ id: 'C001', name: 'general', created: 1 }],
          response_metadata: { next_cursor: '' },
        }
      }
      if (endpoint === 'conversations.history') {
        if (params?.limit === '1') return { ok: true, messages: [{ ts: latest.toFixed(6) }] }
        return {
          ok: true,
          messages: [
            {
              ts: '1775800000.000100',
              files: [blob('F1', 'a.pdf', 'application/pdf'), blob('F2', 'b.txt', 'text/plain')],
            },
          ],
          response_metadata: { next_cursor: '' },
        }
      }
      return { ok: true }
    })
    const ws = new Workspace(
      { '/slack/': new SlackVFSBase({ accessor: new SlackAccessor(t) }) },
      { shellParser: await getTestParser() },
    )
    try {
      const result = await ws.shell('echo /slack/channels/general__C001/2026-04-10/files/*.pdf')
      expect(result.stdoutText.split(/\s+/).filter((w) => w !== '')).toEqual([
        '/slack/channels/general__C001/2026-04-10/files/a__F1.pdf',
      ])
    } finally {
      await ws.close()
    }
  })
})

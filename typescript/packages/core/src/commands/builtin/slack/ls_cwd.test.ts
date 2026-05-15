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
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeSlackTransport, makeFakeResource } from './_test_util.ts'
import { SLACK_LS } from './ls.ts'

const DEC = new TextDecoder()

// Regression guard for the Python-side bug fixed in PR #48: `ls` (no args)
// after `cd /slack/...` would return [] because the cwd PathSpec was rebuilt
// without preserving the mount prefix. TS doesn't reproduce the bug today
// (opts.cwd is a string and opts.mountPrefix is set separately by
// Mount.executeCmd), but this test pins the contract so a future refactor
// that drops `prefix: opts.mountPrefix ?? ''` from slack/ls.ts surfaces
// immediately.
describe('slack ls (no args) after cd preserves mount prefix', () => {
  it('cwd=/slack/channels/general__C1 + mountPrefix=/slack returns date entries', async () => {
    const idx = new RAMIndexCacheStore()
    const channelsPage = {
      ok: true,
      channels: [{ id: 'C1', name: 'general', created: 1700000000 }],
      response_metadata: { next_cursor: '' },
    }
    const historyPage = {
      ok: true,
      messages: [{ ts: '1700050000.0', text: 'hi' }],
      has_more: false,
    }
    const transport = new FakeSlackTransport((endpoint) => {
      if (endpoint === 'conversations.list') return channelsPage
      if (endpoint === 'conversations.history') return historyPage
      throw new Error(`unexpected ${endpoint}`)
    })
    const resource = makeFakeResource(transport)
    const cmd = SLACK_LS[0]
    if (cmd === undefined) throw new Error('ls not registered')
    // Prime parent so the channel is cached (mirrors what `cd` would force)
    await cmd.fn(
      resource.accessor,
      [
        new PathSpec({
          original: '/slack/channels',
          directory: '/slack/channels',
          resolved: false,
          prefix: '/slack',
        }),
      ],
      [],
      {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/slack/channels',
        mountPrefix: '/slack',
        resource,
        index: idx,
      },
    )

    // Now: ls (no args) with cwd = the channel directory, mountPrefix = /slack
    const out = await cmd.fn(resource.accessor, [], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/slack/channels/general__C1',
      mountPrefix: '/slack',
      resource,
      index: idx,
    })
    expect(out).not.toBeNull()
    const [bytes] = out as [Uint8Array, unknown]
    const stdout =
      bytes instanceof Uint8Array
        ? DEC.decode(bytes)
        : DEC.decode(await materialize(bytes as AsyncIterable<Uint8Array>))
    expect(stdout.trim()).not.toBe('')
    const first = stdout.trim().split('\n')[0] ?? ''
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })
})

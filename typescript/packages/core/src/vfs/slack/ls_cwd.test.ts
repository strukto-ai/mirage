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
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { FakeSlackTransport, makeFakeVfs } from './_test_util.ts'

// Regression guard for the Python-side bug fixed in PR #48: `ls` (no args)
// after `cd /slack/...` would return [] because the cwd PathSpec was rebuilt
// without preserving the mount prefix.
describe('slack ls (no args) after cd preserves mount prefix', () => {
  it('cwd=/slack/channels/general__C1 returns date entries', async () => {
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
    const ws = new Workspace(
      { '/slack/': makeFakeVfs(transport) },
      { shellParser: await getTestParser() },
    )
    try {
      const io = await ws.shell('cd /slack/channels/general__C1 && ls')
      const stdout = new TextDecoder().decode(io.stdout)
      expect(stdout.trim()).not.toBe('')
      const first = stdout.trim().split('\n')[0] ?? ''
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2}/)
    } finally {
      await ws.close()
    }
  })
})

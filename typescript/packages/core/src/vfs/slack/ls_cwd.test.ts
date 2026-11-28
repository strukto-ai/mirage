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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { SlackVFS } from './slack.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

// Regression guard for the Python-side bug fixed in PR #48: `ls` (no args)
// after `cd /slack/...` would return [] because the cwd PathSpec was rebuilt
// without preserving the mount prefix.
describe('slack ls (no args) after cd preserves mount prefix', () => {
  it('cwd=/slack/channels/general__C1 returns date entries', async () => {
    const ws = new Workspace({ '/slack/': new SlackVFS({ accessor: workspace.accessor() }) })
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

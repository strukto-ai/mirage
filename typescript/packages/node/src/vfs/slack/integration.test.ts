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

import { SLACK } from '@struktoai/mirage-core/commands/cli/builtin/slack/index'
import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { SlackVFS } from '@struktoai/mirage-core/vfs/direct/slack'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { SlackWorkspace } from '../../../../core/tests/fixtures/slack_workspace.ts'

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

function mounted(): Workspace {
  return new Workspace({ '/slack': new SlackVFS(workspace.config()) }, { mode: MountMode.READ })
}

describe('SlackVFS integration', () => {
  it('ls /slack/channels/ returns channel directory names', async () => {
    const ws = mounted()
    try {
      const result = await ws.shell('ls /slack/channels/')
      if (result.exitCode !== 0) {
        throw new Error(`ls failed: ${result.stderrText} | stdout: ${result.stdoutText}`)
      }
      expect(result.stdoutText).toContain('general__C1')
      expect(result.stdoutText).toContain('random__C2')
    } finally {
      await ws.close()
    }
  })

  it('cat reads jsonl history for a channel/date', async () => {
    const ws = mounted()
    try {
      const ls = await ws.shell('ls /slack/channels/general__C1/')
      if (ls.exitCode !== 0) {
        throw new Error(`ls failed: ${ls.stderrText} | stdout: ${ls.stdoutText}`)
      }
      expect(ls.stdoutText).toContain('2025-11-03')
      const cat = await ws.shell('cat /slack/channels/general__C1/2025-11-03/chat.jsonl')
      expect(cat.exitCode).toBe(0)
      const lines = cat.stdoutText
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { user?: string; text?: string })
      expect(lines.map((m) => [m.user, m.text])).toEqual([
        ['U1', 'the deploy is done at acme'],
        ['U2', 'coffee is ready'],
      ])
    } finally {
      await ws.close()
    }
  })

  it('the slack CLI list-members verb returns filtered users', async () => {
    const ws = mounted()
    const { token, baseUrl } = workspace.config()
    ws.registerCli('slack', SLACK, { token, baseUrl })
    try {
      const result = await ws.shell('slack list-members --query ana')
      expect(result.exitCode).toBe(0)
      const users = JSON.parse(result.stdoutText) as { id: string; name: string }[]
      expect(users.map((u) => u.name)).toEqual(['ana'])
    } finally {
      await ws.close()
    }
  })
})

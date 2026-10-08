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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { buildOptions } from './options.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

describe('buildOptions', () => {
  it('registers the mirage MCP server', async () => {
    const options = await buildOptions(mkWs())
    expect(options.mcpServers).toBeDefined()
    expect(options.mcpServers?.mirage).toBeDefined()
  })

  it('allows only mirage tools', async () => {
    const options = await buildOptions(mkWs())
    expect(options.allowedTools).toContain('mcp__mirage__*')
  })

  it('uses the default system prompt', async () => {
    const options = await buildOptions(mkWs())
    expect(typeof options.systemPrompt).toBe('string')
    expect((options.systemPrompt as string).length).toBeGreaterThan(0)
  })

  it('honors a custom system prompt', async () => {
    const options = await buildOptions(mkWs(), { systemPrompt: 'custom prompt' })
    expect(options.systemPrompt).toBe('custom prompt')
  })
})

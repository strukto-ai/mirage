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

import Anthropic from '@anthropic-ai/sdk'
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { mirageTools } from './tools.ts'

function toolsFor(mode: MountMode = MountMode.WRITE): Record<string, BetaRunnableTool> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode })
  return Object.fromEntries(mirageTools(ws).map((tool) => [tool.name, tool]))
}

async function run(
  tool: BetaRunnableTool | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool === undefined) throw new Error('no such tool')
  const result = await tool.run(tool.parse(args))
  return typeof result === 'string' ? result : JSON.stringify(result)
}

describe('mirageTools', () => {
  it('carries the toolset names', () => {
    expect(Object.keys(toolsFor())).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep'])
  })

  it('hands an environment worker the tools', () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const worker = new Anthropic({ apiKey: 'test' }).beta.environments.work.worker({
      environmentId: 'env',
      environmentKey: 'key',
      tools: mirageTools(ws),
    })
    const tools = Array.isArray(worker.tools) ? worker.tools : []
    expect(tools.map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
    ])
  })

  it('offers no write or edit on a read-only workspace', () => {
    const names = Object.keys(toolsFor(MountMode.READ))
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })

  it('keeps the bash directory and resolves files against it', async () => {
    const tools = toolsFor()
    await run(tools.bash, { command: 'mkdir -p /w && cd /w' })
    const wrote = await run(tools.write, { file_path: 'a.txt', content: 'hi\n' })
    const where = await run(tools.bash, { command: 'pwd; cat a.txt' })
    const found = await run(tools.glob, { pattern: '*.txt' })
    expect(wrote).toContain('a.txt')
    expect(where).toBe('/w\nhi\n')
    expect(found).toBe('/w/a.txt\n')
  })

  it('turns a failing command into a tool error', async () => {
    const tools = toolsFor()
    await expect(run(tools.bash, { command: 'echo nope >&2; exit 3' })).rejects.toThrow(ToolError)
  })

  it('refuses a restart rather than faking one', async () => {
    const tools = toolsFor()
    await expect(run(tools.bash, { restart: true })).rejects.toThrow(/not supported/)
  })

  it('turns a command past its timeout into a tool error', async () => {
    const tools = toolsFor()
    await expect(run(tools.bash, { command: 'sleep 5', timeout_ms: 50 })).rejects.toThrow(
      /timed out/,
    )
  })

  it('reads a line range', async () => {
    const tools = toolsFor()
    await run(tools.write, { file_path: '/n.txt', content: 'a\nb\nc\nd\n' })
    const text = await run(tools.read, { file_path: '/n.txt', view_range: [2, 3] })
    expect(text).toContain('b')
    expect(text).toContain('c')
    expect(text).not.toContain('a')
    expect(text).not.toContain('d')
  })

  it('edits text after a read', async () => {
    const tools = toolsFor()
    await run(tools.write, { file_path: '/e.txt', content: 'hello\n' })
    await run(tools.read, { file_path: '/e.txt' })
    await run(tools.edit, { file_path: '/e.txt', old_string: 'hello', new_string: 'hi' })
    expect(await run(tools.grep, { pattern: 'hi', path: '/' })).toContain('/e.txt:1:hi')
  })

  it('turns a missing file into a tool error', async () => {
    const tools = toolsFor()
    await expect(run(tools.read, { file_path: '/missing.txt' })).rejects.toThrow(/not found/)
  })
})

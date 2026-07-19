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
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { mirageExtension } from './extension.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

interface FakePi {
  api: ExtensionAPI
  tools: ToolDefinition[]
}

function fakePi(): FakePi {
  const tools: ToolDefinition[] = []
  const stub = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool)
    },
  }
  return { api: stub as unknown as ExtensionAPI, tools }
}

describe('mirageExtension', () => {
  it('registers all 7 built-in tools by name', async () => {
    const pi = fakePi()
    const factory = mirageExtension(mkWs())
    await factory(pi.api)
    const names = pi.tools.map((t) => t.name).sort()
    expect(names).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  })

  it('preserves pi tool schemas (read has path/offset/limit)', async () => {
    const pi = fakePi()
    await mirageExtension(mkWs())(pi.api)
    const read = pi.tools.find((t) => t.name === 'read')
    expect(read).toBeDefined()
    if (read === undefined) throw new Error('unreachable')
    const props = (read.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['limit', 'offset', 'path'])
  })

  it('uses /-rooted cwd by default (pi factories accept it)', async () => {
    const pi = fakePi()
    await mirageExtension(mkWs())(pi.api)
    expect(pi.tools.length).toBe(7)
  })

  it('honors custom cwd', async () => {
    const pi = fakePi()
    await mirageExtension(mkWs(), { cwd: '/data' })(pi.api)
    expect(pi.tools.length).toBe(7)
  })
})

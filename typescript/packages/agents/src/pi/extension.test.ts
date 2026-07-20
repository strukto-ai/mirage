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
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ToolDefinition,
  UserBashEvent,
  UserBashEventResult,
} from '@earendil-works/pi-coding-agent'
import { mirageExtension } from './extension.ts'

function extensionFactory(ws: Workspace, opts?: Parameters<typeof mirageExtension>[1]) {
  const extension = mirageExtension(ws, opts)
  if (typeof extension === 'function') return extension
  return extension.factory
}

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

interface FakePi {
  api: ExtensionAPI
  tools: ToolDefinition[]
  beforeAgentStart:
    | ((
        event: BeforeAgentStartEvent,
      ) =>
        | Promise<BeforeAgentStartEventResult | undefined>
        | BeforeAgentStartEventResult
        | undefined)
    | undefined
  userBash:
    | ((
        event: UserBashEvent,
      ) => Promise<UserBashEventResult | undefined> | UserBashEventResult | undefined)
    | undefined
}

function fakePi(): FakePi {
  const tools: ToolDefinition[] = []
  const pi: FakePi = {
    api: undefined as unknown as ExtensionAPI,
    tools,
    beforeAgentStart: undefined,
    userBash: undefined,
  }
  const stub = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool)
    },
    on: (event: string, handler: FakePi['userBash'] | FakePi['beforeAgentStart']) => {
      if (event === 'user_bash') pi.userBash = handler as FakePi['userBash']
      if (event === 'before_agent_start') {
        pi.beforeAgentStart = handler as FakePi['beforeAgentStart']
      }
    },
  }
  pi.api = stub as unknown as ExtensionAPI
  return pi
}

describe('mirageExtension', () => {
  it('registers all 7 built-in tools by name', async () => {
    const pi = fakePi()
    const extension = mirageExtension(mkWs())
    expect(typeof extension).not.toBe('function')
    if (typeof extension === 'function') throw new Error('unreachable')
    expect(extension.name).toBe('mirage')
    const factory = extension.factory
    await factory(pi.api)
    const names = pi.tools.map((t) => t.name).sort()
    expect(names).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  })

  it('preserves pi tool schemas (read has path/offset/limit)', async () => {
    const pi = fakePi()
    await extensionFactory(mkWs())(pi.api)
    const read = pi.tools.find((t) => t.name === 'read')
    expect(read).toBeDefined()
    if (read === undefined) throw new Error('unreachable')
    const props = (read.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['limit', 'offset', 'path'])
  })

  it('uses /-rooted cwd by default (pi factories accept it)', async () => {
    const pi = fakePi()
    await extensionFactory(mkWs())(pi.api)
    expect(pi.tools.length).toBe(7)
  })

  it('honors custom cwd', async () => {
    const pi = fakePi()
    await extensionFactory(mkWs(), { cwd: '/data' })(pi.api)
    expect(pi.tools.length).toBe(7)
  })

  it('adds Mirage instructions without replacing Pi system prompt', async () => {
    const pi = fakePi()
    await extensionFactory(mkWs())(pi.api)
    expect(pi.beforeAgentStart).toBeDefined()
    if (pi.beforeAgentStart === undefined) throw new Error('unreachable')
    const result = await pi.beforeAgentStart({
      systemPrompt: 'Pi base prompt',
    } as BeforeAgentStartEvent)
    expect(result?.systemPrompt).toContain('Pi base prompt')
    expect(result?.systemPrompt).toContain('Your filesystem is powered by Mirage')
  })

  it('can leave the Pi system prompt unchanged', async () => {
    const pi = fakePi()
    await extensionFactory(mkWs(), { systemPrompt: false })(pi.api)
    expect(pi.beforeAgentStart).toBeUndefined()
  })

  it('routes interactive ! commands through Mirage at the virtual cwd', async () => {
    const ws = mkWs()
    await ws.fs.mkdir('/data')
    const pi = fakePi()
    await extensionFactory(ws, { cwd: '/data' })(pi.api)
    expect(pi.userBash).toBeDefined()
    if (pi.userBash === undefined) throw new Error('unreachable')
    const event: UserBashEvent = {
      type: 'user_bash',
      command: 'pwd',
      excludeFromContext: false,
      cwd: process.cwd(),
    }
    const routed = await pi.userBash(event)
    expect(routed?.operations).toBeDefined()
    if (routed?.operations === undefined) throw new Error('unreachable')
    const chunks: Buffer[] = []
    await routed.operations.exec('pwd', process.cwd(), {
      onData: (chunk) => chunks.push(chunk),
    })
    expect(Buffer.concat(chunks).toString()).toBe('/data\n')
  })
})

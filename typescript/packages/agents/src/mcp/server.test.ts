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

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { createMirageMcpServer } from './server.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const first: unknown = content[0]
  if (first === null || typeof first !== 'object') return ''
  const text: unknown = (first as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

describe('createMirageMcpServer', () => {
  it('exposes Mirage tools over the MCP protocol', async () => {
    const workspace = mkWs()
    const server = createMirageMcpServer(workspace)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      ['edit', 'execute_command', 'grep', 'ls', 'read', 'write'].sort(),
    )
    const write = await client.callTool({
      name: 'write',
      arguments: { path: '/hello.txt', content: 'hello\n' },
    })
    expect(write.isError).not.toBe(true)
    const read = await client.callTool({ name: 'read', arguments: { path: '/hello.txt' } })
    expect(firstText(read.content)).toContain('hello')
    await client.close()
    await server.close()
    await workspace.close()
  })

  it('requires a reread after an external change', async () => {
    const workspace = mkWs()
    await workspace.fs.writeFile('/doc.txt', 'first')
    const server = createMirageMcpServer(workspace)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await client.callTool({ name: 'read', arguments: { path: '/doc.txt' } })
    await workspace.fs.writeFile('/doc.txt', 'external')
    const stale = await client.callTool({
      name: 'edit',
      arguments: { path: '/doc.txt', old_string: 'external', new_string: 'changed' },
    })
    expect(stale.isError).toBe(true)
    expect(firstText(stale.content)).toContain('changed since it was last read')
    await client.callTool({ name: 'read', arguments: { path: '/doc.txt' } })
    const edit = await client.callTool({
      name: 'edit',
      arguments: { path: '/doc.txt', old_string: 'external', new_string: 'changed' },
    })
    expect(edit.isError).not.toBe(true)
    expect(await workspace.fs.readFileText('/doc.txt')).toBe('changed')
    await client.close()
    await server.close()
    await workspace.close()
  })
})

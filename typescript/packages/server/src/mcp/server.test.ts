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

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { OpsRegistry } from '@struktoai/mirage-core/ops/registry'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { createMirageMcpServer } from './server.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
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
      ['edit', 'glob', 'grep', 'ls', 'read', 'shell', 'write'].sort(),
    )
    const write = await client.callTool({
      name: 'write',
      arguments: { path: '/hello.txt', content: 'hello\n' },
    })
    expect(write.isError).not.toBe(true)
    const read = await client.callTool({ name: 'read', arguments: { path: '/hello.txt' } })
    expect(firstText(read.content)).toContain('hello')
    const globbed = await client.callTool({ name: 'glob', arguments: { pattern: '*.txt' } })
    expect(firstText(globbed.content)).toBe('/hello.txt\n')
    await client.close()
    await server.close()
    await workspace.close()
  })

  it("advertises each tool's arguments and read-only hint", async () => {
    const workspace = mkWs()
    const server = createMirageMcpServer(workspace)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]))
    const required = (name: string): unknown => tools.get(name)?.inputSchema.required
    const readOnly = (name: string): unknown => tools.get(name)?.annotations?.readOnlyHint
    expect(required('shell')).toEqual(['command'])
    expect(required('read')).toEqual(['path'])
    expect(required('write')).toEqual(['path', 'content'])
    expect(required('edit')).toEqual(['path', 'old_string', 'new_string'])
    expect(required('ls')).toEqual(['path'])
    expect(required('grep')).toEqual(['pattern', 'path'])
    expect(required('glob')).toEqual(['pattern'])
    expect(tools.get('read')?.inputSchema.properties).toMatchObject({
      path: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1 },
    })
    expect(tools.get('edit')?.inputSchema.properties).toMatchObject({
      replace_all: { type: 'boolean' },
    })
    expect(['read', 'ls', 'grep', 'glob'].map(readOnly)).toEqual([true, true, true, true])
    expect(['shell', 'write', 'edit'].map(readOnly)).toEqual([undefined, undefined, undefined])
    await client.close()
    await server.close()
    await workspace.close()
  })

  it('rejects an unknown tool and answers bad arguments with an error result', async () => {
    const workspace = mkWs()
    const server = createMirageMcpServer(workspace)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: 'Tool nope not found',
    })
    const missing = await client.callTool({ name: 'read', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(firstText(missing.content)).toContain(
      'Input validation error: Invalid arguments for tool read: ',
    )
    const outside = await client.callTool({
      name: 'read',
      arguments: { path: '/a.txt', offset: -1 },
    })
    expect(outside.isError).toBe(true)
    expect(firstText(outside.content)).toContain(
      'Input validation error: Invalid arguments for tool read: ',
    )
    await client.close()
    await server.close()
    await workspace.close()
  })

  it('requires a reread after an external change', async () => {
    const workspace = mkWs()
    await workspace.vfs.write('/doc.txt', 'first')
    const server = createMirageMcpServer(workspace)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await client.callTool({ name: 'read', arguments: { path: '/doc.txt' } })
    await workspace.vfs.write('/doc.txt', 'external')
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
    expect(await workspace.vfs.cat('/doc.txt')).toBe('changed')
    await client.close()
    await server.close()
    await workspace.close()
  })
})

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

import { stderr, stdout } from 'node:process'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it, vi } from 'vitest'
import * as ioSerde from '../io_serde.ts'
import { VFS_CALLS } from '../vfs_calls.ts'
import { createMirageMcpServer } from './server.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
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

  it("lists the tools the session's profile leaves it", async () => {
    const workspace = mkWs()
    workspace.createSession('ro', { profile: parseSessionProfile({ mounts: { '/': 'read' } }) })
    const server = createMirageMcpServer(workspace, { sessionId: 'ro' })
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(['shell', 'read', 'ls', 'grep', 'glob'])
    await expect(
      client.callTool({ name: 'write', arguments: { path: '/x', content: 'y' } }),
    ).rejects.toThrow(/Tool write not found/)
    await client.close()
    await server.close()
    await workspace.close()
  })

  it('reads the tool list on every request', async () => {
    const workspace = mkWs()
    // The server is built before the session exists, as it is for a
    // stored session that loads later: the list still follows its profile.
    const server = createMirageMcpServer(workspace, { sessionId: 'late' })
    workspace.createSession('late', { profile: parseSessionProfile({ mounts: { '/': 'read' } }) })
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).not.toContain('write')
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

  it('keeps the original VFS failure on stderr while redacting the MCP response', async () => {
    const workspace = mkWs()
    const server = createMirageMcpServer(workspace, { allCalls: true })
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const err = new Error('backend token=secret')
    const answered = vi.spyOn(ioSerde, 'answered').mockRejectedValue(err)
    const diagnostics = vi.spyOn(stderr, 'write').mockReturnValue(true)
    const protocolOutput = vi.spyOn(stdout, 'write').mockReturnValue(true)
    try {
      const result = await client.callTool({ name: 'vfs_read', arguments: { path: '/file' } })
      expect(result.isError).toBe(true)
      expect(JSON.parse(firstText(result.content))).toEqual({ detail: 'internal server error' })
      expect(diagnostics.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(err.stack)
      expect(protocolOutput).not.toHaveBeenCalled()
    } finally {
      answered.mockRestore()
      diagnostics.mockRestore()
      protocolOutput.mockRestore()
      await client.close()
      await server.close()
      await workspace.close()
    }
  })

  it('serves the VFS calls and explain with allCalls', async () => {
    const workspace = mkWs()
    const server = createMirageMcpServer(workspace, { allCalls: true })
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = new Map(
      (await client.listTools()).tools.map((tool) => [
        tool.name,
        tool.inputSchema.properties ?? {},
      ]),
    )
    expect(tools.size).toBe(7 + VFS_CALLS.length)
    expect(tools.get('shell')).toHaveProperty('explain')
    expect(tools.get('vfs_write')).toHaveProperty('explain')
    expect(tools.get('read')).not.toHaveProperty('explain')
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args })
    await call('vfs_write', { path: '/a', data_base64: 'aGk=' })
    const read = await call('vfs_read', { path: '/a' })
    const missing = await call('vfs_read', { path: '/nope' })
    const line = await call('shell', { command: 'rm /a', explain: true })
    expect(JSON.parse(firstText(read.content))).toEqual({ data_base64: 'aGk=' })
    expect(missing.isError).toBe(true)
    expect(JSON.parse(firstText(missing.content))).toMatchObject({ errno: 'ENOENT' })
    expect(JSON.parse(firstText(line.content))).toMatchObject({ outcome: 'allow' })
    expect(await workspace.vfs.exists('/a')).toBe(true)
    await client.close()
    await server.close()
    await workspace.close()
  })
})

it('delivers request-scoped previews before completion and preserves final output', async () => {
  const workspace = mkWs()
  const server = createMirageMcpServer(workspace)
  const client = new Client({ name: 'progress-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const updates: { progress: number; message?: string | undefined }[] = []
  let first!: () => void
  const ready = new Promise<void>((resolve) => {
    first = resolve
  })
  let completed = false
  try {
    const task = client
      .callTool(
        {
          name: 'shell',
          arguments: {
            command:
              'echo ready; while [ ! -f /gate ]; do sleep 0.01; done; echo problem >&2; false',
          },
        },
        {
          onprogress: (update) => {
            updates.push(update)
            first()
          },
        },
      )
      .then((result) => {
        completed = true
        return result
      })
    await ready
    expect(completed).toBe(false)
    await workspace.vfs.write('/gate', new TextEncoder().encode('ready'))
    const result = await task
    expect(firstText(result.content)).toBe('ready\n\nproblem\n')
    expect(result.isError).toBe(true)
    expect(updates[0]).toEqual({ progress: 1, message: '[stdout] ready\n' })
    expect(updates.some((update) => update.message === '[stderr] problem\n')).toBe(true)
    expect(updates.map((update) => update.progress)).toEqual(
      updates.map((_update, index) => index + 1),
    )
  } finally {
    await client.close()
    await server.close()
    await workspace.close()
  }
})

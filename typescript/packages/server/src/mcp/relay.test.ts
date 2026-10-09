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

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { AuthMode } from '../auth/config.ts'
import { McpRelay, relayStdio } from './relay.ts'
import { createMirageMcpServer } from './server.ts'

const closers: (() => Promise<void>)[] = []

async function linked(server: {
  connect: (t: InMemoryTransport) => Promise<void>
  close: () => Promise<void>
}): Promise<Client> {
  const client = new Client({ name: 'mirage-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(
    () => client.close(),
    () => server.close(),
  )
  return client
}

async function relayed(): Promise<{ upstream: Client; client: Client }> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  const upstream = await linked(createMirageMcpServer(ws))
  const client = await linked(new McpRelay(upstream).server)
  return { upstream, client }
}

function firstText(content: unknown): string {
  return (content as { text?: string }[])[0]?.text ?? ''
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
})

describe('McpRelay', () => {
  it('relays the tool table', async () => {
    const { upstream, client } = await relayed()
    expect(await client.listTools()).toEqual(await upstream.listTools())
  })

  it('relays a tool call', async () => {
    const { client } = await relayed()
    await client.callTool({ name: 'shell', arguments: { command: 'mkdir /d && cd /d' } })
    const result = await client.callTool({ name: 'shell', arguments: { command: 'pwd' } })
    expect(firstText(result.content)).toBe('/d\n')
    expect(result.isError).not.toBe(true)
  })

  it('relays a protocol error', async () => {
    const { client } = await relayed()
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: 'Tool nope not found',
    })
  })

  it('forwards request-scoped progress and preserves the final tool result', async () => {
    const { client } = await relayed()
    const updates: { progress: number; message?: string | undefined }[] = []
    const result = await client.callTool(
      { name: 'shell', arguments: { command: 'echo out; echo err >&2; false' } },
      {
        onprogress: (update) => {
          updates.push(update)
        },
      },
    )
    expect(firstText(result.content)).toBe('out\n\nerr\n')
    expect(result.isError).toBe(true)
    expect(updates[0]?.message).toBe('[stdout] out\n')
    expect(updates.at(-1)?.message).toBe('[stderr] err\n')
    expect(updates.map((update) => update.progress)).toEqual([1, 2])
  })
})

describe('McpRelay cancel', () => {
  it("passes a client's cancel on, so the session's next line runs at once", async () => {
    const { client } = await relayed()
    const stop = new AbortController()
    const running = client.callTool(
      { name: 'shell', arguments: { command: 'sleep 20' } },
      { signal: stop.signal },
    )
    setTimeout(() => {
      stop.abort()
    }, 300)
    await expect(running).rejects.toThrow()
    const started = Date.now()
    const after = await client.callTool({ name: 'shell', arguments: { command: 'echo after' } })
    expect(firstText(after.content)).toBe('after\n')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('relayStdio', () => {
  it('asks for the token on every request', async () => {
    const app = buildApp({
      allowedHosts: ['*'],
      pidFile: join(mkdtempSync(join(tmpdir(), 'mirage-mcp-relay-')), 'daemon.pid'),
      authConfig: { mode: AuthMode.Token, bearerToken: 'secret' },
    })
    closers.push(() => app.close())
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${String(address.port)}`
    const created = await fetch(`${base}/v1/workspaces`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }),
    })
    const { id } = (await created.json()) as { id: string }
    const stdin = new PassThrough()
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
    const answers = new Map<number, { result: { tools: { name: string }[] } }>()
    let pending = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      pending += String(chunk)
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const answer = JSON.parse(line) as { id?: number; result: { tools: { name: string }[] } }
        if (answer.id !== undefined) answers.set(answer.id, answer)
      }
      if (answers.has(3)) stdin.end()
      return true
    })
    for (const message of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ]) {
      stdin.write(JSON.stringify(message) + '\n')
    }
    let asked = 0
    await relayStdio(`${base}/v1/workspaces/${id}/mcp`, () => {
      asked += 1
      return Promise.resolve('secret')
    })
    for (const n of [2, 3]) {
      expect(answers.get(n)?.result.tools.map((tool) => tool.name)).toContain('shell')
    }
    expect(asked).toBeGreaterThanOrEqual(3)
  })
})

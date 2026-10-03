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
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import type { AuthConfig } from '../auth/index.ts'

const CONFIG = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
const apps: ReturnType<typeof buildApp>[] = []
const clients: Client[] = []

async function daemon(
  authConfig?: AuthConfig,
): Promise<{ base: string; app: ReturnType<typeof buildApp> }> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-mcp-http-'))
  const app = buildApp({
    allowedHosts: ['*'],
    pidFile: join(dir, 'daemon.pid'),
    ...(authConfig === undefined ? {} : { authConfig }),
  })
  apps.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { base: `http://127.0.0.1:${String(address.port)}`, app }
}

async function createWorkspace(
  base: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const created = await fetch(`${base}/v1/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(CONFIG),
  })
  expect(created.status).toBe(201)
  return ((await created.json()) as { id: string }).id
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'mirage-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  )
  return client
}

async function call(url: string, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await (await connect(url)).callTool({ name, arguments: args })
  const first = (result.content as { text?: string }[])[0]
  return first?.text ?? ''
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const app of apps.splice(0)) await app.close()
})

describe('the MCP door over HTTP', () => {
  it('serves the tools', async () => {
    const { base } = await daemon()
    const client = await connect(`${base}/v1/workspaces/${await createWorkspace(base)}/mcp`)
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    const written = await client.callTool({
      name: 'write',
      arguments: { path: '/a.txt', content: 'hi\n' },
    })
    const read = await client.callTool({ name: 'read', arguments: { path: '/a.txt' } })
    expect(tools).toEqual(['edit', 'glob', 'grep', 'ls', 'read', 'session', 'shell', 'write'])
    expect(written.isError).not.toBe(true)
    expect((read.content as { text: string }[])[0]?.text).toBe('     1\thi\n')
  })

  it('keeps the session between requests', async () => {
    const { base } = await daemon()
    const url = `${base}/v1/workspaces/${await createWorkspace(base)}/mcp`
    await call(url, 'shell', { command: 'mkdir /d && cd /d' })
    expect(await call(url, 'shell', { command: 'pwd' })).toBe('/d\n')
  })

  it('runs in the session sessionId names', async () => {
    const { base } = await daemon()
    const id = await createWorkspace(base)
    await fetch(`${base}/v1/workspaces/${id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent' }),
    })
    const url = `${base}/v1/workspaces/${id}/mcp`
    await call(`${url}?sessionId=agent`, 'shell', { command: 'mkdir /d && cd /d' })
    expect(await call(`${url}?sessionId=agent`, 'shell', { command: 'pwd' })).toBe('/d\n')
    expect(await call(url, 'shell', { command: 'pwd' })).toBe('/\n')
  })

  it("guards the next request's edit with this request's read", async () => {
    const { base, app } = await daemon()
    const id = await createWorkspace(base)
    const url = `${base}/v1/workspaces/${id}/mcp`
    await call(url, 'write', { path: '/a.txt', content: 'first' })
    await call(url, 'read', { path: '/a.txt' })
    await app.registry.get(id).runner.ws.vfs.write('/a.txt', 'external')
    const stale = await call(url, 'edit', {
      path: '/a.txt',
      old_string: 'external',
      new_string: 'x',
    })
    expect(stale).toContain('changed since it was last read')
  })

  it('answers an unknown workspace or session with 404', async () => {
    const { base } = await daemon()
    const id = await createWorkspace(base)
    const post = (path: string): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    const workspace = await post('/v1/workspaces/nope/mcp')
    const session = await post(`/v1/workspaces/${id}/mcp?sessionId=nope`)
    expect(workspace.status).toBe(404)
    expect(await workspace.json()).toEqual({ detail: 'workspace not found' })
    expect(session.status).toBe(404)
    expect(await session.json()).toEqual({ detail: 'session not found' })
  })

  it('rejects an unknown tool as a protocol error', async () => {
    const { base } = await daemon()
    const client = await connect(`${base}/v1/workspaces/${await createWorkspace(base)}/mcp`)
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: 'Tool nope not found',
    })
  })

  it('sits behind auth', async () => {
    const { base } = await daemon({ mode: 'local', localToken: 'secret' })
    const auth = { authorization: 'Bearer secret' }
    const url = `${base}/v1/workspaces/${await createWorkspace(base, auth)}/mcp`
    const refused = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const client = await connect(url, auth)
    expect(refused.status).toBe(401)
    expect((await client.listTools()).tools).toHaveLength(8)
  })

  it('starts a fresh tool table for a recreated session', async () => {
    const { base, app } = await daemon()
    const id = await createWorkspace(base)
    const sessions = `${base}/v1/workspaces/${id}/sessions`
    const json = { 'content-type': 'application/json' }
    const url = `${base}/v1/workspaces/${id}/mcp?sessionId=agent`
    await fetch(sessions, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ sessionId: 'agent' }),
    })
    await call(url, 'write', { path: '/a.txt', content: 'first' })
    await call(url, 'read', { path: '/a.txt' })
    await app.registry.get(id).runner.ws.vfs.write('/a.txt', 'external')
    await fetch(`${sessions}/agent`, { method: 'DELETE' })
    await fetch(sessions, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ sessionId: 'agent' }),
    })
    const edited = await call(url, 'edit', {
      path: '/a.txt',
      old_string: 'external',
      new_string: 'x',
    })
    expect(edited).toBe('Edited: /a.txt (1 occurrence(s))')
  })

  it('takes a write larger than a mebibyte', async () => {
    const { base, app } = await daemon()
    const id = await createWorkspace(base)
    const content = 'x'.repeat(2 * 1024 * 1024)
    const written = await call(`${base}/v1/workspaces/${id}/mcp`, 'write', {
      path: '/big.txt',
      content,
    })
    expect(written).toBe('Written: /big.txt')
    expect((await app.registry.get(id).runner.ws.vfs.cat('/big.txt')).length).toBe(content.length)
  })

  it('runs shell as a daemon job', async () => {
    const { base } = await daemon()
    const id = await createWorkspace(base)
    await call(`${base}/v1/workspaces/${id}/mcp`, 'shell', { command: 'echo from-mcp' })
    const jobs = (await (await fetch(`${base}/v1/jobs?workspaceId=${id}`)).json()) as {
      command: string
    }[]
    expect(jobs.map((job) => job.command)).toContain('echo from-mcp')
  })
})

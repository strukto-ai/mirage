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
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

const CONFIG = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
const apps: ReturnType<typeof buildApp>[] = []

async function daemon(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-rpc-http-'))
  const app = buildApp({ allowedHosts: ['*'], pidFile: join(dir, 'daemon.pid') })
  apps.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

async function post(url: string, body: unknown, query = ''): Promise<Response> {
  return fetch(url + query, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function workspace(base: string): Promise<string> {
  const created = await post(`${base}/v1/workspaces`, CONFIG)
  expect(created.status).toBe(201)
  return ((await created.json()) as { id: string }).id
}

const request = (id: number, method: string, params: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

describe('the RPC endpoint', () => {
  it('answers a request and a batch', async () => {
    const base = await daemon()
    const id = await workspace(base)
    const one = await post(
      `${base}/v1/workspaces/${id}/rpc`,
      request(1, 'shell', { command: 'echo hi' }),
    )
    expect(((await one.json()) as { result: { stdout: string } }).result.stdout).toBe('hi\n')
    const batch = await post(`${base}/v1/workspaces/${id}/rpc`, [
      request(1, 'vfs/exists', { path: '/' }),
      { jsonrpc: '2.0', method: 'shell', params: {} },
      request(2, 'nope', {}),
    ])
    const answers = (await batch.json()) as { result?: unknown; error?: { code: number } }[]
    expect(answers[0]?.result).toEqual({ exists: true })
    expect(answers[1]?.error?.code).toBe(-32601)
    expect(answers).toHaveLength(2)
    const parse = await fetch(`${base}/v1/workspaces/${id}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700)
  })

  it('runs shell as a daemon job in the named session', async () => {
    const base = await daemon()
    const id = await workspace(base)
    await post(`${base}/v1/workspaces/${id}/sessions`, { session_id: 'agent' })
    const url = `${base}/v1/workspaces/${id}/rpc`
    await post(url, request(1, 'shell', { command: 'mkdir /d && cd /d' }), '?session_id=agent')
    const pwd = await post(url, request(2, 'shell', { command: 'pwd' }), '?session_id=agent')
    expect(((await pwd.json()) as { result: { stdout: string } }).result.stdout).toBe('/d\n')
    const jobs = (await (await fetch(`${base}/v1/jobs?workspace_id=${id}`)).json()) as {
      session_id: string
    }[]
    expect(new Set(jobs.map((job) => job.session_id))).toEqual(new Set(['agent']))
  })

  it('lets $/cancelRequest reach a running shell', async () => {
    const base = await daemon()
    const id = await workspace(base)
    const url = `${base}/v1/workspaces/${id}/rpc`
    const running = post(url, request(7, 'shell', { command: 'sleep 20' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const cancelled = await post(url, {
      jsonrpc: '2.0',
      method: '$/cancelRequest',
      params: { id: 7 },
    })
    expect(cancelled.status).toBe(204)
    const answer = (await (await running).json()) as { error: { code: number } }
    expect(answer.error.code).toBe(-32800)
    let status = ''
    for (let i = 0; i < 100; i++) {
      const jobs = (await (await fetch(`${base}/v1/jobs?workspace_id=${id}`)).json()) as {
        status: string
      }[]
      status = jobs[0]?.status ?? ''
      if (status === 'canceled') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(status).toBe('canceled')
  })

  it('shares the session tool table with the tool routes', async () => {
    const base = await daemon()
    const id = await workspace(base)
    await post(`${base}/v1/workspaces/${id}/write`, { path: '/f.txt', content: 'a\n' })
    await post(`${base}/v1/workspaces/${id}/read`, { path: '/f.txt' })
    const written = await post(
      `${base}/v1/workspaces/${id}/rpc`,
      request(1, 'tools/call', { name: 'write', arguments: { path: '/f.txt', content: 'b\n' } }),
    )
    expect(((await written.json()) as { result: unknown }).result).toEqual({
      text: 'Written: /f.txt',
      is_error: false,
    })
  })

  it('answers an unknown workspace or session with 404', async () => {
    const base = await daemon()
    const id = await workspace(base)
    expect(
      (await post(`${base}/v1/workspaces/nope/rpc`, request(1, 'initialize', {}))).status,
    ).toBe(404)
    const session = await post(
      `${base}/v1/workspaces/${id}/rpc`,
      request(1, 'initialize', {}),
      '?session_id=nope',
    )
    expect(session.status).toBe(404)
  })
})

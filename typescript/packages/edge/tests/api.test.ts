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

import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const TOKEN = 'edge-test-token'
let worker: Unstable_DevWorker

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: unknown; text: string; type: string | null }> {
  const response = await worker.fetch(`http://edge.test${path}`, {
    method,
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text, type: response.headers.get('content-type') }
}

async function shell(id: string, command: string): Promise<{ stdout: string; exit_code: number }> {
  const answer = await call('POST', `/v1/workspaces/${id}/shell`, { command })
  expect(answer.status).toBe(200)
  return answer.json as { stdout: string; exit_code: number }
}

beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('./worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
    experimental: { disableExperimentalWarning: true },
    logLevel: 'error',
  })
}, 120_000)

afterAll(async () => {
  await worker.stop()
})

describe('the server API in workerd', () => {
  it('answers health without a token and refuses the rest without one', async () => {
    expect((await call('GET', '/v1/health', undefined, null)).status).toBe(200)
    expect((await call('GET', '/v1/workspaces', undefined, null)).status).toBe(401)
    expect((await call('GET', '/v1/workspaces', undefined, 'wrong')).status).toBe(401)
    expect((await call('GET', '/v1/nope')).status).toBe(404)
  })

  it('creates a workspace, runs lines and reads its files', async () => {
    const created = await call('POST', '/v1/workspaces', {
      id: 'api',
      config: { mounts: { '/data': { vfs: 'ram' }, '/tmp': { vfs: 'ram' } }, mode: 'exec' },
    })
    expect(created.status).toBe(201)
    expect((created.json as { id: string }).id).toBe('api')
    const written = await shell('api', "printf 'a\\nb\\nc\\n' > /data/x.txt && wc -l < /data/x.txt")
    expect([written.exit_code, written.stdout.trim()]).toEqual([0, '3'])
    const listed = await call('GET', '/v1/workspaces')
    expect(JSON.stringify(listed.json)).toContain('"api"')
    const read = await call('POST', '/v1/workspaces/api/tools/read', { path: '/data/x.txt' })
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.json)).toContain('b')
    const stat = await call('POST', '/v1/workspaces/api/vfs/stat', { path: '/data/x.txt' })
    expect(stat.status).toBe(200)
  })

  it('streams a line as ndjson', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'stream',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    const streamed = await call('POST', '/v1/workspaces/stream/shell?stream=true', {
      command: 'seq 1 3',
    })
    expect(streamed.status).toBe(200)
    expect(streamed.type).toBe('application/x-ndjson')
    expect(streamed.text.trim().split('\n').length).toBeGreaterThan(1)
  })

  it("keeps a session's cwd and env across lines", async () => {
    await call('POST', '/v1/workspaces', {
      id: 'sess',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    expect(
      (await call('POST', '/v1/workspaces/sess/sessions', { session_id: 'agent' })).status,
    ).toBe(201)
    const first = await call('POST', '/v1/workspaces/sess/shell?session_id=agent', {
      command: 'mkdir -p /w && cd /w && export N=7',
    })
    expect(first.status).toBe(200)
    const second = await call('POST', '/v1/workspaces/sess/shell?session_id=agent', {
      command: 'pwd; echo $N',
    })
    expect((second.json as { stdout: string }).stdout).toBe('/w\n7\n')
  })

  it('refuses a body that fails its schema, and a store the host cannot keep', async () => {
    expect((await call('POST', '/v1/workspaces', { nope: 1 })).status).toBe(400)
    const disk = await call('POST', '/v1/workspaces', {
      config: { mounts: { '/': { vfs: 'ram' } }, store: { type: 'disk' } },
    })
    expect(disk.status).toBe(400)
    expect(disk.text).toContain('memory')
  })

  it('serves MCP and JSON-RPC over the same workspace', async () => {
    await call('POST', '/v1/workspaces', { id: 'mcp', config: { mounts: { '/': { vfs: 'ram' } } } })
    const response = await worker.fetch('http://edge.test/v1/workspaces/mcp/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"shell"')
    const rpc = await call('POST', '/v1/workspaces/mcp/rpc', {
      jsonrpc: '2.0',
      id: 1,
      method: 'shell',
      params: { command: 'echo rpc' },
    })
    expect(rpc.status).toBe(200)
    expect(rpc.text).toContain('rpc')
    const bad = await worker.fetch('http://edge.test/v1/workspaces/mcp/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700)
  })

  it('runs python3 on the monty runtime a config names', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'py',
      config: { mounts: { '/': { vfs: 'ram' } }, mode: 'exec', runtimes: ['workspace', 'monty'] },
    })
    const ran = await shell('py', 'echo 4 > /n && python3 -c \'print(int(open("/n").read()) * 2)\'')
    expect([ran.exit_code, ran.stdout]).toEqual([0, '8\n'])
  })

  it('closes a workspace', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'gone',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    expect((await call('DELETE', '/v1/workspaces/gone')).status).toBe(200)
    expect((await call('GET', '/v1/workspaces/gone')).status).toBe(404)
  })
})

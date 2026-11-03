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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

  it('reopens a closed workspace with its sessions', async () => {
    const config = { mounts: { '/': { vfs: 'ram' } } }
    expect((await call('POST', '/v1/workspaces', { id: 'keep', config })).status).toBe(201)
    await call('POST', '/v1/workspaces/keep/sessions', { session_id: 'agent' })
    await call('POST', '/v1/workspaces/keep/shell?session_id=agent', { command: 'export N=7' })
    expect((await call('POST', '/v1/workspaces/keep/close')).status).toBe(200)
    expect((await call('GET', '/v1/workspaces/keep')).status).toBe(404)
    expect((await call('POST', '/v1/workspaces', { id: 'keep', config })).status).toBe(201)
    const again = await call('POST', '/v1/workspaces/keep/shell?session_id=agent', {
      command: 'echo $N',
    })
    expect((again.json as { stdout: string }).stdout).toBe('7\n')
  })

  it('answers SSH and codex-exec with 501', async () => {
    const ssh = await call('GET', '/v1/workspaces/api/ssh')
    expect([ssh.status, ssh.json]).toEqual([501, { detail: 'ssh needs the Node server' }])
    expect((await call('GET', '/v1/workspaces/api/codex-exec')).status).toBe(501)
  })

  it('runs a Python policy program on monty', async () => {
    const guard = [
      'import json, os',
      'ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])',
      'if ctx["command"] == "cat":',
      '    print(json.dumps({"kind": "deny", "reason": "no cat here"}))',
    ].join('\n')
    const created = await call('POST', '/v1/workspaces', {
      id: 'guarded',
      config: {
        mounts: { '/': { vfs: 'ram' } },
        profiles: {
          guard: {
            policy: {
              pre_command: [{ script: { source: guard, language: 'python' }, runtime: 'monty' }],
            },
          },
        },
        profile: 'guard',
      },
    })
    expect(created.status).toBe(201)
    const denied = await shell('guarded', 'echo hi > /x && cat /x')
    expect(denied.exit_code).not.toBe(0)
    expect(JSON.stringify(denied)).toContain('no cat here')
    expect((await shell('guarded', 'echo ok')).stdout).toBe('ok\n')
  })

  it("holds a workspace's lines to its network rule", async () => {
    await call('POST', '/v1/workspaces', {
      id: 'offline',
      config: { mounts: { '/': { vfs: 'ram' } }, network: false },
    })
    const fetched = await shell('offline', 'curl -s -o /dev/null https://example.com')
    expect(fetched.exit_code).toBe(7)
  })

  it('refuses a rule that denies an address the isolate never sees', async () => {
    const created = await call('POST', '/v1/workspaces', {
      id: 'ranged',
      config: { mounts: { '/': { vfs: 'ram' } }, network: { denied_domains: ['10.0.0.0/8'] } },
    })
    expect(created.status).toBe(400)
    expect(created.text).toContain('cannot deny 10.0.0.0/8')
  })

  it('asks a Python pre_network program before a line connects', async () => {
    const guard = [
      'import json, os',
      'ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])',
      'if ctx["host"] == "example.com":',
      '    print(json.dumps({"kind": "deny", "reason": "not this host"}))',
    ].join('\n')
    await call('POST', '/v1/workspaces', {
      id: 'netguard',
      config: {
        mounts: { '/': { vfs: 'ram' } },
        profiles: {
          guard: {
            policy: {
              pre_network: [{ script: { source: guard, language: 'python' }, runtime: 'monty' }],
            },
          },
        },
        profile: 'guard',
      },
    })
    const fetched = await shell('netguard', 'curl -s -o /dev/null https://example.com')
    expect(fetched.exit_code).not.toBe(0)
  })

  it('mounts a backend that holds its own token, reaching its service with fetch', async () => {
    const seen: string[] = []
    const server: Server = createServer((req, res) => {
      seen.push(`${req.url ?? ''} ${req.headers.authorization ?? ''}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          channels: [{ id: 'C1', name: 'general', created: 1700000000 }],
          members: [],
          response_metadata: { next_cursor: '' },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const created = await call('POST', '/v1/workspaces', {
        id: 'slack',
        config: {
          mounts: {
            '/': { vfs: 'ram' },
            '/slack': { vfs: 'slack', config: { token: 'xoxb-edge', base_url: base } },
          },
        },
      })
      expect(created.status).toBe(201)
      const listed = await shell('slack', 'ls /slack/channels')
      expect(listed.stdout).toContain('general__C1')
      expect(
        seen.some((s) => s.startsWith('/conversations.list') && s.endsWith('Bearer xoxb-edge')),
      ).toBe(true)
    } finally {
      server.close()
    }
  })

  it('mounts an S3-compatible bucket, signing each request with its own keys', async () => {
    const seen: string[] = []
    const listing = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      '<Name>b</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys>',
      '<IsTruncated>false</IsTruncated>',
      '<Contents><Key>hello.txt</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>',
      '<ETag>&quot;abc&quot;</ETag><Size>5</Size><StorageClass>STANDARD</StorageClass></Contents>',
      '</ListBucketResult>',
    ].join('')
    const server: Server = createServer((req, res) => {
      seen.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers.authorization ?? ''}`)
      if (req.url?.startsWith('/b/hello.txt') === true) {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': '5',
          etag: '"abc"',
          'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        })
        res.end(req.method === 'HEAD' ? undefined : 'hello')
        return
      }
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(listing)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const created = await call('POST', '/v1/workspaces', {
        id: 'bucket',
        config: {
          mounts: {
            '/': { vfs: 'ram' },
            '/r2': {
              vfs: 'r2',
              config: {
                bucket: 'b',
                endpoint: base,
                force_path_style: true,
                access_key_id: 'AKEDGE',
                secret_access_key: 'edge-secret',
              },
            },
          },
        },
      })
      expect(created.status).toBe(201)
      const listed = await shell('bucket', 'ls /r2')
      expect(listed.stdout).toContain('hello.txt')
      expect((await shell('bucket', 'cat /r2/hello.txt')).stdout).toBe('hello')
      expect(
        seen.some(
          (s) => s.startsWith('GET /b/?') && s.includes('AWS4-HMAC-SHA256 Credential=AKEDGE/'),
        ),
      ).toBe(true)
      const proxied = await call('POST', '/v1/workspaces', {
        id: 'proxied',
        config: {
          mounts: {
            '/': { vfs: 'ram' },
            '/s3': {
              vfs: 's3',
              config: { bucket: 'b', endpoint: base, proxy: 'http://proxy.test' },
            },
          },
        },
      })
      expect(proxied.status).toBe(400)
    } finally {
      server.close()
    }
  })

  // A live Postgres the worker reaches over a TCP socket, as pg does in workerd.
  it.skipIf(process.env.MIRAGE_EDGE_POSTGRES_DSN === undefined)(
    'mounts Postgres through pg over a socket',
    async () => {
      const created = await call('POST', '/v1/workspaces', {
        id: 'pg',
        config: {
          mounts: {
            '/': { vfs: 'ram' },
            '/pg': { vfs: 'postgres', config: { dsn: process.env.MIRAGE_EDGE_POSTGRES_DSN } },
          },
        },
      })
      expect(created.status).toBe(201)
      expect((await shell('pg', 'ls /pg/public/tables')).stdout).toContain('notes')
      expect((await shell('pg', 'cat /pg/public/tables/notes/rows.jsonl')).stdout).toContain(
        'hi from pg',
      )
    },
  )

  it('closes a workspace', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'gone',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    expect((await call('DELETE', '/v1/workspaces/gone')).status).toBe(200)
    expect((await call('GET', '/v1/workspaces/gone')).status).toBe(404)
  })
})

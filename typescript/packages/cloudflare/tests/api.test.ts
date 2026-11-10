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

interface LineRecord {
  line_id?: string
  data?: string
  status?: string
}

async function openLine(
  id: string,
  command: string,
): Promise<{ route: string; next: () => Promise<LineRecord> }> {
  const response = await worker.fetch(`http://edge.test/v1/workspaces/${id}/shell?stream=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, open_stdin: true }),
  })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let held = ''
  const next = async (): Promise<LineRecord> => {
    for (;;) {
      const end = held.indexOf('\n')
      if (end >= 0) {
        const line = held.slice(0, end)
        held = held.slice(end + 1)
        return JSON.parse(line) as LineRecord
      }
      const read = await reader.read()
      if (read.done) throw new Error('the stream ended before its last record')
      held += decoder.decode(read.value, { stream: true })
    }
  }
  const first = await next()
  return { route: `/v1/workspaces/${id}/lines/${first.line_id ?? ''}/stdin`, next }
}

async function writeLine(route: string, body: string | Uint8Array): Promise<number> {
  const written = await worker.fetch(`http://edge.test${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
    body,
  })
  await written.text()
  return written.status
}

function decoded(record: LineRecord): string {
  return Buffer.from(record.data ?? '', 'base64').toString()
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

  it('exports logs as JSONL through the edge route adapter', async () => {
    const id = '日志'
    const base = `/v1/workspaces/${encodeURIComponent(id)}`
    expect(
      (await call('POST', '/v1/workspaces', { id, config: { mounts: { '/': { vfs: 'ram' } } } }))
        .status,
    ).toBe(201)
    const empty = await call('GET', `${base}/logs?format=jsonl`)
    expect(empty.status).toBe(200)
    expect(empty.text).toBe('')
    for (const session_id of ['user:42', 's'.repeat(65)]) {
      expect((await call('POST', `${base}/sessions`, { session_id })).status).toBe(201)
      expect(
        (
          await call('POST', `${base}/shell?session_id=${encodeURIComponent(session_id)}`, {
            command: 'echo hi',
          })
        ).status,
      ).toBe(200)
      const page = await call('GET', `${base}/logs?session=${encodeURIComponent(session_id)}`)
      expect(page.status).toBe(200)
      const items = (page.json as { items: { started_at: number }[] }).items
      expect(items).toHaveLength(1)
      expect(items[0]?.started_at).toBeGreaterThan(1_000_000_000_000)
      const response = await worker.fetch(
        `http://edge.test${base}/logs?format=jsonl&session=${encodeURIComponent(session_id)}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''%E6%97%A5%E5%BF%97-logs.jsonl",
      )
      expect(
        (await response.text())
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { type: string }).type),
      ).toEqual(['command', 'result'])
    }
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

  it('takes writes to a running line from other requests', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'live',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    const echoing = await openLine('live', 'cat')
    for (const word of ['one\n', 'two\n']) {
      expect(await writeLine(echoing.route, word)).toBe(204)
      expect(decoded(await echoing.next())).toBe(word)
    }
    expect((await call('DELETE', echoing.route)).status).toBe(204)
    expect((await echoing.next()).status).toBe('done')

    const counting = await openLine('live', 'wc -c')
    expect(await writeLine(counting.route, new Uint8Array(300_000))).toBe(204)
    expect((await call('DELETE', counting.route)).status).toBe(204)
    expect(decoded(await counting.next()).trim()).toBe('300000')
    expect((await counting.next()).status).toBe('done')
  })

  it('takes stdin/write to a running RPC line from other requests', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'live-rpc',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    const path = '/v1/workspaces/live-rpc/rpc'
    const request = (id: number, method: string, params: object): object => ({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })
    const running = call('POST', path, request(7, 'shell', { command: 'cat', open_stdin: true }))
    const data = Buffer.from('one\n').toString('base64')
    let written: { error?: { code: number }; result?: unknown } = {}
    for (let attempt = 0; attempt < 500; attempt++) {
      written = (await call('POST', path, request(8, 'stdin/write', { id: 7, data })))
        .json as typeof written
      if (written.error?.code !== -32004) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(written.result).toBeNull()
    expect(
      ((await call('POST', path, request(9, 'stdin/close', { id: 7 }))).json as { result: unknown })
        .result,
    ).toBeNull()
    expect(((await running).json as { result: { stdout: string } }).result.stdout).toBe('one\n')
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

  it("names the edge's own backends when a mount names none of them", async () => {
    const unknown = await call('POST', '/v1/workspaces', {
      config: { mounts: { '/': { vfs: 'disk' } } },
    })
    expect(unknown.text).toContain('unknown VFS \\"disk\\"')
    expect(unknown.text).toContain('slack')
    expect(unknown.text).toContain('s3')
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

  it('runs no QuickJS, and refuses a config that names it', async () => {
    const config = { mounts: { '/': { vfs: 'ram' } }, mode: 'exec' }
    await call('POST', '/v1/workspaces', { id: 'nojs', config })
    const plain = await shell('nojs', 'node -e "console.log(1)"; python3 -c "print(2)"')
    expect([plain.exit_code, plain.stdout]).toEqual([0, '2\n'])
    const named = await call('POST', '/v1/workspaces', {
      id: 'js',
      config: { ...config, runtimes: ['workspace', 'quickjs'] },
    })
    expect(named.status).toBe(400)
    expect(JSON.stringify(named.json)).toContain("runtime 'quickjs' does not run on Cloudflare")
  })

  it('starts a stopped workspace with its sessions', async () => {
    const config = { mounts: { '/': { vfs: 'ram' } } }
    expect((await call('POST', '/v1/workspaces', { id: 'keep', config })).status).toBe(201)
    await call('POST', '/v1/workspaces/keep/sessions', { session_id: 'agent' })
    await call('POST', '/v1/workspaces/keep/shell?session_id=agent', { command: 'export N=7' })
    expect((await call('POST', '/v1/workspaces/keep/stop')).status).toBe(200)
    const kept = await call('GET', '/v1/workspaces/keep')
    expect([kept.status, (kept.json as { status: string }).status]).toEqual([200, 'stopped'])
    expect((await call('POST', '/v1/workspaces/keep/start')).status).toBe(200)
    const again = await call('POST', '/v1/workspaces/keep/shell?session_id=agent', {
      command: 'echo $N',
    })
    expect((again.json as { stdout: string }).stdout).toBe('7\n')
  })

  it('answers SSH with 501, and codex-exec without an upgrade with 400', async () => {
    const ssh = await call('GET', '/v1/workspaces/api/ssh')
    expect([ssh.status, ssh.json]).toEqual([
      501,
      { error: { code: 'not_supported', message: 'ssh needs the Node server' } },
    ])
    const codex = await call('GET', '/v1/workspaces/api/codex-exec')
    expect([codex.status, codex.json]).toEqual([
      400,
      { error: { code: 'invalid_request', message: 'codex-exec needs a WebSocket upgrade' } },
    ])
  })

  it("serves Codex's exec-server over a WebSocket, running in the workspace", async () => {
    await call('POST', '/v1/workspaces', {
      id: 'codex',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    const socket = new WebSocket(
      `ws://${worker.address}:${String(worker.port)}/v1/workspaces/codex/codex-exec`,
      { headers: { authorization: `Bearer ${TOKEN}` } } as unknown as string[],
    )
    const inbox: Record<string, unknown>[] = []
    let wake: (() => void) | null = null
    socket.addEventListener('message', (event) => {
      inbox.push(JSON.parse(String(event.data)) as Record<string, unknown>)
      wake?.()
    })
    const next = async (
      pick: (m: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> => {
      for (;;) {
        const at = inbox.findIndex(pick)
        if (at >= 0) return inbox.splice(at, 1)[0] ?? {}
        await new Promise<void>((resolve) => (wake = resolve))
      }
    }
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve)
      socket.addEventListener('error', reject)
    })
    try {
      socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientName: 'test' } }))
      expect(await next((m) => m.id === 1)).toHaveProperty('result')
      socket.send(JSON.stringify({ method: 'initialized' }))
      socket.send(
        JSON.stringify({
          id: 2,
          method: 'process/start',
          params: {
            processId: 'p',
            argv: ['/bin/bash', '-lc', 'mkdir -p /w && echo hi > /w/f && cat /w/f; exit 3'],
            cwd: 'file:///',
            env: {},
          },
        }),
      )
      expect(await next((m) => m.id === 2)).toHaveProperty('result')
      const output = await next((m) => m.method === 'process/output')
      const chunk = (output.params as { chunk: string }).chunk
      expect(new TextDecoder().decode(Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)))).toBe(
        'hi\n',
      )
      const exited = await next((m) => m.method === 'process/exited')
      expect((exited.params as { exitCode: number }).exitCode).toBe(3)
      socket.send(JSON.stringify({ id: 3, method: 'fs/readFile', params: { path: 'file:///w/f' } }))
      const read = await next((m) => m.id === 3)
      expect(atob((read.result as { dataBase64: string }).dataBase64)).toBe('hi\n')
    } finally {
      socket.close()
    }
  })

  it('runs a Python policy program on monty', async () => {
    const guard = [
      'def pre_command(ctx):',
      '    if ctx["command"] == "cat":',
      '        return {"kind": "deny", "reason": "no cat here"}',
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
      'def pre_network(ctx):',
      '    if ctx["host"] == "example.com":',
      '        return {"kind": "deny", "reason": "not this host"}',
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

  it("holds a database's and a mail server's sockets to the network rule", async () => {
    const account = {
      imap_host: 'mail.test',
      smtp_host: 'mail.test',
      username: 'u',
      password: 'p',
    }
    const created = await call('POST', '/v1/workspaces', {
      id: 'sockets',
      config: {
        mounts: {
          '/': { vfs: 'ram' },
          '/pg': { vfs: 'postgres', config: { dsn: 'postgres://u:p@db.test:5432/x' } },
          '/mail': { vfs: 'email', config: account },
        },
        clis: { himalaya: { cli: 'himalaya', config: account } },
        network: { denied_domains: ['db.test', 'mail.test'] },
      },
    })
    expect(created.status).toBe(201)
    const refused = async (command: string): Promise<string> => {
      const answer = await call('POST', '/v1/workspaces/sockets/shell', { command })
      const { exit_code, stdout, stderr } = answer.json as {
        exit_code: number
        stdout: string
        stderr: string
      }
      expect(exit_code).not.toBe(0)
      return `${stdout}${stderr}`
    }
    expect(await refused('ls /pg/public/tables')).toContain('Permission denied')
    expect(await refused('ls /mail')).toContain('Permission denied')
    expect(
      await refused("printf 'To: a@b.test\\nSubject: s\\n\\nhi\\n' | himalaya message send"),
    ).toContain('EACCES mail.test:587')
  })

  it('runs an MCP server as a CLI, its client kept across requests', async () => {
    const seen: string[] = []
    const server: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
      req.on('end', () => {
        seen.push(`${req.method ?? ''} ${req.headers.authorization ?? ''}`)
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const msg = JSON.parse(raw) as {
          id?: number
          method: string
          params?: { arguments?: { text?: string } }
        }
        if (msg.id === undefined) {
          res.writeHead(202).end()
          return
        }
        const result =
          msg.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'echo', version: '1.0.0' },
              }
            : msg.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'echo_text',
                      description: 'Echo the text back.',
                      inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string' } },
                        required: ['text'],
                      },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] }
        const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
        if (msg.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' })
          res.end(`event: message\ndata: ${reply}\n\n`)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        res.end(reply)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
    try {
      const created = await call('POST', '/v1/workspaces', {
        id: 'mcp-cli',
        config: {
          mounts: { '/': { vfs: 'ram' } },
          clis: {
            wiki: {
              cli: 'mcp',
              config: { url: base, auth: { type: 'bearer', token: 'mcp-edge' } },
            },
          },
        },
      })
      expect(created.status).toBe(201)
      const first = await shell('mcp-cli', `wiki echo-text '{"text": "one"}'`)
      expect(first.stdout).toContain('echo: one')
      const second = await shell('mcp-cli', `wiki echo-text '{"text": "two"}'`)
      expect(second.stdout).toContain('echo: two')
      expect(seen.every((s) => s.endsWith('Bearer mcp-edge'))).toBe(true)
    } finally {
      server.close()
    }
  }, 60_000)

  it('closes a workspace', async () => {
    await call('POST', '/v1/workspaces', {
      id: 'gone',
      config: { mounts: { '/': { vfs: 'ram' } } },
    })
    expect((await call('DELETE', '/v1/workspaces/gone')).status).toBe(200)
    expect((await call('GET', '/v1/workspaces/gone')).status).toBe(404)
  })
})

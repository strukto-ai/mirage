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

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Line } from '@struktoai/mirage-core/execution/line/types'
import type { LineId } from '@struktoai/mirage-core/execution/types'
import { buildApp } from '../app.ts'

function lines(app: ReturnType<typeof buildApp>, id: string): Line[] {
  return app.registry.get(id).runner.ws.lineTable.lines()
}

async function ended(app: ReturnType<typeof buildApp>, id: string, lineId: LineId): Promise<Line> {
  const table = app.registry.get(id).runner.ws.lineTable
  return vi.waitFor(
    () => {
      const line = table.get(lineId)
      if (line?.endedAt == null) throw new Error(`line ${lineId.value} never ended`)
      return line
    },
    { timeout: 5000, interval: 50 },
  )
}

async function createWs(app: ReturnType<typeof buildApp>, id: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { id, config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
  })
}

describe('execute router', () => {
  it.each(['ram', 'disk'] as const)(
    'preserves large multipart stdin on %s',
    async (vfs) => {
      const root = await mkdtemp(join(tmpdir(), 'execute-stdin-'))
      const app = buildApp()
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          payload: {
            id: 'large-stdin',
            config: {
              mounts: {
                '/work': {
                  vfs,
                  mode: 'write',
                  ...(vfs === 'disk' ? { config: { root } } : {}),
                },
              },
            },
          },
        })
        expect(created.statusCode).toBe(201)
        const stdin = Buffer.from('α\0\r\n'.repeat(240_000))
        expect(stdin.length).toBeGreaterThan(1024 * 1024)
        const form = new FormData()
        const request = JSON.stringify({ command: 'cat > input.bin', cwd: '/work', record: false })
        form.set('request', request)
        form.set('stdin', new Blob([stdin]), 'stdin.bin')
        const upload = new Request('http://localhost', { method: 'POST', body: form })
        const result = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/large-stdin/shell',
          headers: { 'content-type': upload.headers.get('content-type') ?? '' },
          payload: Buffer.from(await upload.arrayBuffer()),
        })
        expect(result.statusCode).toBe(200)
        expect(result.json<{ exit_code: number }>().exit_code).toBe(0)
        const read = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/large-stdin/shell',
          payload: { command: 'base64 /work/input.bin' },
        })
        expect(read.json<{ exit_code: number }>().exit_code).toBe(0)
        expect(Buffer.from(read.json<{ stdout: string }>().stdout, 'base64')).toEqual(stdin)
      } finally {
        await app.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    // Includes real filesystem IO and multi-megabyte command output on CI.
    30_000,
  )

  it('preserves empty multipart stdin and rejects missing request metadata', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'multipart-empty')
      for (const request of [undefined, '{broken', JSON.stringify({ command: 'wc -c' })]) {
        const form = new FormData()
        if (request !== undefined) form.set('request', request)
        form.set('stdin', new Blob([]), 'stdin.bin')
        const upload = new Request('http://localhost', { method: 'POST', body: form })
        const result = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/multipart-empty/shell',
          headers: { 'content-type': upload.headers.get('content-type') ?? '' },
          payload: Buffer.from(await upload.arrayBuffer()),
        })
        expect(result.statusCode).toBe(request?.startsWith('{"command"') === true ? 200 : 400)
        if (result.statusCode === 200) {
          expect(result.json<{ stdout: string }>().stdout.trim()).toBe('0')
        }
      }
      expect(lines(app, 'multipart-empty')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('synchronously runs a command and returns IO result', async () => {
    const app = buildApp()
    await createWs(app, 'ew')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew/shell',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ stdout: string; exit_code: number }>()
    expect(body.stdout.trim()).toBe('hi')
    expect(body.exit_code).toBe(0)
    await app.close()
  })

  it.each(['false', 'true'])('answers 404 for an unknown session (stream=%s)', async (stream) => {
    const app = buildApp()
    await createWs(app, 'ew')
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/ew/shell?session_id=nope&stream=${stream}`,
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ detail: 'session not found' })
    await app.close()
  })

  it.each(['1', 'yes', 'on', 't', 'y', 'TRUE', 'Yes'])(
    'reads %s as a set stream flag',
    async (flag) => {
      const app = buildApp()
      await createWs(app, 'flag')
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/flag/shell?stream=${flag}&explain=${flag}`,
        payload: { command: 'echo hi' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ detail: 'stream cannot be combined with explain' })
      await app.close()
    },
  )

  it.each(['0', 'no', 'off', 'f', 'n', 'FALSE', 'No'])(
    'reads %s as an unset stream and explain flag',
    async (flag) => {
      const app = buildApp()
      await createWs(app, 'unflag')
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/unflag/shell?stream=${flag}&explain=${flag}`,
        payload: { command: 'echo hi' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ stdout: string }>().stdout.trim()).toBe('hi')
      await app.close()
    },
  )

  it.each(['abc', '', '2', 'tru'])('answers 422 for the flag value %j', async (flag) => {
    const app = buildApp()
    await createWs(app, 'badflag')
    for (const name of ['explain', 'stream']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/badflag/shell?${name}=${flag}`,
        payload: { command: 'echo hi' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({
        detail: [
          {
            type: 'bool_parsing',
            loc: ['query', name],
            msg: 'Input should be a valid boolean, unable to interpret input',
            input: flag,
          },
        ],
      })
    }
    await app.close()
  })

  it('runs in the default session when session_id is empty', async () => {
    const app = buildApp()
    await createWs(app, 'emptysid')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/emptysid/shell?session_id=',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(200)
    const ws = app.registry.get('emptysid').runner.ws
    const [line] = lines(app, 'emptysid')
    expect(line?.sessionId).toBe(ws.defaultSessionId)
    await app.close()
  })

  // A line on a workspace another daemon holds is refused, naming that
  // daemon; once it gives the lease up, the line runs here.
  it('refuses a workspace another daemon holds', async () => {
    const app = buildApp()
    await createWs(app, 'held')
    const store = app.registry.get('held').runner.ws.jobTable.store
    expect(await store.lease('elsewhere')).toBeNull()
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/held/shell',
      payload: { command: 'echo hi' },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json<{ detail: string }>().detail).toContain("'elsewhere'")
    await store.release('elsewhere')
    const ran = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/held/shell',
      payload: { command: 'echo hi' },
    })
    expect(ran.statusCode).toBe(200)
    await app.close()
  })

  // A body that reads but fails the schema is a 422 in FastAPI's shape,
  // located under "body"; a body that does not read is a 400.
  it.each([
    [
      { command: 'echo hello', provision: true },
      [['extra_forbidden', ['body', 'provision'], true]],
    ],
    [{}, [['missing', ['body', 'command'], {}]]],
    [{ command: 5 }, [['string_type', ['body', 'command'], 5]]],
    [{ command: 'echo hi', record: 1 }, [['bool_type', ['body', 'record'], 1]]],
    [[1], [['model_attributes_type', ['body'], [1]]]],
  ])('answers 422 for the body %j', async (payload, issues) => {
    const app = buildApp()
    await createWs(app, 'ew-strict')
    for (const explain of ['false', 'true']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ew-strict/shell?explain=${explain}`,
        payload,
      })
      expect(res.statusCode).toBe(422)
      const { detail } = res.json<{ detail: { type: string; loc: unknown[]; input: unknown }[] }>()
      expect(detail.map((issue) => [issue.type, issue.loc, issue.input])).toEqual(issues)
    }
    await app.close()
  })

  it('answers 400 for a body that is not JSON', async () => {
    const app = buildApp()
    await createWs(app, 'ew-unread')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew-unread/shell',
      headers: { 'content-type': 'application/json' },
      payload: '{"command":',
    })
    expect(res.statusCode).toBe(400)
    for (const explain of ['false', 'true']) {
      const empty = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ew-unread/shell?explain=${explain}`,
      })
      expect(empty.statusCode).toBe(400)
      const text = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ew-unread/shell?explain=${explain}`,
        headers: { 'content-type': 'text/plain' },
        payload: 'echo hi',
      })
      expect(text.statusCode).toBe(400)
    }
    await app.close()
  })

  // A field's null is the field unset; an empty string is a value.
  it('reads null as unset', async () => {
    const app = buildApp()
    await createWs(app, 'ew-null')
    const unset = { cwd: null, runtime: null, machine: null, record: null, open_stdin: null }
    for (const explain of ['false', 'true']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/ew-null/shell?explain=${explain}`,
        payload: { command: 'echo hi', ...unset },
      })
      expect(res.statusCode, res.body).toBe(200)
    }
    await app.close()
  })

  it.each(['cwd', 'runtime', 'machine'])('explain refuses an empty %s as set', async (field) => {
    const app = buildApp()
    await createWs(app, 'ew-empty')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew-empty/shell?explain=true',
      payload: { command: 'echo hi', [field]: '' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // Query parameters are checked before the workspace, the body after the
  // workspace and the session, as FastAPI orders them.
  it('checks in the order the Python server does', async () => {
    const app = buildApp()
    await createWs(app, 'ew-order')
    const flags = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/nope/shell?stream=abc&explain=xyz',
      payload: { command: 'echo hi' },
    })
    expect(flags.statusCode).toBe(422)
    expect(flags.json<{ detail: { loc: string[] }[] }>().detail.map((issue) => issue.loc)).toEqual([
      ['query', 'explain'],
      ['query', 'stream'],
    ])
    for (const url of [
      '/v1/workspaces/nope/shell',
      '/v1/workspaces/nope/shell?stream=true&explain=true',
      '/v1/workspaces/ew-order/shell?session_id=nope',
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: { bogus: 1 } })
      expect(res.statusCode, url).toBe(404)
    }
    await app.close()
  })

  it('honors a cwd for the line', async () => {
    const app = buildApp()
    await createWs(app, 'ecwd')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ecwd/shell',
      payload: { command: 'mkdir -p /sub && echo -n nested > /sub/f.txt' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ecwd/shell',
      payload: { command: 'cat f.txt', cwd: '/sub' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ stdout: string; exit_code: number }>()
    expect(body.exit_code).toBe(0)
    expect(body.stdout).toBe('nested')
    await app.close()
  })

  it('passes the runtime argument through to execution', async () => {
    const app = buildApp()
    await createWs(app, 'ert')
    // An unknown entry name fails loud inside Workspace.shell,
    // proving the field reaches the runtime argument.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ert/shell',
      payload: { command: 'echo hi', runtime: 'no-such-runtime' },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json<{ detail: string }>().detail).toContain('unknown runtime')
    await app.close()
  })

  it('refuses a JSON stdin field; stdin travels as a multipart part', async () => {
    const app = buildApp()
    await createWs(app, 'estdin')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/estdin/shell',
      payload: { command: 'wc -l', stdinBase64: 'YQo=' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('honors record=false by leaving no history entry', async () => {
    const app = buildApp()
    await createWs(app, 'erec')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/shell',
      payload: { command: 'echo recorded' },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/shell',
      payload: { command: 'echo hidden', record: false },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/shell',
      payload: { command: 'history' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ stdout: string }>()
    expect(body.stdout).toContain('echo recorded')
    expect(body.stdout).not.toContain('echo hidden')
    await app.close()
  })

  it('answers 499 when a synchronous execute job is canceled', async () => {
    const app = buildApp()
    await createWs(app, 'ecancel')
    const pending = app
      .inject({
        method: 'POST',
        url: '/v1/workspaces/ecancel/shell',
        payload: { command: 'sleep 60' },
      })
      .then((reply) => reply)
    const job = await vi.waitFor(() => {
      const entry = app.jobs.requests().find((request) => request.workspaceId === 'ecancel')
      if (entry === undefined) throw new Error('execute did not register a job')
      return entry
    })
    app.jobs.cancel(job.id)
    const res = await pending
    expect(res.statusCode).toBe(499)
    expect(res.json()).toEqual({ detail: 'job canceled' })
    await app.close()
  })
})

describe('a foreground shell request', () => {
  it('cancels its job when the caller drops it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-shell-drop-'))
    const app = buildApp({ allowedHosts: ['*'], pidFile: join(dir, 'daemon.pid') })
    try {
      await createWs(app, 'drop')
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      const base = `http://127.0.0.1:${String(address.port)}`
      const stop = new AbortController()
      const running = fetch(`${base}/v1/workspaces/drop/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'sleep 20' }),
        signal: stop.signal,
      })
      setTimeout(() => {
        stop.abort()
      }, 500)
      await expect(running).rejects.toThrow()
      const [line] = lines(app, 'drop')
      if (line === undefined) throw new Error('the line was not recorded')
      expect((await ended(app, 'drop', line.id)).signal).toBe(2)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  const BOUNDARY = 'mirage-test-boundary'
  const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }
  const END = `\r\n--${BOUNDARY}--\r\n`

  function part(name: string, filename?: string): string {
    const disposition =
      filename === undefined
        ? `form-data; name="${name}"`
        : `form-data; name="${name}"; filename="${filename}"`
    return `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n\r\n`
  }

  function requestPart(command: string): string {
    return `${part('request')}${JSON.stringify({ command })}\r\n`
  }

  async function served(app: ReturnType<typeof buildApp>, id: string): Promise<string> {
    await createWs(app, id)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${String(address.port)}`
  }

  it('streams stdin into a running line', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'streamed')
      const text = new TextEncoder()
      let running = false
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            text.encode(requestPart('cat > /out.txt') + part('stdin', 'stdin.bin')),
          )
          controller.enqueue(text.encode('first\n'))
          for (let i = 0; i < 250 && !running; i++) {
            running = lines(app, 'streamed').some((line) => line.state === 'running')
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          controller.enqueue(text.encode(`second\n${END}`))
          controller.close()
        },
      })
      const res = await fetch(`${base}/v1/workspaces/streamed/shell`, {
        method: 'POST',
        headers: MULTIPART,
        body,
        duplex: 'half',
      } as RequestInit)
      expect(res.status).toBe(200)
      expect(running).toBe(true)
      const read = await fetch(`${base}/v1/workspaces/streamed/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'cat /out.txt' }),
      })
      expect(((await read.json()) as { stdout: string }).stdout).toBe('first\nsecond\n')
    } finally {
      await app.close()
    }
  })

  it('takes writes to an open stdin while the line runs', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'open')
      const res = await openStdin(base, 'open', 'cat', new AbortController().signal)
      const records = ndjson(res.body as ReadableStream<Uint8Array>)
      const lineId = ((await records.next()).value as { line_id: string }).line_id
      const route = `${base}/v1/workspaces/open/lines/${lineId}/stdin`
      for (const word of ['one\n', 'two\n']) {
        expect((await writeStdin(route, word)).status).toBe(204)
        const echoed = (await records.next()).value as { data: string }
        expect(Buffer.from(echoed.data, 'base64').toString()).toBe(word)
      }
      expect((await fetch(route, { method: 'DELETE' })).status).toBe(204)
      const last = (await records.next()).value as {
        status: string
        result: { exit_code: number; line_id: string }
      }
      expect([last.status, last.result.exit_code, last.result.line_id]).toEqual(['done', 0, lineId])
      await records.next()
      expect((await writeStdin(route, 'x')).status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('refuses a write to a closed stdin', async () => {
    const app = buildApp()
    const abort = new AbortController()
    try {
      const base = await served(app, 'closed')
      const res = await openStdin(base, 'closed', 'cat; sleep 5', abort.signal)
      const records = ndjson(res.body as ReadableStream<Uint8Array>)
      const lineId = ((await records.next()).value as { line_id: string }).line_id
      const route = `${base}/v1/workspaces/closed/lines/${lineId}/stdin`
      expect((await fetch(route, { method: 'DELETE' })).status).toBe(204)
      expect((await fetch(route, { method: 'DELETE' })).status).toBe(204)
      const refused = await writeStdin(route, 'late')
      expect([refused.status, await refused.json()]).toEqual([
        409,
        { detail: "the line's stdin is not open" },
      ])
    } finally {
      abort.abort()
      await app.close()
    }
  })

  it('holds a write past the buffer until the line ends', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'held')
      const res = await openStdin(base, 'held', 'sleep 1', new AbortController().signal)
      const records = ndjson(res.body as ReadableStream<Uint8Array>)
      const lineId = ((await records.next()).value as { line_id: string }).line_id
      const written = await writeStdin(
        `${base}/v1/workspaces/held/lines/${lineId}/stdin`,
        'x'.repeat(1024 * 1024),
      )
      expect(written.status).toBe(409)
      expect(((await records.next()).value as { status: string }).status).toBe('done')
      await records.next()
    } finally {
      await app.close()
    }
  })

  it('drops a held write whose caller hung up', async () => {
    const app = buildApp()
    const statuses: number[] = []
    app.addHook('onSend', (req, reply, payload, done) => {
      if (req.url.endsWith('/stdin')) statuses.push(reply.statusCode)
      done(null, payload)
    })
    try {
      const base = await served(app, 'gone')
      const capacity = app.registry.get('gone').runner.ws.io.bufferBytes
      const res = await openStdin(base, 'gone', 'sleep 2; cat', new AbortController().signal)
      const records = ndjson(res.body as ReadableStream<Uint8Array>)
      const lineId = ((await records.next()).value as { line_id: string }).line_id
      const path = `/v1/workspaces/gone/lines/${lineId}/stdin`
      expect((await writeStdin(base + path, 'x'.repeat(capacity))).status).toBe(204)
      const socket = connect(Number(new URL(base).port), '127.0.0.1')
      await once(socket, 'connect')
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          'Content-Type: application/octet-stream\r\nContent-Length: 4\r\n\r\nlate',
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      socket.destroy()
      let seen = ''
      while (seen.length < capacity) {
        const record = (await records.next()).value as { data: string }
        seen += Buffer.from(record.data, 'base64').toString()
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((await fetch(base + path, { method: 'DELETE' })).status).toBe(204)
      for (;;) {
        const record = (await records.next()).value as { status?: string; data: string }
        if (record.status !== undefined) break
        seen += Buffer.from(record.data, 'base64').toString()
      }
      await records.next()
      expect(seen).toBe('x'.repeat(capacity))
      expect(statuses).toEqual([204, 499, 204])
    } finally {
      await app.close()
    }
  })

  it('answers 422 for a bad request part and 400 for one that is not JSON', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'parts')
      const route = `${base}/v1/workspaces/parts/shell`
      const form = (request: string): FormData => {
        const body = new FormData()
        body.append('request', new Blob([request], { type: 'application/json' }))
        return body
      }
      const bad = await fetch(route, {
        method: 'POST',
        body: form(JSON.stringify({ command: 'echo hi', provision: true })),
      })
      expect(bad.status).toBe(422)
      const { detail } = (await bad.json()) as { detail: { loc: string[] }[] }
      expect(detail.map((issue) => issue.loc)).toEqual([['body', 'request', 'provision']])
      const unread = await fetch(route, { method: 'POST', body: form('{"command":') })
      expect(unread.status).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('open_stdin needs a stream and no stdin part', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'needs')
      const route = `${base}/v1/workspaces/needs/shell`
      const body = JSON.stringify({ command: 'cat', open_stdin: true })
      const headers = { 'content-type': 'application/json' }
      expect((await fetch(route, { method: 'POST', headers, body })).status).toBe(400)
      expect((await fetch(`${route}?explain=true`, { method: 'POST', headers, body })).status).toBe(
        400,
      )
      const form = new FormData()
      form.append('request', new Blob([body], { type: 'application/json' }))
      form.append('stdin', new Blob(['x']))
      expect((await fetch(`${route}?stream=true`, { method: 'POST', body: form })).status).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('stdin routes name a running line with open stdin', async () => {
    const app = buildApp()
    const abort = new AbortController()
    try {
      const base = await served(app, 'named')
      await createWs(app, 'elsewhere')
      const unknown = `${base}/v1/workspaces/named/lines/nope/stdin`
      expect((await writeStdin(unknown, 'x')).status).toBe(404)
      expect((await fetch(unknown, { method: 'DELETE' })).status).toBe(404)
      void fetch(`${base}/v1/workspaces/named/shell?stream=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'sleep 5' }),
        signal: abort.signal,
      }).catch(() => undefined)
      let lineId: string | undefined
      while (lineId === undefined) {
        const listed = await fetch(`${base}/v1/workspaces/named/lines?state=running`)
        lineId = ((await listed.json()) as { id: string }[])[0]?.id
      }
      expect(
        (await writeStdin(`${base}/v1/workspaces/named/lines/${lineId}/stdin`, 'x')).status,
      ).toBe(409)
      const elsewhere = `${base}/v1/workspaces/elsewhere/lines/${lineId}/stdin`
      expect((await fetch(elsewhere, { method: 'DELETE' })).status).toBe(404)
    } finally {
      abort.abort()
      await app.close()
    }
  })

  it('answers a line that stops reading its stdin', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'stops')
      const text = new TextEncoder()
      const chunk = text.encode('abcdefgh'.repeat(8192))
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode(requestPart('head -c 3') + part('stdin', 'stdin.bin')))
          for (let i = 0; i < 64; i++) controller.enqueue(chunk)
          controller.enqueue(text.encode(END))
          controller.close()
        },
      })
      const res = await fetch(`${base}/v1/workspaces/stops/shell`, {
        method: 'POST',
        headers: MULTIPART,
        body,
        duplex: 'half',
      } as RequestInit)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { stdout: string }).stdout).toBe('abc')
    } finally {
      await app.close()
    }
  })

  it('starts the line before its stdin sends a byte', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'early')
      const text = new TextEncoder()
      let running = false
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            text.encode(requestPart('cat > /out.txt') + part('stdin', 'stdin.bin')),
          )
          for (let i = 0; i < 250 && !running; i++) {
            running = lines(app, 'early').some((line) => line.state === 'running')
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          controller.enqueue(text.encode(`late\n${END}`))
          controller.close()
        },
      })
      const res = await fetch(`${base}/v1/workspaces/early/shell`, {
        method: 'POST',
        headers: MULTIPART,
        body,
        duplex: 'half',
      } as RequestInit)
      expect(res.status).toBe(200)
      expect(running).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('refuses a body that stops before its last boundary', async () => {
    const app = buildApp()
    try {
      const base = await served(app, 'cut')
      const res = await fetch(`${base}/v1/workspaces/cut/shell`, {
        method: 'POST',
        headers: MULTIPART,
        body: `${requestPart('cat')}${part('stdin', 'stdin.bin')}abc`,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { detail: string }).detail).toBe('multipart body ended early')
    } finally {
      await app.close()
    }
  })

  it('reads stdin whole however the body is split', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'split')
      const stdin = `a\r\n--${BOUNDARY.slice(0, 5)}\r\r\n-\r\n--${BOUNDARY.slice(0, -1)}\r`
      const body = Buffer.from(`${requestPart('cat')}${part('stdin', 'stdin.bin')}${stdin}${END}`)
      const chunks = Array.from({ length: Math.ceil(body.length / 3) }, (_, i) =>
        body.subarray(i * 3, i * 3 + 3),
      )
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/split/shell',
        headers: MULTIPART,
        payload: Readable.from(chunks),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ stdout: string }>().stdout).toBe(stdin)
    } finally {
      await app.close()
    }
  })

  it('refuses part headers past the bound', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'headers')
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/headers/shell',
        headers: MULTIPART,
        payload: `--${BOUNDARY}\r\nX-Pad: ${'x'.repeat(20000)}\r\n${requestPart('true').slice(`--${BOUNDARY}\r\n`.length)}${END.slice(2)}`,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ detail: string }>().detail).toBe(
        'bad multipart body: Maximum header size exceeded',
      )
    } finally {
      await app.close()
    }
  })

  it('refuses stdin before the request part', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'order')
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/order/shell',
        headers: MULTIPART,
        payload: `${part('stdin', 'stdin.bin')}abc\r\n${requestPart('cat')}${END.slice(2)}`,
      })
      expect(res.statusCode).toBe(400)
      expect(res.headers.connection).toBe('close')
      expect(res.json<{ detail: string }>().detail).toContain("before 'stdin'")
    } finally {
      await app.close()
    }
  })
})

it('inherits io config from HTTP workspace creation', async () => {
  const app = buildApp()
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'configured-stream',
        config: { mounts: { '/': { vfs: 'ram', mode: 'write' } }, io: { buffer_bytes: 131072 } },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(app.registry.get('configured-stream').runner.ws.io.bufferBytes).toBe(131072)
    const data = Uint8Array.from({ length: 256 * 1025 }, (_, i) => i % 256)
    const form = new FormData()
    form.set('request', JSON.stringify({ command: 'cat; printf err >&2' }))
    form.set('stdin', new Blob([data]), 'stdin.bin')
    const upload = new Request('http://localhost', { method: 'POST', body: form })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/configured-stream/shell?stream=true',
      headers: { 'content-type': upload.headers.get('content-type') ?? '' },
      payload: Buffer.from(await upload.arrayBuffer()),
    })
    expect(response.statusCode).toBe(200)
    const events = response.body
      .trimEnd()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            stream?: string
            data?: string
            status?: string
            result?: { exit_code: number }
          },
      )
    const output = (stream: string): Buffer =>
      Buffer.concat(
        events
          .filter((event) => event.stream === stream)
          .map((event) => Buffer.from(event.data ?? '', 'base64')),
      )
    expect(output('stdout')).toEqual(Buffer.from(data))
    expect(output('stderr')).toEqual(Buffer.from('err'))
    expect(events.at(-1)).toMatchObject({ status: 'done', result: { exit_code: 0 } })
  } finally {
    await app.close()
  }
})

it.each(['', 'x'.repeat(128 * 1024 + 1)])(
  'streams exact bytes on separate channels before final metadata',
  async (padding) => {
    const app = buildApp()
    try {
      await createWs(app, 'byte-stream')
      const response = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/byte-stream/shell?stream=true',
        payload: { command: `printf '\\377\\000x${padding}'; printf err >&2; false` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('application/x-ndjson')
      const events = response.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown) as {
        stream?: string
        data?: string
        status?: string
        result?: { exit_code: number; stdout: string; stderr: string }
      }[]
      const output = (stream: string): Buffer =>
        Buffer.concat(
          events.filter((e) => e.stream === stream).map((e) => Buffer.from(e.data ?? '', 'base64')),
        )
      expect(output('stdout')).toEqual(
        Buffer.concat([Buffer.from([255, 0, 120]), Buffer.from(padding)]),
      )
      expect(output('stderr')).toEqual(Buffer.from('err'))
      expect(
        events
          .filter((event) => event.stream !== undefined)
          .every((event) => Buffer.from(event.data ?? '', 'base64').byteLength <= 8 * 1024),
      ).toBe(true)
      expect(events.at(-1)).toMatchObject({
        status: 'done',
        result: { exit_code: 1, stdout: '', stderr: '' },
      })
      const last = lines(app, 'byte-stream').at(-1)
      expect([last?.exit, last?.signal]).toEqual([1, null])
    } finally {
      await app.close()
    }
  },
)

it.each(['explain'])('refuses streaming with %s before submitting work', async (other) => {
  const app = buildApp()
  try {
    await createWs(app, 'bad-stream')
    const result = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/bad-stream/shell?stream=true&${other}=true`,
      payload: { command: 'echo no' },
    })
    expect(result.statusCode).toBe(400)
    expect(app.jobs.requests()).toEqual([])
  } finally {
    await app.close()
  }
})

it('streams a prefix before completion and joins cancellation after disconnect', async () => {
  const app = buildApp()
  try {
    await createWs(app, 'early-stream')
    const base = await app.listen({ host: '127.0.0.1', port: 0 })
    const stop = new AbortController()
    const response = await fetch(`${base}/v1/workspaces/early-stream/shell?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo ready; sleep 30' }),
      signal: stop.signal,
    })
    if (response.body === null) throw new Error('missing response body')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain(
      Buffer.from('ready\n').toString('base64'),
    )
    const [line] = lines(app, 'early-stream')
    if (line === undefined) throw new Error('the line was not recorded')
    expect(line.state).toBe('running')
    stop.abort()
    await reader.cancel().catch(() => undefined)
    const final = await ended(app, 'early-stream', line.id)
    expect([final.signal, typeof final.endedAt]).toEqual([2, 'number'])
  } finally {
    await app.close()
  }
})

describe('shutdown', () => {
  it('refuses a new line while the server shuts down', async () => {
    const app = buildApp()
    await createWs(app, 'late')
    app.registry.draining = true
    const r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/late/shell',
      payload: { command: 'echo late' },
    })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toEqual({ detail: 'server is shutting down' })
    await app.close()
  })
})

function openStdin(
  base: string,
  id: string,
  command: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/v1/workspaces/${id}/shell?stream=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, open_stdin: true }),
    signal,
  })
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
      yield JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
    }
  }
}

function writeStdin(route: string, text: string): Promise<Response> {
  return fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: text,
  })
}

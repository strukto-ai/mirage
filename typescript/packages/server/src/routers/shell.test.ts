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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.ts'

async function createWs(app: ReturnType<typeof buildApp>, id: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { id, config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
  })
}

describe('execute router', () => {
  it.each([
    ['ram', false],
    ['ram', true],
    ['disk', false],
    ['disk', true],
  ] as const)(
    'preserves large multipart stdin on %s (background=%s)',
    async (vfs, background) => {
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
        form.set(
          'request',
          background ? new Blob([request], { type: 'application/json' }) : request,
        )
        form.set('stdin', new Blob([stdin]), 'stdin.bin')
        const upload = new Request('http://localhost', { method: 'POST', body: form })
        const result = await app.inject({
          method: 'POST',
          url: `/v1/workspaces/large-stdin/shell?background=${String(background)}`,
          headers: { 'content-type': upload.headers.get('content-type') ?? '' },
          payload: Buffer.from(await upload.arrayBuffer()),
        })
        expect(result.statusCode).toBe(background ? 202 : 200)
        if (background) {
          const job = result.json<{ job_id: string }>()
          const waited = await app.inject({ method: 'POST', url: `/v1/jobs/${job.job_id}/wait` })
          expect(waited.json<{ status: string }>().status).toBe('done')
        } else {
          expect(result.json<{ exit_code: number }>().exit_code).toBe(0)
        }
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
      const jobs = await app.inject({ method: 'GET', url: '/v1/jobs?workspace_id=multipart-empty' })
      expect(jobs.json<unknown[]>()).toHaveLength(1)
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
    expect(res.headers['x-mirage-job-id']).toMatch(/^exec_/)
    const body = res.json<{ kind: string; stdout: string; exit_code: number }>()
    expect(body.kind).toBe('io')
    expect(body.stdout.trim()).toBe('hi')
    expect(body.exit_code).toBe(0)
    await app.close()
  })

  it('refuses an unknown field rather than ignoring it', async () => {
    const app = buildApp()
    await createWs(app, 'ew-strict')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew-strict/shell',
      payload: { command: 'echo hi', provision: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ detail: string }>().detail).toContain('provision')
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
    expect(res.statusCode).toBe(400)
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

  it('POST /v1/jobs/:id/wait accepts an empty body', async () => {
    const app = buildApp()
    await createWs(app, 'ewait')
    const submit = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ewait/shell?background=true',
      payload: { command: 'echo hi' },
    })
    const { job_id: jobId } = submit.json<{ job_id: string }>()
    const res = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/wait` })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('background=true returns 202 + job_id', async () => {
    const app = buildApp()
    await createWs(app, 'ew2')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew2/shell?background=true',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ job_id: string }>()
    expect(body.job_id).toMatch(/^exec_/)
    expect(res.headers['x-mirage-job-id']).toBe(body.job_id)
    await app.close()
  })

  it('GET /v1/jobs lists jobs filtered by workspace', async () => {
    const app = buildApp()
    await createWs(app, 'ew3')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew3/shell',
      payload: { command: 'echo hi' },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/jobs?workspace_id=ew3' })
    const body = res.json<{ workspace_id: string }[]>()
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]?.workspace_id).toBe('ew3')
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
    const job = await vi.waitFor(async () => {
      const [entry] = app.jobs.list('ecancel')
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
      let status = ''
      for (let i = 0; i < 100; i++) {
        const jobs = (await (await fetch(`${base}/v1/jobs?workspace_id=drop`)).json()) as {
          status: string
        }[]
        status = jobs[0]?.status ?? ''
        if (status === 'canceled') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(status).toBe('canceled')
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
            const jobs = (await (await fetch(`${base}/v1/jobs?workspace_id=streamed`)).json()) as {
              status: string
            }[]
            running = jobs.some((j) => j.status === 'running')
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
            const jobs = (await (await fetch(`${base}/v1/jobs?workspace_id=early`)).json()) as {
              status: string
            }[]
            running = jobs.some((j) => j.status === 'running')
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
      const job = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${String(response.headers['x-mirage-job-id'])}`,
      })
      expect(job.json<{ status: string }>().status).toBe('done')
    } finally {
      await app.close()
    }
  },
)

it.each(['background', 'explain'])(
  'refuses streaming with %s before submitting work',
  async (other) => {
    const app = buildApp()
    try {
      await createWs(app, 'bad-stream')
      const result = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/bad-stream/shell?stream=true&${other}=true`,
        payload: { command: 'echo no' },
      })
      expect(result.statusCode).toBe(400)
      const jobs = await app.inject({ method: 'GET', url: '/v1/jobs' })
      expect(jobs.json()).toEqual([])
    } finally {
      await app.close()
    }
  },
)

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
    const jobId = response.headers.get('X-Mirage-Job-Id') ?? ''
    if (response.body === null) throw new Error('missing response body')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain(
      Buffer.from('ready\n').toString('base64'),
    )
    expect(
      (await (await fetch(`${base}/v1/jobs/${jobId}`)).json()) as { status: string },
    ).toMatchObject({ status: 'running' })
    stop.abort()
    await reader.cancel().catch(() => undefined)
    const waited = await fetch(`${base}/v1/jobs/${jobId}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout_s: 3 }),
    })
    const final = (await waited.json()) as { status: string; finished_at: number | null }
    expect(final.status).toBe('canceled')
    expect(typeof final.finished_at).toBe('number')
  } finally {
    await app.close()
  }
})

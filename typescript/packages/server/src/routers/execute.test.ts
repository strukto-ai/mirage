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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
          url: `/v1/workspaces/large-stdin/execute?background=${String(background)}`,
          headers: { 'content-type': upload.headers.get('content-type') ?? '' },
          payload: Buffer.from(await upload.arrayBuffer()),
        })
        expect(result.statusCode).toBe(background ? 202 : 200)
        if (background) {
          const job = result.json<{ jobId: string }>()
          const waited = await app.inject({ method: 'POST', url: `/v1/jobs/${job.jobId}/wait` })
          expect(waited.json<{ status: string }>().status).toBe('done')
        } else {
          expect(result.json<{ exitCode: number }>().exitCode).toBe(0)
        }
        const read = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/large-stdin/execute',
          payload: { command: 'base64 /work/input.bin' },
        })
        expect(read.json<{ exitCode: number }>().exitCode).toBe(0)
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
        // File first also covers clients whose multipart fields arrive out of order.
        form.set('stdin', new Blob([]), 'stdin.bin')
        if (request !== undefined) form.set('request', request)
        const upload = new Request('http://localhost', { method: 'POST', body: form })
        const result = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/multipart-empty/execute',
          headers: { 'content-type': upload.headers.get('content-type') ?? '' },
          payload: Buffer.from(await upload.arrayBuffer()),
        })
        expect(result.statusCode).toBe(request?.startsWith('{"command"') === true ? 200 : 400)
        if (result.statusCode === 200) {
          expect(result.json<{ stdout: string }>().stdout.trim()).toBe('0')
        }
      }
      const jobs = await app.inject({ method: 'GET', url: '/v1/jobs?workspaceId=multipart-empty' })
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
      url: '/v1/workspaces/ew/execute',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-mirage-job-id']).toMatch(/^job_/)
    const body = res.json<{ kind: string; stdout: string; exitCode: number }>()
    expect(body.kind).toBe('io')
    expect(body.stdout.trim()).toBe('hi')
    expect(body.exitCode).toBe(0)
    await app.close()
  })

  it('honors a cwd for the line', async () => {
    const app = buildApp()
    await createWs(app, 'ecwd')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ecwd/execute',
      payload: { command: 'mkdir -p /sub && echo -n nested > /sub/f.txt' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ecwd/execute',
      payload: { command: 'cat f.txt', cwd: '/sub' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ stdout: string; exitCode: number }>()
    expect(body.exitCode).toBe(0)
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
      url: '/v1/workspaces/ert/execute',
      payload: { command: 'echo hi', runtime: 'no-such-runtime' },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json<{ detail: string }>().detail).toContain('unknown runtime')
    await app.close()
  })

  it('passes base64 stdin to command execution', async () => {
    const app = buildApp()
    await createWs(app, 'estdin')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/estdin/execute',
      payload: {
        command: 'wc -l',
        stdinBase64: Buffer.from('a\nb\nc\n').toString('base64'),
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ kind: string; stdout: string; exitCode: number }>()
    expect(body.kind).toBe('io')
    expect(body.stdout.trim()).toMatch(/^3\b/)
    expect(body.exitCode).toBe(0)
    await app.close()
  })

  it('honors record=false by leaving no history entry', async () => {
    const app = buildApp()
    await createWs(app, 'erec')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/execute',
      payload: { command: 'echo recorded' },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/execute',
      payload: { command: 'echo hidden', record: false },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/erec/execute',
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
      url: '/v1/workspaces/ewait/execute?background=true',
      payload: { command: 'echo hi' },
    })
    const { jobId } = submit.json<{ jobId: string }>()
    const res = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/wait` })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('background=true returns 202 + job_id', async () => {
    const app = buildApp()
    await createWs(app, 'ew2')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew2/execute?background=true',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ jobId: string }>()
    expect(body.jobId).toMatch(/^job_/)
    await app.close()
  })

  it('GET /v1/jobs lists jobs filtered by workspace', async () => {
    const app = buildApp()
    await createWs(app, 'ew3')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ew3/execute',
      payload: { command: 'echo hi' },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/jobs?workspaceId=ew3' })
    const body = res.json<{ workspaceId: string }[]>()
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]?.workspaceId).toBe('ew3')
    await app.close()
  })
})

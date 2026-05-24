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

import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

async function createWs(app: ReturnType<typeof buildApp>, id: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { id, config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
  })
}

describe('execute router', () => {
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

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
    payload: { id, config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
  })
}

describe('sessions router', () => {
  it('POST creates a session, GET lists, DELETE removes', async () => {
    const app = buildApp()
    await createWs(app, 'sw')
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/sw/sessions',
      payload: { session_id: 'agent_a' },
    })
    expect(created.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: '/v1/workspaces/sw/sessions' })
    const sessions = list.json<{ session_id: string; cwd: string }[]>()
    expect(sessions.some((s) => s.session_id === 'agent_a')).toBe(true)
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/workspaces/sw/sessions/agent_a',
    })
    expect(del.statusCode).toBe(200)
    await app.close()
  })

  it('accepts a mount mode mapping and refuses a bare list', async () => {
    // A list of prefixes used to mean "only these mounts". A profile now
    // narrows the mounts it names and never decides whether one exists,
    // so the list would be a silent no-op that still reads like
    // confinement: the door refuses it instead.
    const app = buildApp()
    await createWs(app, 'grants-ws')
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { session_id: 'agent_r', mounts: { '/': 'read' } },
    })
    expect(created.statusCode).toBe(201)
    const listForm = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { session_id: 'agent_l', mounts: ['/'] },
    })
    expect(listForm.statusCode).toBe(422)
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { session_id: 'agent_x', mounts: { '/': 'admin' } },
    })
    expect(bad.statusCode).toBe(422)
    const unknownRole = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { session_id: 'agent_p', profile: 'nope' },
    })
    expect(unknownRole.statusCode).toBe(422)
    await app.close()
  })

  it('returns 409 on duplicate session id', async () => {
    const app = buildApp()
    await createWs(app, 'dup-ws')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/dup-ws/sessions',
      payload: { session_id: 'dup' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/dup-ws/sessions',
      payload: { session_id: 'dup' },
    })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('returns 404 for unknown workspace', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/missing/sessions',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('session cancel and kill', () => {
  async function waitStatus(
    app: ReturnType<typeof buildApp>,
    jobId: string,
    status: string,
  ): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      const job = (await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })).json<{
        status: string
      }>()
      if (job.status === status) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`job ${jobId} never reached ${status}`)
  }

  it('cancel stops the jobs of the session and spares the others', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'cw')
      const jobs: Record<string, string> = {}
      for (const sid of ['a', 'b']) {
        await app.inject({
          method: 'POST',
          url: '/v1/workspaces/cw/sessions',
          payload: { session_id: sid },
        })
        const r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/cw/shell?background=true',
          payload: { command: 'sleep 30', session_id: sid },
        })
        jobs[sid] = r.json<{ job_id: string }>().job_id
        await waitStatus(app, jobs[sid], 'running')
      }
      const r = await app.inject({ method: 'POST', url: '/v1/workspaces/cw/sessions/a/cancel' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ canceled: 1 })
      await waitStatus(app, jobs.a ?? '', 'canceled')
      const b = (await app.inject({ method: 'GET', url: `/v1/jobs/${jobs.b ?? ''}` })).json<{
        status: string
      }>()
      expect(b.status).toBe('running')
      const missing = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/cw/sessions/nope/cancel',
      })
      expect(missing.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('kill stops background jobs and keeps the session', async () => {
    const app = buildApp()
    try {
      await createWs(app, 'kw')
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces/kw/sessions',
        payload: { session_id: 'a' },
      })
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces/kw/shell',
        payload: { command: 'sleep 30 &', session_id: 'a' },
      })
      const r = await app.inject({ method: 'POST', url: '/v1/workspaces/kw/sessions/a/kill' })
      expect(r.json()).toEqual({ killed: 1 })
      const after = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/kw/shell',
        payload: { command: 'jobs; echo alive', session_id: 'a' },
      })
      expect(after.json<{ stdout: string }>().stdout).toContain('alive')
    } finally {
      await app.close()
    }
  })
})

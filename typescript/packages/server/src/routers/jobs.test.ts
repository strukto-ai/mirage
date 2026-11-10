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

import { expect, it } from 'vitest'
import { buildApp } from '../app.ts'

type App = ReturnType<typeof buildApp>

async function createWs(app: App, id: string): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { id, config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
  })
  expect(r.statusCode).toBe(201)
}

async function shell(
  app: App,
  wsId: string,
  command: string,
): Promise<{ stdout: string; line_id: string }> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/shell`,
    payload: { command },
  })
  expect(r.statusCode).toBe(200)
  return r.json()
}

async function get(app: App, url: string): Promise<{ status: number; body: unknown }> {
  const r = await app.inject({ method: 'GET', url })
  return { status: r.statusCode, body: r.json() }
}

// A job is listed while its session lists it, with the pid `$!` names, and
// found by its id with the processes it ran.
it('lists a running job and finds it by id', async () => {
  const app = buildApp()
  try {
    await createWs(app, 'w')
    const result = await shell(app, 'w', 'sleep 30 & echo $!')
    const pid = Number(result.stdout)
    try {
      const listed = await get(app, '/v1/workspaces/w/jobs?state=running')
      expect(listed.status).toBe(200)
      const lost = await get(app, '/v1/workspaces/nope/jobs?state=lost')
      expect([lost.status, lost.body]).toEqual([
        400,
        {
          error: {
            code: 'invalid_value',
            message: 'state must be one of running, stopping, exited',
            param: 'state',
          },
        },
      ])
      const [job] = listed.body as {
        id: string
        number: number
        command: string
        line_id: string
        pid: number
      }[]
      expect([job?.number, job?.command, job?.line_id, job?.pid]).toEqual([
        1,
        'sleep 30',
        result.line_id,
        pid,
      ])
      expect(job?.id).toMatch(/^job_[0-9a-f]{32}$/)
      const found = await get(app, `/v1/workspaces/w/jobs/${job?.id ?? ''}`)
      expect([found.status, found.body]).toEqual([200, { ...job, processes: [pid] }])
      const bare = (job?.id ?? '').replace('job_', '')
      const missing = await get(app, `/v1/workspaces/w/jobs/${bare}`)
      expect([missing.status, missing.body]).toEqual([
        404,
        { error: { code: 'not_found', message: 'job not found' } },
      ])
      expect((await get(app, `/v1/workspaces/w/jobs?line_id=${result.line_id}`)).body).toEqual([
        job,
      ])
      expect((await get(app, '/v1/workspaces/w/jobs?line_id=nope')).body).toEqual([])
      expect((await get(app, '/v1/workspaces/w/jobs?session_id=other')).body).toEqual([])
      expect((await get(app, '/v1/workspaces/w/jobs/nope')).status).toBe(404)
    } finally {
      await shell(app, 'w', 'kill %1; wait')
    }
  } finally {
    await app.close()
  }
})

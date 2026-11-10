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

// A process is listed live and, once ended, with how it ended.
it('lists a process live and after it ends', async () => {
  const app = buildApp()
  try {
    await createWs(app, 'w')
    const result = await shell(app, 'w', 'sleep 30 & echo $!')
    const pid = Number(result.stdout)
    const running = await get(app, '/v1/workspaces/w/processes?state=running')
    expect(running.status).toBe(200)
    expect((running.body as { pid: number }[]).map((p) => p.pid)).toEqual([pid])
    const ran = await get(app, `/v1/workspaces/w/processes?line_id=${result.line_id}`)
    expect((ran.body as { pid: number }[]).map((p) => p.pid)).toContain(pid)
    const [job] = (await get(app, '/v1/workspaces/w/jobs')).body as { id: string }[]
    const bare = (job?.id ?? '').replace('job_', '')
    const ofBare = await get(app, `/v1/workspaces/w/processes?job_id=${bare}`)
    expect([ofBare.status, ofBare.body]).toEqual([200, []])
    const ofJob = await get(app, `/v1/workspaces/w/processes?job_id=${job?.id ?? ''}`)
    const [live] = ofJob.body as { pid: number; machine: string; machine_pid: unknown }[]
    expect([live?.pid, live?.machine_pid]).toEqual([pid, null])
    const there = await get(
      app,
      `/v1/workspaces/w/processes?machine=${encodeURIComponent(live?.machine ?? '')}`,
    )
    expect((there.body as { pid: number }[]).map((p) => p.pid)).toContain(pid)
    expect((await get(app, '/v1/workspaces/w/processes?machine=docker:nowhere')).body).toEqual([])
    const nowhere = await get(app, '/v1/workspaces/w/processes?machine=nowhere')
    expect([nowhere.status, nowhere.body]).toEqual([
      400,
      {
        error: {
          code: 'invalid_value',
          message: 'machine must be provider:name',
          param: 'machine',
        },
      },
    ])
    await shell(app, 'w', 'kill %1; wait')
    const ended = await get(app, `/v1/workspaces/w/processes/${String(pid)}`)
    expect(ended.status).toBe(200)
    const body = ended.body as { command: string; state: string; signal: number }
    expect([body.command, body.state, body.signal]).toEqual(['sleep 30', 'exited', 15])
    expect((await get(app, '/v1/workspaces/w/processes/99999')).status).toBe(404)
    expect((await get(app, '/v1/workspaces/w/processes/abc')).body).toEqual({
      error: { code: 'invalid_value', message: 'pid must be an integer', param: 'pid' },
    })
    expect((await get(app, '/v1/workspaces/nope/processes/abc')).status).toBe(400)
    expect((await get(app, '/v1/workspaces/nope/processes?state=lost')).status).toBe(400)
  } finally {
    await app.close()
  }
})

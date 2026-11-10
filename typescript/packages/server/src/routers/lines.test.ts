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

// A line the server runs answers with its id, by which the workspace's lines
// list and find it, with the jobs it started and what it ran.
it('lists a line and finds it by the id its result names', async () => {
  const app = buildApp()
  try {
    await createWs(app, 'w')
    const result = await shell(app, 'w', 'sleep 30 & echo $!')
    const pid = Number(result.stdout)
    try {
      const listed = await get(app, '/v1/workspaces/w/lines')
      expect(listed.status).toBe(200)
      const [line] = listed.body as { id: string; command: string; state: string; exit: number }[]
      expect([line?.id, line?.command, line?.state, line?.exit]).toEqual([
        result.line_id,
        'sleep 30 & echo $!',
        'exited',
        0,
      ])
      const detail = await get(app, `/v1/workspaces/w/lines/${result.line_id}`)
      expect(detail.status).toBe(200)
      const found = detail.body as { jobs: string[]; processes: number[]; machines: string[] }
      const [job] = (await get(app, '/v1/workspaces/w/jobs')).body as { id: string }[]
      expect(found.jobs).toEqual([job?.id])
      expect(job?.id.startsWith('job_')).toBe(true)
      expect(found.processes).toContain(pid)
      const process = (await get(app, `/v1/workspaces/w/processes/${String(pid)}`)).body as {
        machine: string
      }
      expect(found.machines).toEqual([process.machine])
      expect((await get(app, '/v1/workspaces/w/lines?state=running')).body).toEqual([])
      expect((await get(app, '/v1/workspaces/w/lines?state=lost')).status).toBe(422)
      expect((await get(app, '/v1/workspaces/w/lines/nope')).status).toBe(404)
    } finally {
      await shell(app, 'w', 'kill %1; wait')
    }
  } finally {
    await app.close()
  }
})

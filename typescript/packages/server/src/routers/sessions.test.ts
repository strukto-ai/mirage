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

describe('sessions router', () => {
  it('POST creates a session, GET lists, DELETE removes', async () => {
    const app = buildApp()
    await createWs(app, 'sw')
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/sw/sessions',
      payload: { sessionId: 'agent_a' },
    })
    expect(created.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: '/v1/workspaces/sw/sessions' })
    const sessions = list.json<{ sessionId: string; cwd: string }[]>()
    expect(sessions.some((s) => s.sessionId === 'agent_a')).toBe(true)
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/workspaces/sw/sessions/agent_a',
    })
    expect(del.statusCode).toBe(200)
    await app.close()
  })

  it('accepts mount role grants and rejects bad roles', async () => {
    const app = buildApp()
    await createWs(app, 'grants-ws')
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { sessionId: 'agent_r', mounts: { '/': 'read' } },
    })
    expect(created.statusCode).toBe(201)
    const listForm = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { sessionId: 'agent_l', mounts: ['/'] },
    })
    expect(listForm.statusCode).toBe(201)
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/grants-ws/sessions',
      payload: { sessionId: 'agent_x', mounts: { '/': 'admin' } },
    })
    expect(bad.statusCode).toBe(422)
    await app.close()
  })

  it('returns 409 on duplicate session id', async () => {
    const app = buildApp()
    await createWs(app, 'dup-ws')
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces/dup-ws/sessions',
      payload: { sessionId: 'dup' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/dup-ws/sessions',
      payload: { sessionId: 'dup' },
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

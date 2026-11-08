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

interface Machine {
  id: string
  state: string
  processes?: { command: string }[]
}

it('lists the host and reads it with its processes', async () => {
  const app = buildApp()
  try {
    const made = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'w', config: { mounts: { '/': { vfs: 'ram' } } } },
    })
    expect(made.statusCode).toBe(201)
    const ran = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/w/shell',
      payload: { command: 'sleep 30 &' },
    })
    expect(ran.statusCode).toBe(200)
    const listed = await app.inject({ method: 'GET', url: '/v1/workspaces/w/machines' })
    expect(listed.statusCode).toBe(200)
    const [host] = listed.json<Machine[]>()
    expect(host?.id.startsWith('host:')).toBe(true)
    expect(host?.state).toBe('managed')
    const one = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/w/machines/${encodeURIComponent(host?.id ?? '')}`,
    })
    expect(one.statusCode).toBe(200)
    expect(one.json<Machine>().processes?.map((p) => p.command)).toContain('sleep 30')
    const none = await app.inject({ method: 'GET', url: '/v1/workspaces/w/machines/docker:none' })
    expect(none.statusCode).toBe(404)
    const bad = await app.inject({ method: 'GET', url: '/v1/workspaces/w/machines/plain' })
    expect(bad.statusCode).toBe(400)
  } finally {
    await app.close()
  }
})

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

describe('health router', () => {
  it('answers ready 503 while full or draining', async () => {
    const app = buildApp({ maxWorkspaces: 1 })
    const ready = () => app.inject({ method: 'GET', url: '/v1/ready' })
    let r = await ready()
    expect([r.statusCode, r.json()]).toEqual([200, { status: 'ready' }])
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
    })
    expect(created.statusCode).toBe(201)
    r = await ready()
    expect([r.statusCode, r.json()]).toEqual([503, { status: 'full' }])
    await app.registry.drain(0)
    r = await ready()
    expect([r.statusCode, r.json()]).toEqual([503, { status: 'draining' }])
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200)
    await app.close()
  })
})

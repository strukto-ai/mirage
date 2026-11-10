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
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

const GUARD = 'def pre_command(call):\n    return None\n'

function appWithStore() {
  return buildApp({ idleGraceSeconds: 10, resourceStore: memoryResourceStore() })
}

describe('policies router', () => {
  it('creates, lists, updates and deletes a policy', async () => {
    const app = appWithStore()
    const saved = { name: 'guard.py', source: GUARD }
    const r = await app.inject({ method: 'POST', url: '/v1/policies', payload: saved })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toEqual(saved)
    const again = await app.inject({ method: 'POST', url: '/v1/policies', payload: saved })
    expect(again.statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/v1/policies' })).json()).toEqual({
      items: [{ name: 'guard.py' }],
    })
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/policies/guard.py',
      payload: { source: 'x = 1\n' },
    })
    expect(put.json()).toEqual({ name: 'guard.py', source: 'x = 1\n' })
    expect((await app.inject({ method: 'GET', url: '/v1/policies/guard.py' })).json()).toEqual({
      name: 'guard.py',
      source: 'x = 1\n',
    })
    expect((await app.inject({ method: 'DELETE', url: '/v1/policies/guard.py' })).statusCode).toBe(
      204,
    )
    expect((await app.inject({ method: 'GET', url: '/v1/policies/guard.py' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/v1/policies/guard.py' })).statusCode).toBe(
      404,
    )
    await app.close()
  })

  it('does not create a policy on update', async () => {
    const app = appWithStore()
    const r = await app.inject({
      method: 'PUT',
      url: '/v1/policies/guard.py',
      payload: { source: GUARD },
    })
    expect(r.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/policies' })).json()).toEqual({ items: [] })
    await app.close()
  })

  it('checks a policy name and source', async () => {
    const app = appWithStore()
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/policies', payload })
    const bare = await post({ name: 'guard', source: '' })
    expect(bare.statusCode).toBe(400)
    expect(bare.json<{ error: { message: string } }>().error).toEqual({
      code: 'invalid_value',
      message: 'name must end in .py, such as guard.py',
      param: 'name',
    })
    expect((await post({ name: 'big.py', source: '#'.repeat(64 * 1024 + 1) })).statusCode).toBe(400)
    expect((await post({ name: 'a.py', source: '', x: 1 })).statusCode).toBe(400)
    expect((await post({ name: 'a.py' })).statusCode).toBe(400)
    await app.close()
  })
})

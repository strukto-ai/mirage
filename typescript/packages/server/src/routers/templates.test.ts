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

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import { filesResourceStore } from '../resources/files.ts'

const RAM = { mounts: { '/': { vfs: 'ram', mode: 'write' } } }
const TWO = {
  mounts: { '/': { vfs: 'ram', mode: 'write' }, '/extra': { vfs: 'ram', mode: 'write' } },
}

function appWithStore() {
  return buildApp({ idleGraceSeconds: 10, resourceStore: memoryResourceStore() })
}

describe('templates router', () => {
  it('saves, lists, deletes and restores a template', async () => {
    const app = appWithStore()
    const saved = { name: 'base', description: 'ram only', config: RAM }
    const r = await app.inject({ method: 'POST', url: '/v1/templates', payload: saved })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toEqual(saved)
    const again = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 'base', config: RAM },
    })
    expect(again.statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/v1/templates' })).json()).toEqual([saved])
    expect((await app.inject({ method: 'GET', url: '/v1/templates/base' })).json()).toEqual(saved)
    expect((await app.inject({ method: 'DELETE', url: '/v1/templates/base' })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/v1/templates/base' })).statusCode).toBe(404)
    const restored = await app.inject({ method: 'POST', url: '/v1/templates/base/restore' })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toEqual(saved)
    const twice = await app.inject({ method: 'POST', url: '/v1/templates/base/restore' })
    expect(twice.statusCode).toBe(404)
    await app.close()
  })

  it('checks a template when it is saved', async () => {
    const app = appWithStore()
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 'bad', config: { mounts: { '/': { vfs: 'ram' } }, x: 1 } },
    })
    expect(bad.statusCode).toBe(400)
    const badName = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 'Bad', config: RAM },
    })
    expect(badName.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/templates' })).json()).toEqual([])
    await app.close()
  })

  it('creates a workspace from a copy of a template', async () => {
    const app = appWithStore()
    await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 'base', config: RAM },
    })
    const r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'from-t', template: 'base' },
    })
    expect(r.statusCode).toBe(201)
    const prefixes = (body: { mounts: { prefix: string }[] }) => body.mounts.map((m) => m.prefix)
    expect(prefixes(r.json())).toEqual(['/'])
    await app.resources.putTemplate({ name: 'base', config: TWO })
    const held = await app.inject({ method: 'GET', url: '/v1/workspaces/from-t' })
    expect(prefixes(held.json())).toEqual(['/'])
    await app.close()
  })

  it('creates from one known template or a config', async () => {
    const app = appWithStore()
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { template: 'nope' },
    })
    expect(unknown.statusCode).toBe(404)
    await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 'base', config: RAM },
    })
    const both = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { template: 'base', config: RAM },
    })
    expect(both.statusCode).toBe(400)
    expect(both.json()).toEqual({ detail: 'give a template or a config, not both' })
    const neither = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: {} })
    expect(neither.statusCode).toBe(400)
    const explained = await app.inject({
      method: 'POST',
      url: '/v1/workspaces?explain=true',
      payload: { template: 'base' },
    })
    expect(explained.statusCode).toBe(200)
    expect(explained.json()).toMatchObject({ outcome: 'allow' })
    await app.close()
  })

  it('keeps no templates on a server of many accounts', async () => {
    const app = appWithStore()
    app.registry.accountsRequired = true
    expect((await app.inject({ method: 'GET', url: '/v1/templates' })).statusCode).toBe(501)
    const save = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: { name: 't', config: RAM },
    })
    expect(save.statusCode).toBe(501)
    const create = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { template: 't' },
    })
    expect(create.statusCode).toBe(501)
    await app.close()
  })

  it('answers a broken record in the list as a bad request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-templates-'))
    mkdirSync(join(dir, 'template'))
    writeFileSync(join(dir, 'template', 'bad.yaml'), 'config: [\n')
    const app = buildApp({ idleGraceSeconds: 10, resourceStore: filesResourceStore(dir) })
    expect((await app.inject({ method: 'GET', url: '/v1/templates' })).statusCode).toBe(400)
    await app.close()
  })
})

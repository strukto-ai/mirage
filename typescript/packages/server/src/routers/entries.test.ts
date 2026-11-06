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

import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

const GITHUB = {
  name: 'github',
  type: 'github',
  fields: { owner: 'strukto-ai', repo: 'mirage', token: 'ghp_x' },
}

type App = ReturnType<typeof buildApp>
let open: App | null = null

function setup(): { app: App; store: ResourceStore } {
  const store = memoryResourceStore()
  open = buildApp({ idleGraceSeconds: 10, resourceStore: store })
  return { app: open, store }
}

afterEach(async () => {
  await open?.close()
  open = null
})

async function call(app: App, method: string, url: string, payload?: unknown) {
  const r = await app.inject({
    method: method as 'GET',
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
  return { status: r.statusCode, body: r.body === '' ? null : r.json(), text: r.body }
}

describe('entries router', () => {
  it('answers sealed fields by name only', async () => {
    const { app, store } = setup()
    const created = await call(app, 'POST', '/v1/vfs', GITHUB)
    expect(created.status).toBe(201)
    expect(created.body.config).toEqual({ owner: 'strukto-ai', repo: 'mirage' })
    expect(created.body).toMatchObject({ id: 'github', kind: 'vfs', builtin: false })
    expect(created.text).not.toContain('ghp_x')
    const got = await call(app, 'GET', '/v1/vfs/github')
    expect(got.body.sealed).toEqual(['token'])
    expect(got.text).not.toContain('ghp_x')
    const listed = await call(app, 'GET', '/v1/vfs')
    expect(listed.body.items.map((i: { name: string }) => i.name)).toEqual(['github'])
    expect(listed.body.items[0].used_by).toBe(0)
    expect(listed.body.items[0].sealed).toBeUndefined()
    expect((await store.revealEntry('vfs', 'github')).sealed).toEqual({ token: 'ghp_x' })
  })

  it('takes a name once across kinds, and answers an entry under its kind only', async () => {
    const { app } = setup()
    expect((await call(app, 'POST', '/v1/vfs', GITHUB)).status).toBe(201)
    const again = await call(app, 'POST', '/v1/vfs', GITHUB)
    expect(again).toMatchObject({ status: 409, body: { detail: 'github already exists' } })
    const gh = { name: 'github', type: 'gh', fields: { token: 't' } }
    expect((await call(app, 'POST', '/v1/clis', gh)).status).toBe(409)
    const other = await call(app, 'GET', '/v1/clis/github')
    expect(other).toMatchObject({ status: 404, body: { detail: 'CLI not found' } })
  })

  it('keeps a sealed field a PUT leaves out, and removes one given as null', async () => {
    const { app, store } = setup()
    await call(app, 'POST', '/v1/vfs', GITHUB)
    const kept = await call(app, 'PUT', '/v1/vfs/github', { fields: { owner: 'o', repo: 'r' } })
    expect(kept.status).toBe(200)
    expect(kept.body.config).toEqual({ owner: 'o', repo: 'r' })
    expect((await store.revealEntry('vfs', 'github')).sealed).toEqual({ token: 'ghp_x' })
    await call(app, 'PUT', '/v1/vfs/github', { fields: { owner: 'o', repo: 'r', token: 'ghp_y' } })
    expect((await store.revealEntry('vfs', 'github')).sealed).toEqual({ token: 'ghp_y' })
    const required = await call(app, 'PUT', '/v1/vfs/github', {
      fields: { owner: 'o', repo: 'r', token: null },
    })
    expect(required).toMatchObject({ status: 400, body: { detail: 'token is required' } })
    await call(app, 'POST', '/v1/clis', {
      name: 'mcp1',
      type: 'mcp',
      fields: { url: 'https://mcp.example.com', 'auth.type': 'bearer', 'auth.token': 's' },
    })
    const removed = await call(app, 'PUT', '/v1/clis/mcp1', {
      fields: { url: 'https://mcp.example.com', 'auth.token': null },
    })
    expect(removed.status).toBe(200)
    expect((await call(app, 'GET', '/v1/clis/mcp1')).body.sealed).toEqual([])
  })

  it('checks fields against the type', async () => {
    const { app } = setup()
    const cases: [unknown, string][] = [
      [{ type: 'nope', fields: {} }, 'type must be a vfs: '],
      [{ type: 'github', fields: { owner: 'o', repo: 'r' } }, 'token is required'],
      [{ type: 'github', fields: { ...GITHUB.fields, x: 1 } }, 'github has no field x; it takes '],
      [{ type: 'github', fields: { ...GITHUB.fields, timeout: '1' } }, 'timeout must be a number'],
      [{ type: 'github', fields: [] }, 'fields must be an object'],
    ]
    for (const [body, detail] of cases) {
      const r = await call(app, 'POST', '/v1/vfs', { name: 'x', ...(body as object) })
      expect(r.status).toBe(400)
      expect(r.body.detail.startsWith(detail)).toBe(true)
    }
    const mcp = await call(app, 'POST', '/v1/clis', {
      name: 'm',
      type: 'mcp',
      fields: { url: 'http://a.b' },
    })
    expect(mcp.body.detail).toBe("url must be the MCP server's https URL")
    const id = await call(app, 'POST', '/v1/vfs', { ...GITHUB, name: 'sec_x' })
    expect(id.status).toBe(400)
    expect(id.body.detail).toContain('not look like an id')
  })

  it('needs a store saved before a field points at it', async () => {
    const { app } = setup()
    const pointer = { from: 'aws', ref: 'gh', key: 'token' }
    const body = { ...GITHUB, fields: { ...GITHUB.fields, token: pointer } }
    const first = await call(app, 'POST', '/v1/vfs', body)
    expect(first).toMatchObject({
      status: 400,
      body: { detail: 'add aws under Secret stores first', missing: ['aws'] },
    })
    const region = await call(app, 'POST', '/v1/stores', {
      name: 'aws',
      type: 'aws-sm',
      fields: { region: 'x' },
    })
    expect(region.body.detail).toBe('region must be an AWS region, such as us-east-1')
    const store = await call(app, 'POST', '/v1/stores', {
      name: 'aws',
      type: 'aws-sm',
      fields: { region: 'us-east-1', aws_access_key_id: 'AK' },
    })
    expect(store.status).toBe(201)
    const pointed = await call(app, 'POST', '/v1/vfs', body)
    expect(pointed.status).toBe(201)
    expect(pointed.body.config.token).toEqual(pointer)
    const del = await call(app, 'DELETE', '/v1/stores/aws')
    expect(del).toMatchObject({ status: 409, body: { detail: 'aws is used by github' } })
    const taken = await call(app, 'POST', '/v1/stores', { name: 'env', type: 'aws-sm', fields: {} })
    expect(taken.body.detail).toContain('is a name Mirage gives a source')
  })

  it('wipes on delete, refused while a template uses the entry', async () => {
    const { app, store } = setup()
    await call(app, 'POST', '/v1/vfs', GITHUB)
    const config = { mounts: { '/gh': { vfs: 'github', config: { from: 'strukto', ref: 'github' } } } }
    await store.putTemplate({ name: 'agent', config })
    expect((await call(app, 'GET', '/v1/vfs')).body.items[0].used_by).toBe(1)
    const refused = await call(app, 'DELETE', '/v1/vfs/github')
    expect(refused).toMatchObject({ status: 409, body: { detail: 'github is used by agent' } })
    await store.deleteTemplate('agent')
    expect((await call(app, 'DELETE', '/v1/vfs/github')).status).toBe(204)
    expect((await call(app, 'GET', '/v1/vfs/github')).status).toBe(404)
    await call(app, 'POST', '/v1/vfs', { ...GITHUB, fields: { ...GITHUB.fields, token: 'n' } })
    expect((await store.revealEntry('vfs', 'github')).sealed).toEqual({ token: 'n' })
  })

  it('filters a list by type and name', async () => {
    const { app } = setup()
    await call(app, 'POST', '/v1/vfs', GITHUB)
    await call(app, 'POST', '/v1/vfs', { ...GITHUB, name: 'work-gh' })
    await call(app, 'POST', '/v1/vfs', { name: 'notes', type: 'notion', fields: { api_key: 'k' } })
    const names = async (query: string) =>
      (await call(app, 'GET', `/v1/vfs${query}`)).body.items.map((i: { name: string }) => i.name)
    expect(await names('')).toEqual(['github', 'notes', 'work-gh'])
    expect(await names('?type=github')).toEqual(['github', 'work-gh'])
    expect(await names('?q=GH')).toEqual(['work-gh'])
  })

  it('reads types off the config schemas', async () => {
    const { app } = setup()
    const vfs = (await call(app, 'GET', '/v1/vfs/types')).body
    const token = vfs.github.find((f: { name: string }) => f.name === 'token')
    expect(token).toMatchObject({ name: 'token', type: 'string', secret: true, required: true })
    expect(vfs.ram).toBeUndefined()
    const clis = (await call(app, 'GET', '/v1/clis/types')).body
    expect(clis.git).toBeUndefined()
    const auth = clis.mcp.find((f: { name: string }) => f.name === 'auth.type')
    expect(auth).toMatchObject({ group: 'auth', options: ['bearer', 'header'] })
    const runtimes = (await call(app, 'GET', '/v1/runtimes/types')).body
    const key = runtimes.daytona.find((f: { name: string }) => f.name === 'api_key')
    expect(key.secret).toBe(true)
    const stores = (await call(app, 'GET', '/v1/stores/types')).body
    expect(stores.env).toBeUndefined()
    expect(stores['aws-sm']).toBeDefined()
  })

  it('answers a runtime with its captures', async () => {
    const { app } = setup()
    const r = await call(app, 'POST', '/v1/runtimes', {
      name: 'dt',
      type: 'daytona',
      fields: { sandbox_id: 's1', api_key: 'k' },
    })
    expect(r.status).toBe(201)
    expect(r.body.captures).toEqual([])
    expect(r.body.config).toEqual({ sandbox_id: 's1' })
  })
})

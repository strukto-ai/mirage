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

import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function workspace(): Promise<{ app: ReturnType<typeof buildApp>; id: string }> {
  const app = buildApp()
  apps.push(app)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
  })
  expect(res.statusCode).toBe(201)
  return { app, id: res.json<{ id: string }>().id }
}

async function tool(
  app: ReturnType<typeof buildApp>,
  id: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<{ text: string; is_error: boolean }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${id}/tools/${name}`,
    payload,
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('the tool routes', () => {
  it('answer every tool over HTTP', async () => {
    const { app, id } = await workspace()
    const written = await tool(app, id, 'write', { path: '/src/a.py', content: 'Needle\n' })
    const read = await tool(app, id, 'read', { path: '/src/a.py' })
    const edited = await tool(app, id, 'edit', {
      path: '/src/a.py',
      old_string: 'Needle',
      new_string: 'pin',
    })
    const listed = await tool(app, id, 'ls', { path: '/src' })
    const found = await tool(app, id, 'grep', { pattern: 'PIN', path: '/src', ignore_case: true })
    const globbed = await tool(app, id, 'glob', { pattern: '**/*.py' })
    const shelled = await tool(app, id, 'shell', { command: 'echo hi' })
    expect(written).toEqual({ text: 'Written: /src/a.py', is_error: false })
    expect(read).toEqual({ text: '     1\tNeedle\n', is_error: false })
    expect(edited.is_error).toBe(false)
    expect(listed.text).toBe('a.py\n')
    expect(found).toEqual({ text: '/src/a.py:1:pin\n', is_error: false })
    expect(globbed).toEqual({ text: '/src/a.py\n', is_error: false })
    expect(shelled).toEqual({ text: 'hi\n', is_error: false })
  })

  it('keep the session stamps across requests', async () => {
    const { app, id } = await workspace()
    await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/shell`,
      payload: { command: 'echo one > /a' },
    })
    const refused = await tool(app, id, 'write', { path: '/a', content: 'x' })
    await tool(app, id, 'read', { path: '/a' })
    const written = await tool(app, id, 'write', { path: '/a', content: 'x' })
    expect(refused.is_error).toBe(true)
    expect(written.is_error).toBe(false)
  })

  it('refuse bad arguments and unknown targets', async () => {
    const { app, id } = await workspace()
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/tools/read`,
      payload: {},
    })
    const ws = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/nope/tools/read',
      payload: { path: '/a' },
    })
    const session = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/tools/read?session_id=nope`,
      payload: { path: '/a' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<{ detail: string }>().detail).toMatch(/^Invalid arguments for tool read/)
    expect(ws.statusCode).toBe(404)
    expect(ws.json()).toEqual({ detail: 'workspace not found' })
    expect(session.statusCode).toBe(404)
    expect(session.json()).toEqual({ detail: 'session not found' })
  })
})

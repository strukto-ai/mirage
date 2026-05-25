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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

type App = ReturnType<typeof buildApp>

describe('versions router', () => {
  let root: string
  let app: App
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-router-'))
    app = buildApp({ versionRoot: root })
  })
  afterEach(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function createWs(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
    })
    expect(res.statusCode).toBe(201)
    return res.json<{ id: string }>().id
  }

  async function write(id: string, command: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/execute`,
      payload: { command },
    })
    expect(res.statusCode).toBe(200)
  }

  async function cat(id: string, path: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/execute`,
      payload: { command: `cat ${path}` },
    })
    return res.json<{ stdout: string }>().stdout
  }

  async function commit(id: string, message: string, branch?: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/commit`,
      payload: { message, ...(branch !== undefined ? { branch } : {}) },
    })
    expect(res.statusCode).toBe(200)
    return res.json<{ version: string }>().version
  }

  it('commit / log / checkout flow', async () => {
    const id = await createWs()
    await write(id, 'echo v1 > /notes.txt')
    const v1 = await commit(id, 'first')
    await write(id, 'echo v2 > /notes.txt')
    await commit(id, 'second')

    const log = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/versions` })
    expect(log.json<{ message: string }[]>().map((e) => e.message)).toEqual(['second', 'first'])

    expect(await cat(id, '/notes.txt')).toBe('v2\n')
    const co = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkout`,
      payload: { ref: v1 },
    })
    expect(co.statusCode).toBe(200)
    expect(await cat(id, '/notes.txt')).toBe('v1\n')
  })

  it('diff follows git (version/version, live/version, live/HEAD)', async () => {
    const id = await createWs()
    await write(id, 'echo one > /a.txt')
    const v1 = await commit(id, 'first')
    await write(id, 'echo two > /a.txt')
    await write(id, 'echo new > /b.txt')
    const v2 = await commit(id, 'second')

    const d1 = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/diff?a=${v1}&b=${v2}` })
    expect(d1.json<{ modified: string[]; added: string[] }>()).toMatchObject({
      modified: ['a.txt'],
      added: ['b.txt'],
    })

    await write(id, 'echo three > /a.txt')
    const d2 = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/diff?a=${v2}` })
    expect(d2.json<{ modified: string[] }>().modified).toEqual(['a.txt'])

    const d3 = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/diff` })
    expect(d3.json<{ modified: string[] }>().modified).toEqual(['a.txt'])
  })

  it('branch diverges and guards commit (git-literal)', async () => {
    const id = await createWs()
    await write(id, 'echo one > /a.txt')
    await commit(id, 'first')

    const br = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/branch`,
      payload: { name: 'exp' },
    })
    expect(br.statusCode).toBe(201)

    await write(id, 'echo two > /a.txt')
    await commit(id, 'on exp', 'exp')

    const expLog = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/versions?branch=exp`,
    })
    const mainLog = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/versions` })
    expect(expLog.json<{ message: string }[]>().map((e) => e.message)).toEqual(['on exp', 'first'])
    expect(mainLog.json<{ message: string }[]>().map((e) => e.message)).toEqual(['first'])

    const ghost = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/commit`,
      payload: { branch: 'ghost' },
    })
    expect(ghost.statusCode).toBe(404)
  })

  it('clones from a version into a new workspace', async () => {
    const id = await createWs()
    await write(id, 'echo base > /b.txt')
    const version = await commit(id, 'base')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/clone',
      payload: { sourceId: id, at: version },
    })
    expect(res.statusCode).toBe(201)
    const newId = res.json<{ id: string }>().id
    expect(newId).not.toBe(id)
    expect(await cat(newId, '/b.txt')).toBe('base\n')
  })

  it('returns empty log before any commit', async () => {
    const id = await createWs()
    const res = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/versions` })
    expect(res.json()).toEqual([])
  })

  it('404s commit on unknown workspace and checkout on bad ref', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/nope/commit',
      payload: {},
    })
    expect(missing.statusCode).toBe(404)

    const id = await createWs()
    await write(id, 'echo x > /x.txt')
    await commit(id, 'first')
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkout`,
      payload: { ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(bad.statusCode).toBe(404)
  })
})

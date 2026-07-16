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

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('workspaces router', () => {
  it('GET /v1/health returns ok', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; workspaces: number }>()
    expect(body.status).toBe('ok')
    expect(body.workspaces).toBe(0)
    await app.close()
  })

  it('POST /v1/workspaces creates and returns detail', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string }>()
    expect(body.id).toMatch(UUID7_RE)
    await app.close()
  })

  it('GET /v1/workspaces lists active workspaces', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'fixed-id',
        config: { mounts: { '/': { resource: 'ram', mode: 'write' } } },
      },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/workspaces' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string }[]>()
    expect(body.some((w) => w.id === 'fixed-id')).toBe(true)
    await app.close()
  })

  it('POST /v1/workspaces returns 400 for missing mounts', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: {} },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /v1/workspaces returns 502 when resource build fails', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { resource: 'not-a-real-resource' } } } },
    })
    expect(res.statusCode).toBe(502)
    await app.close()
  })

  it('DELETE /v1/workspaces/:id removes', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'to-delete',
        config: { mounts: { '/': { resource: 'ram', mode: 'write' } } },
      },
    })
    const res = await app.inject({ method: 'DELETE', url: '/v1/workspaces/to-delete' })
    expect(res.statusCode).toBe(200)
    const detail = await app.inject({ method: 'GET', url: '/v1/workspaces/to-delete' })
    expect(detail.statusCode).toBe(404)
    await app.close()
  })

  it('POST /v1/workspaces/:id/clone produces a new id', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'src-w', config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/src-w/clone',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string }>()
    expect(body.id).toMatch(UUID7_RE)
    expect(body.id).not.toBe('src-w')
    await app.close()
  })

  it('POST /v1/workspaces/:id/clone 404s for unknown source', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/missing/clone',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /v1/workspaces/:id/snapshot writes a tar to the path and load round-trips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ws-'))
    const tar = join(dir, 'seed.tar')
    const app1 = buildApp({ snapshotRoot: dir })
    try {
      await app1.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'seed', config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
      })
      const snap = await app1.inject({
        method: 'POST',
        url: '/v1/workspaces/seed/snapshot',
        payload: { path: tar },
      })
      expect(snap.statusCode).toBe(200)
      const snapBody = snap.json<{ path: string; size: number }>()
      expect(snapBody.path).toBe(tar)
      expect(snapBody.size).toBeGreaterThan(0)
      expect(existsSync(tar)).toBe(true)

      const app2 = buildApp({ snapshotRoot: dir })
      try {
        const res = await app2.inject({
          method: 'POST',
          url: '/v1/workspaces/load',
          payload: { path: tar, id: 'loaded' },
        })
        expect(res.statusCode).toBe(201)
        expect(res.json<{ id: string }>().id).toBe('loaded')
      } finally {
        await app2.close().catch(() => undefined)
      }
    } finally {
      await app1.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces/:id/snapshot rejects a path outside the snapshot root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ws-'))
    const app = buildApp({ snapshotRoot: dir })
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'esc', config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/esc/snapshot',
        payload: { path: '../escape.tar' },
      })
      expect(res.statusCode).toBe(400)
      expect(existsSync(join(dir, '..', 'escape.tar'))).toBe(false)
    } finally {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces rejects a non-object config', async () => {
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: '/etc/passwd' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /v1/workspaces/load returns 400 when the snapshot path does not exist', async () => {
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { path: '/no/such/file.tar' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /v1/workspaces/load returns 409 on id conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ws-'))
    const tar = join(dir, 'taken.tar')
    const app = buildApp({ snapshotRoot: dir })
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'taken', config: { mounts: { '/': { resource: 'ram', mode: 'write' } } } },
      })
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces/taken/snapshot',
        payload: { path: tar },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { path: tar, id: 'taken' },
      })
      expect(res.statusCode).toBe(409)
    } finally {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clone preserves per-mount modes', async () => {
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          id: 'src-modes',
          config: {
            mounts: {
              '/': { resource: 'ram', mode: 'write' },
              '/ro': { resource: 'ram', mode: 'read' },
            },
          },
        },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-modes/clone',
        payload: { id: 'cloned-modes' },
      })
      expect(res.statusCode).toBe(201)
      const detail = await app.inject({ method: 'GET', url: '/v1/workspaces/cloned-modes' })
      const body = detail.json<{ mounts: { prefix: string; mode: string }[] }>()
      const ro = body.mounts.find((m) => m.prefix === '/ro/')
      expect(ro?.mode).toBe('read')
      const root = body.mounts.find((m) => m.prefix === '/')
      expect(root?.mode).toBe('write')
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})

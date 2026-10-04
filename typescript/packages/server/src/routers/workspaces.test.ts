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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '@struktoai/mirage-node'
import { buildApp } from '../app.ts'
import type * as multipart from '../multipart.ts'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'

const limits = vi.hoisted(() => ({ snapshot: undefined as number | undefined }))

vi.mock('../multipart.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof multipart>()
  return {
    ...actual,
    get MAX_SNAPSHOT_PART(): number {
      return limits.snapshot ?? actual.MAX_SNAPSHOT_PART
    },
  }
})

const LoadAccountConfig = z.strictObject({ account: z.string().default('default') })
type LoadAccountConfig = z.infer<typeof LoadAccountConfig>

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const RAM = { mounts: { '/': { vfs: 'ram', mode: 'write' } } }
const STORE = { bucket: 'snaps', region: 'us-east-1' }

type App = ReturnType<typeof buildApp>

async function download(app: App, id: string): Promise<Buffer> {
  const res = await app.inject({ method: 'GET', url: `/v1/workspaces/${id}/snapshot` })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toBe('application/x-tar')
  return res.rawPayload
}

async function upload(
  app: App,
  tar: Uint8Array,
  request: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<App['inject']>>> {
  const form = new FormData()
  form.set('request', JSON.stringify(request))
  form.set('snapshot', new Blob([new Uint8Array(tar)]), 'snap.tar')
  const body = new Request('http://localhost', { method: 'POST', body: form })
  return app.inject({
    method: 'POST',
    url: '/v1/workspaces/load',
    headers: { 'content-type': body.headers.get('content-type') ?? '' },
    payload: Buffer.from(await body.arrayBuffer()),
  })
}

function slackPayload(source: string, workspaceId: string): Record<string, unknown> {
  return {
    config: {
      workspace_id: workspaceId,
      secrets: { prod: { source } },
      mounts: {
        '/': { vfs: 'ram', mode: 'write' },
        '/slack': {
          vfs: 'slack',
          mode: 'read',
          config: { token: { from: 'prod', ref: 'bot', key: 'credential' } },
        },
      },
    },
  }
}

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
      payload: { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string }>()
    expect(body.id).toMatch(UUID7_RE)
    await app.close()
  })

  it('POST /v1/workspaces answers a held config id without building', async () => {
    registerSecrets('held-src', LoadAccountConfig, (_config: LoadAccountConfig, ref: string) =>
      Promise.resolve({ fields: { credential: `xoxb-${ref}` } }),
    )
    const app = buildApp()
    const payload = slackPayload('held-src', 'named')
    const other = {
      config: { workspace_id: 'named', mounts: { '/': { vfs: 'ram', mode: 'read' } } },
    }
    const first = await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
    registerSecrets('held-src', LoadAccountConfig, () =>
      Promise.reject(new SecretsError('source unreachable')),
    )
    const close = vi.spyOn(Workspace.prototype, 'close')
    const again = await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
    const refused = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: other })
    const closed = close.mock.calls.length
    close.mockRestore()
    expect(first.statusCode).toBe(201)
    expect(again.statusCode).toBe(200)
    expect(again.json<{ id: string }>().id).toBe('named')
    expect(refused.statusCode).toBe(409)
    expect(closed).toBe(0)
    await app.close()
  })

  it('POST /v1/workspaces builds one config once when two creates race', async () => {
    registerSecrets(
      'slow-src',
      LoadAccountConfig,
      async (_config: LoadAccountConfig, ref: string) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { fields: { credential: `xoxb-${ref}` } }
      },
    )
    const app = buildApp()
    const payload = slackPayload('slow-src', 'racing')
    const close = vi.spyOn(Workspace.prototype, 'close')
    try {
      const answers = await Promise.all([
        app.inject({ method: 'POST', url: '/v1/workspaces', payload }),
        app.inject({ method: 'POST', url: '/v1/workspaces', payload }),
      ])
      expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 201])
      expect(close).not.toHaveBeenCalled()
    } finally {
      close.mockRestore()
      await app.close()
    }
  })

  it('POST /v1/workspaces does not hold another config behind a stuck create', async () => {
    let entered = (): void => undefined
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerSecrets(
      'gated-src',
      LoadAccountConfig,
      async (_config: LoadAccountConfig, ref: string) => {
        entered()
        await gate
        return { fields: { credential: `xoxb-${ref}` } }
      },
    )
    const app = buildApp()
    const other = {
      config: { workspace_id: 'stuck', mounts: { '/': { vfs: 'ram', mode: 'read' } } },
    }
    try {
      const first = app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: slackPayload('gated-src', 'stuck'),
      })
      await reached
      const refused = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: other })
      release()
      const built = await first
      expect(refused.statusCode).toBe(409)
      expect(built.statusCode).toBe(201)
    } finally {
      release()
      await app.close()
    }
  })

  it('POST /v1/workspaces refuses an id whose deletion is in flight', async () => {
    const app = buildApp()
    const payload = {
      config: { workspace_id: 'going', mounts: { '/': { vfs: 'ram', mode: 'write' } } },
    }
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const first = await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
      const runner = app.registry.get('going').runner
      const stop = runner.stop.bind(runner)
      vi.spyOn(runner, 'stop').mockImplementationOnce(async (options) => {
        await gate
        await stop(options)
      })
      const removal = app.registry.remove('going')
      const during = await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
      release()
      await removal
      const after = await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
      expect(first.statusCode).toBe(201)
      expect(during.statusCode).toBe(409)
      expect(after.statusCode).toBe(201)
    } finally {
      await app.close()
    }
  })

  it('POST /v1/workspaces installs the config clis section', async () => {
    // The route used to enumerate Workspace options by hand and omit
    // `clis`, so a yaml clis block parsed, validated, and installed
    // nothing: the head word answered "command not found".
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-ws-'))
    const script = join(dir, 'pager.py')
    writeFileSync(script, 'print("prog", argv[0])\n')
    const app = buildApp()
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          id: 'cli-ws',
          config: {
            mounts: { '/': { vfs: 'ram', mode: 'write' } },
            runtimes: ['monty', 'workspace'],
            clis: { pager: { script } },
          },
        },
      })
      expect(create.statusCode).toBe(201)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/cli-ws/shell',
        payload: { command: 'pager' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ exit_code: number; stdout: string }>()
      expect([body.exit_code, body.stdout]).toEqual([0, 'prog pager\n'])
    } finally {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  describe.each(['initModule', 'init_module'])('request runtime %s', (key) => {
    it.each(['local', 'token'] as const)('rejects host initializers with %s auth', async (mode) => {
      const app = buildApp({ authConfig: { mode, bearerToken: 'test-token' } })
      const headers = mode === 'token' ? { authorization: 'Bearer test-token' } : {}
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers,
          payload: {
            config: {
              mounts: { '/': { vfs: 'ram', mode: 'write' } },
              runtimes: [
                'workspace',
                {
                  name: 'pyodide',
                  config: { [key]: 'data:text/javascript,export default () => {}' },
                },
              ],
            },
          },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({
          detail: 'runtime initModule is only allowed in operator-owned configuration',
        })
        const list = await app.inject({ method: 'GET', url: '/v1/workspaces', headers })
        expect(list.json()).toEqual([])
      } finally {
        await app.close()
      }
    })
  })

  it('POST /v1/workspaces accepts Pyodide config without a host initializer', async () => {
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          config: {
            mounts: { '/': { vfs: 'ram', mode: 'write' } },
            runtimes: [{ name: 'pyodide', config: { auto_load_from_imports: false } }, 'workspace'],
          },
        },
      })
      expect(res.statusCode).toBe(201)
    } finally {
      await app.close()
    }
  })

  it('GET /v1/workspaces lists active workspaces', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'fixed-id',
        config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } },
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

  it('POST /v1/workspaces returns 502 when VFS build fails', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { vfs: 'not-a-real-VFS' } } } },
    })
    expect(res.statusCode).toBe(502)
    await app.close()
  })

  it('POST /v1/workspaces 400s for a bad secrets block', async () => {
    // Resolution moved into configToWorkspaceArgs, whose catch answers
    // 502. An unresolvable source is the caller's config, and python's
    // create route refuses the same body with 400.
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        config: {
          mounts: { '/': { vfs: 'ram', mode: 'write' } },
          secrets: { prod: { source: 'nope' } },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('DELETE /v1/workspaces/:id removes', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'to-delete',
        config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } },
      },
    })
    const res = await app.inject({ method: 'DELETE', url: '/v1/workspaces/to-delete' })
    expect(res.statusCode).toBe(200)
    const detail = await app.inject({ method: 'GET', url: '/v1/workspaces/to-delete' })
    expect(detail.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE drops the workspace state, so a recreated id starts empty', async () => {
    // Deleting a workspace deletes everything it kept: one created again
    // under the same id finds no link, no history and no state on disk.
    const root = mkdtempSync(join(tmpdir(), 'mirage-delete-state-'))
    const stateRoot = join(root, 'state')
    const app = buildApp({ stateRoot })
    const create = (): Promise<unknown> =>
      app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'again', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
    const run = async (command: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/again/shell',
        payload: { command },
      })
      return res.json<{ stdout: string }>().stdout
    }
    try {
      await create()
      await run('ln -s /data /alias && echo secret-token')
      expect(existsSync(join(stateRoot, 'workspaces', 'again'))).toBe(true)
      await app.inject({ method: 'DELETE', url: '/v1/workspaces/again' })
      expect(existsSync(join(stateRoot, 'workspaces', 'again'))).toBe(false)
      await create()
      const out = await run('readlink /alias || echo no-link; cat /.bash_history')
      expect(out).toContain('no-link')
      expect(out).not.toContain('secret-token')
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a dot id before it can name the state root', async () => {
    // Deleting a workspace removes its state directory whole, and the dot
    // names would make that the root or the workspaces directory.
    const app = buildApp()
    for (const id of ['..', '.']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id, config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      expect(res.statusCode).toBe(400)
      const load = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { id, key: 'missing.tar' },
      })
      expect(load.json<{ detail: string }>().detail).toContain('invalid workspace id')
    }
    await app.close()
  })

  it('answers 500 for a failed delete and releases the id', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'mirage-delete-fail-'))
    const app = buildApp({ stateRoot })
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'doomed', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      const ws = app.registry.get('doomed').runner.ws
      vi.spyOn(ws.stateStore, 'drop').mockRejectedValue(new Error('store on fire'))
      const res = await app.inject({ method: 'DELETE', url: '/v1/workspaces/doomed' })
      expect(res.statusCode).toBe(500)
      expect(res.json<{ detail: string }>().detail).toContain('store on fire')
      expect(app.registry.has('doomed')).toBe(false)
    } finally {
      await app.close()
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces/:id/clone produces a new id', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'src-w', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
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

  it('POST /v1/workspaces/:id/clone 400s for a bad secrets override', async () => {
    // The clone route was the last one answering 500 where create,
    // load and the historical clone all answer 400.
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'src-s', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
    })
    for (const bad of [{ prod: { source: 'nope' } }, { prod: { nosource: 1 } }, []]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-s/clone',
        payload: { override: { secrets: bad } },
      })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('POST /v1/workspaces/:id/clone 400s for a bad mount override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-clone-disk-'))
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'src-m', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-m/clone',
        payload: {
          override: {
            mounts: { '/': { vfs: 'disk', config: { root, folder_versions: 'no' } } },
          },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ detail: string }>().detail).toBe('disk: folder_versions: must be a boolean')
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces/:id/clone 400s for an unknown mount config key', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'src-k', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/src-k/clone',
      payload: { override: { mounts: { '/': { vfs: 'ram', config: { bogus: 1 } } } } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ detail: string }>().detail).toContain('bogus')
    await app.close()
  })

  it('POST /v1/workspaces 400s for a bad mount config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-create-disk-'))
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          config: {
            mounts: { '/': { vfs: 'disk', config: { root, folder_versions: 'no' } } },
          },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ detail: string }>().detail).toBe('disk: folder_versions: must be a boolean')
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
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

  it('GET /v1/workspaces/:id/snapshot answers the tar, writes nothing, and loads back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-home-'))
    vi.stubEnv('MIRAGE_HOME', home)
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'seed', config: RAM },
      })
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces/seed/shell',
        payload: { command: 'echo hi > /f' },
      })
      const tar = await download(app, 'seed')
      expect(tar.subarray(257, 262).toString()).toBe('ustar')
      expect(existsSync(join(home, 'snapshots'))).toBe(false)
      const res = await upload(app, tar, { id: 'loaded' })
      expect(res.statusCode).toBe(201)
      const cat = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/loaded/shell',
        payload: { command: 'cat /f' },
      })
      expect(cat.json<{ stdout: string }>().stdout).toBe('hi\n')
    } finally {
      await app.close().catch(() => undefined)
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a key goes to the snapshot store the server was given', async () => {
    const app = buildApp({ snapshotStore: STORE })
    try {
      await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { id: 'w', config: RAM } })
      const ws = app.registry.get('w').runner.ws
      const save = vi.spyOn(ws, 'snapshot').mockResolvedValue(42)
      const snap = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/w/snapshot',
        payload: { key: 'a.tar' },
      })
      expect(snap.json()).toEqual({ id: 'w', key: 'a.tar', size: 42 })
      expect(save).toHaveBeenCalledWith('a.tar', { s3: STORE })
      const load = vi.spyOn(Workspace, 'load').mockResolvedValueOnce(ws)
      await app.inject({ method: 'DELETE', url: '/v1/workspaces/w' })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { key: 'a.tar', id: 'back' },
      })
      expect(res.statusCode).toBe(201)
      expect(load.mock.calls[0]?.[0]).toBe('a.tar')
      expect(load.mock.calls[0]?.[1]).toEqual({ s3: STORE })
      load.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      const missing = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { key: 'nope.tar' },
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json<{ detail: string }>().detail).toBe('snapshot not found: nope.tar')
    } finally {
      vi.restoreAllMocks()
      await app.close().catch(() => undefined)
    }
  })

  it('a key needs a snapshot store', async () => {
    const app = buildApp()
    try {
      await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { id: 'w', config: RAM } })
      for (const res of [
        await app.inject({
          method: 'POST',
          url: '/v1/workspaces/w/snapshot',
          payload: { key: 'a.tar' },
        }),
        await app.inject({ method: 'POST', url: '/v1/workspaces/load', payload: { key: 'a.tar' } }),
      ]) {
        expect(res.statusCode).toBe(400)
        expect(res.json<{ detail: string }>().detail).toBe('this server has no snapshot store')
      }
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /v1/workspaces/load takes exactly one source', async () => {
    const app = buildApp()
    try {
      const none = await app.inject({ method: 'POST', url: '/v1/workspaces/load', payload: {} })
      expect(none.statusCode).toBe(400)
      const both = await upload(app, new Uint8Array(), { key: 'a.tar' })
      expect(both.statusCode).toBe(400)
      expect(both.json<{ detail: string }>().detail).toContain('not both')
      const junk = await upload(app, new TextEncoder().encode('not a tar'))
      expect(junk.statusCode).toBe(400)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /v1/workspaces/load refuses a snapshot over the limit', async () => {
    const app = buildApp()
    limits.snapshot = 8
    try {
      const res = await upload(app, new Uint8Array(9))
      expect(res.statusCode).toBe(413)
      expect(res.json<{ detail: string }>().detail).toBe('snapshot part too large')
    } finally {
      limits.snapshot = undefined
      await app.close().catch(() => undefined)
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

  it('POST /v1/workspaces/load reads a pointer in an override mount config', async () => {
    // The load route built override mounts without the resolved
    // declarations, so an alias reached `sourceFor` as a provider name.
    registerSecrets('acct-load', LoadAccountConfig, (config: LoadAccountConfig, ref: string) =>
      Promise.resolve({ fields: { credential: `${config.account}:${ref}` } }),
    )
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          id: 'ptr-src',
          config: {
            mounts: {
              '/': { vfs: 'ram', mode: 'write' },
              '/slack': { vfs: 'slack', mode: 'read', config: { token: 'xoxb-src' } },
            },
          },
        },
      })
      const res = await upload(app, await download(app, 'ptr-src'), {
        id: 'ptr-loaded',
        override: {
          secrets: { prod: { source: 'acct-load', config: { account: 'live' } } },
          mounts: {
            '/slack': {
              vfs: 'slack',
              config: { token: { from: 'prod', ref: 'bot', key: 'credential' } },
            },
          },
        },
      })
      expect(res.statusCode).toBe(201)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /v1/workspaces/load returns 409 on id conflict', async () => {
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'taken', config: RAM },
      })
      const res = await upload(app, await download(app, 'taken'), { id: 'taken' })
      expect(res.statusCode).toBe(409)
    } finally {
      await app.close().catch(() => undefined)
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
              '/': { vfs: 'ram', mode: 'write' },
              '/ro': { vfs: 'ram', mode: 'read' },
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

describe('daemon disk-store default', () => {
  it('persists a store-less workspace under the state root', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'mir-stateroot-'))
    const app = buildApp({ stateRoot })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'diskws',
        config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } },
      },
    })
    expect(res.statusCode).toBe(201)
    const exec = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/diskws/shell',
      payload: { command: 'echo hi' },
    })
    expect(exec.statusCode).toBe(200)
    expect(existsSync(join(stateRoot, 'workspaces', 'diskws', 'workspace.json'))).toBe(true)
    await app.close()
    rmSync(stateRoot, { recursive: true, force: true })
  })
})

describe('workspace cancel, kill and close', () => {
  const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }

  it('cancel and kill reach every session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-cancel-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const wid = (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: RAM })).json<{
        id: string
      }>().id
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${wid}/sessions`,
        payload: { session_id: 'a' },
      })
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${wid}/shell`,
        payload: { command: 'sleep 30 &', session_id: 'a' },
      })
      const jobId = (
        await app.inject({
          method: 'POST',
          url: `/v1/workspaces/${wid}/shell?background=true`,
          payload: { command: 'sleep 30' },
        })
      ).json<{ job_id: string }>().job_id
      for (let i = 0; i < 500; i += 1) {
        const job = (await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` })).json<{
          status: string
        }>()
        if (job.status === 'running') break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(
        (await app.inject({ method: 'POST', url: `/v1/workspaces/${wid}/cancel` })).json(),
      ).toEqual({
        canceled: 1,
      })
      expect(
        (await app.inject({ method: 'POST', url: `/v1/workspaces/${wid}/kill` })).json(),
      ).toEqual({
        killed: 1,
      })
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('close keeps state for the same id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-close-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const body = { ...RAM, id: 'keep' }
      expect(
        (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: body })).statusCode,
      ).toBe(201)
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces/keep/shell',
        payload: { command: 'echo kept' },
      })
      expect(
        (await app.inject({ method: 'POST', url: '/v1/workspaces/keep/close' })).statusCode,
      ).toBe(200)
      expect((await app.inject({ method: 'GET', url: '/v1/workspaces/keep' })).statusCode).toBe(404)
      expect(
        (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: body })).statusCode,
      ).toBe(201)
      const r = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/keep/shell',
        payload: { command: 'history' },
      })
      expect(r.json<{ stdout: string }>().stdout).toContain('echo kept')
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

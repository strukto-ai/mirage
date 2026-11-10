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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DiskWorkspaceStateStore, Workspace } from '@struktoai/mirage-node'
import { readSnapshotTar, writeSnapshotTar } from '@struktoai/mirage-core/workspace/snapshot/tar_io'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode, type JsonValue } from '@struktoai/mirage-core/types'
import { buildApp } from '../app.ts'
import * as metrics from '../metrics.ts'
import type * as multipart from '../multipart.ts'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { MAX_SNAPSHOT_BYTES } from '../constants.ts'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type { CommandContext, Deny, WorkspaceContext } from '@struktoai/mirage-core/policy/types'

const limits = vi.hoisted(() => ({
  snapshot: undefined as number | undefined,
  expanded: undefined as number | undefined,
}))

vi.mock('../constants.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get MAX_SNAPSHOT_BYTES(): number {
      return limits.expanded ?? (actual.MAX_SNAPSHOT_BYTES as number)
    },
  }
})

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

  it('pages and exports completed command logs', async () => {
    const app = buildApp()
    try {
      await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { id: 'h', config: RAM } })
      const read = async (query = '') =>
        app.inject({ method: 'GET', url: `/v1/workspaces/h/logs${query}` })
      expect((await read()).json()).toEqual({ items: [], next: null })
      expect((await read('?format=jsonl')).body).toBe('')
      for (const command of ['echo hi > /a.txt', 'cat /a.txt']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/workspaces/h/shell',
              payload: { command },
            })
          ).statusCode,
        ).toBe(200)
      }
      interface Item {
        id: string
        command: string
        started_at: number
        exit_code: number
        mounts: { op: string }[]
        user_id: null
        api_key_id: null
      }
      interface Page {
        items: Item[]
        next: string | null
      }
      const all = (await read()).json<Page>()
      expect(all.items).toHaveLength(2)
      expect(all.next).toBeNull()
      for (const item of all.items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'id',
            'command',
            'cwd',
            'started_at',
            'duration_ms',
            'exit_code',
            'stdout',
            'stderr',
            'user_id',
            'api_key_id',
            'mounts',
          ].sort(),
        )
        expect(item.started_at).toBeLessThan(10_000_000_000_000)
        expect(item.started_at).toBeGreaterThan(1_000_000_000_000)
        expect(item.mounts).toHaveLength(1)
        expect(item.exit_code).toBe(0)
        expect(item.user_id).toBeNull()
      }
      const first = (await read('?limit=1')).json<Page>()
      const second = (
        await read(`?limit=1&after=${encodeURIComponent(first.next ?? '')}`)
      ).json<Page>()
      expect([...first.items, ...second.items]).toEqual(all.items)
      expect(second.next).toBeNull()
      const exported = await read('?format=jsonl&limit=bad&after=bad')
      expect(exported.statusCode).toBe(200)
      expect(exported.headers['content-type']).toContain('application/x-ndjson')
      expect(exported.body.endsWith('\n')).toBe(true)
      const lines = exported.body
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { type: string; id?: string; timestamp: number; session: string },
        )
      const commands = lines.filter((line) => line.type === 'command')
      expect(commands.map((line) => line.id)).toEqual(
        [...all.items].reverse().map((item) => item.id),
      )
      expect(commands[0]?.timestamp ?? 0).toBe(all.items.at(-1)?.started_at)
      expect((await read(`?session=${commands[0]?.session ?? ''}`)).json()).toEqual(all)
      expect((await read('?session=missing')).json()).toEqual({ items: [], next: null })
      for (const query of ['?limit=0', '?limit=201', '?session=bad%0Asession', '?after=bad'])
        expect((await read(query)).statusCode).toBe(400)
      expect(
        (await app.inject({ method: 'GET', url: '/v1/workspaces/h/history' })).statusCode,
      ).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('exports Unicode workspace names and every valid session ID', async () => {
    const app = buildApp()
    const id = '工作'
    const base = `/v1/workspaces/${encodeURIComponent(id)}`
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { id, config: RAM } }))
          .statusCode,
      ).toBe(201)
      const empty = await app.inject({ method: 'GET', url: `${base}/logs?format=jsonl` })
      expect(empty.statusCode).toBe(200)
      expect(empty.body).toBe('')
      expect(empty.headers['content-disposition']).toContain(
        "filename*=UTF-8''%E5%B7%A5%E4%BD%9C-logs.jsonl",
      )
      for (const session_id of ['user:42', 's'.repeat(65), '会话']) {
        expect(
          (await app.inject({ method: 'POST', url: `${base}/sessions`, payload: { session_id } }))
            .statusCode,
        ).toBe(201)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/shell?session_id=${encodeURIComponent(session_id)}`,
              payload: { command: 'echo hi' },
            })
          ).statusCode,
        ).toBe(200)
        const page = await app.inject({
          method: 'GET',
          url: `${base}/logs?session=${encodeURIComponent(session_id)}`,
        })
        expect(page.statusCode).toBe(200)
        expect(page.json<{ items: unknown[] }>().items).toHaveLength(1)
        const exported = await app.inject({
          method: 'GET',
          url: `${base}/logs?format=jsonl&session=${encodeURIComponent(session_id)}`,
        })
        expect(exported.statusCode).toBe(200)
        expect(
          exported.body
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as { session: string }).session),
        ).toEqual([session_id, session_id])
      }
    } finally {
      await app.close()
    }
  })

  it('refuses a load past max_sessions', async () => {
    const reasons: string[] = []
    const counted = vi.spyOn(metrics, 'refused').mockImplementation((reason) => {
      reasons.push(reason)
    })
    const free = buildApp()
    const capped = buildApp({ maxSessions: 2 })
    try {
      const created = await free.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'many', config: RAM },
      })
      expect(created.statusCode).toBe(201)
      for (const sid of ['a', 'b']) {
        const r = await free.inject({
          method: 'POST',
          url: '/v1/workspaces/many/sessions',
          payload: { session_id: sid },
        })
        expect(r.statusCode).toBe(201)
      }
      const r = await upload(capped, await download(free, 'many'))
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'the snapshot holds 3 sessions, past max_sessions (2)',
        },
      })
      expect(reasons).toEqual(['max_sessions'])
      expect(capped.registry.size()).toBe(0)
    } finally {
      counted.mockRestore()
      await free.close()
      await capped.close()
    }
  })

  it('refuses a reopen past max_sessions', async () => {
    const reasons: string[] = []
    const counted = vi.spyOn(metrics, 'refused').mockImplementation((reason) => {
      reasons.push(reason)
    })
    const stateRoot = mkdtempSync(join(tmpdir(), 'mir-reopen-'))
    const free = buildApp({ stateRoot })
    const capped = buildApp({ stateRoot, maxSessions: 2 })
    try {
      const body = { id: 'keep', config: RAM }
      const created = await free.inject({ method: 'POST', url: '/v1/workspaces', payload: body })
      expect(created.statusCode).toBe(201)
      for (const sid of ['a', 'b']) {
        const r = await free.inject({
          method: 'POST',
          url: '/v1/workspaces/keep/sessions',
          payload: { session_id: sid },
        })
        expect(r.statusCode).toBe(201)
      }
      const stopped = await free.inject({ method: 'POST', url: '/v1/workspaces/keep/stop' })
      expect(stopped.statusCode).toBe(200)
      const r = await capped.inject({ method: 'POST', url: '/v1/workspaces', payload: body })
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'the saved workspace holds 3 sessions, past max_sessions (2)',
        },
      })
      expect(reasons).toEqual(['max_sessions'])
      expect(capped.registry.size()).toBe(0)
    } finally {
      counted.mockRestore()
      await free.close()
      await capped.close()
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('answers 503 while shutting down', async () => {
    const app = buildApp()
    app.registry.draining = true
    const r = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { config: RAM } })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toEqual({
      error: { code: 'shutting_down', message: 'server is shutting down' },
    })
    await app.close()
  })

  it('answers 503 past max_workspaces', async () => {
    const app = buildApp({ maxWorkspaces: 2 })
    const create = (id?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: RAM, ...(id === undefined ? {} : { id }) },
      })
    try {
      expect((await create('a')).statusCode).toBe(201)
      expect((await create('b')).statusCode).toBe(201)
      const full = await create()
      expect(full.statusCode).toBe(503)
      expect(full.json()).toEqual({
        error: { code: 'server_full', message: 'server is at max_workspaces (2)' },
      })
      const clone = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/a/clone',
        payload: {},
      })
      expect(clone.statusCode).toBe(503)
      expect((await create('a')).statusCode).toBe(200)
      expect((await app.inject({ method: 'DELETE', url: '/v1/workspaces/a' })).statusCode).toBe(200)
      expect((await create()).statusCode).toBe(201)
    } finally {
      await app.close()
    }
  })

  class NoDisk implements Policy {
    preWorkspace(ctx: WorkspaceContext): Deny | null {
      const mounts = (ctx.config.mounts ?? {}) as Record<string, { vfs?: string }>
      if (Object.values(mounts).some((block) => block.vfs === 'disk')) {
        return { kind: 'deny', reason: `no disk mounts for ${String(ctx.caller?.account)}` }
      }
      return null
    }

    preCommand(ctx: CommandContext): Deny | null {
      return ctx.command === 'rm' ? { kind: 'deny', reason: 'no rm here' } : null
    }
  }

  const DISK = (root: string) => ({
    mounts: { '/': { vfs: 'ram', mode: 'WRITE' }, '/host': { vfs: 'disk', config: { root } } },
  })

  it('refuses a workspace its policies refuse before it is built', async () => {
    const app = buildApp({ policies: [new NoDisk()] })
    const root = mkdtempSync(join(tmpdir(), 'mirage-nodisk-'))
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload })
    try {
      const refused = await post('/v1/workspaces', { config: DISK(root) })
      expect([refused.statusCode, refused.json()]).toEqual([
        403,
        { error: { code: 'policy_refused', message: 'no disk mounts for null' } },
      ])
      const said = await post('/v1/workspaces?explain=true', { config: DISK(root) })
      expect(said.statusCode).toBe(200)
      expect(said.json()).toMatchObject({
        outcome: 'deny',
        reason: 'no disk mounts for null',
        answers: [{ kind: 'deny', reason: 'no disk mounts for null', policy: 'NoDisk' }],
      })
      const allowed = await post('/v1/workspaces?explain=true', { config: RAM })
      expect(allowed.json()).toMatchObject({ outcome: 'allow', answers: [] })
      const made = await post('/v1/workspaces', { config: RAM })
      expect(made.statusCode).toBe(201)
      const id = made.json<{ id: string }>().id
      const ran = await post(`/v1/workspaces/${id}/shell`, { command: 'touch /a; rm /a' })
      expect(ran.json<{ exit_code: number }>().exit_code).toBe(126)
      const override = { mounts: { '/host': { vfs: 'disk', config: { root: '/' } } } }
      expect((await post(`/v1/workspaces/${id}/clone`, { override })).statusCode).toBe(403)
      expect((await post('/v1/workspaces/load', { key: 'snap.tar', override })).statusCode).toBe(
        403,
      )
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs a policy file the way it runs its policies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-policy-file-'))
    writeFileSync(
      join(dir, 'no_runtimes.py'),
      [
        'def pre_workspace(ctx):',
        '    if "runtimes" in ctx["config"]:',
        '        return {"kind": "deny", "reason": "runtimes are the server\'s"}',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'no_cat.py'),
      [
        'def pre_command(ctx):',
        '    if ctx["command"] == "cat":',
        '        return {"kind": "deny", "reason": "no cat"}',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'policy.yaml'),
      'pre_workspace:\n  - script: no_runtimes.py\npre_command:\n  - script: no_cat.py\n',
    )
    const app = buildApp({ policyFile: join(dir, 'policy.yaml') })
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload })
    try {
      const refused = await post('/v1/workspaces', { config: { ...RAM, runtimes: ['monty'] } })
      expect([refused.statusCode, refused.json()]).toEqual([
        403,
        { error: { code: 'policy_refused', message: "runtimes are the server's" } },
      ])
      const made = await post('/v1/workspaces', { config: RAM })
      expect(made.statusCode).toBe(201)
      const id = made.json<{ id: string }>().id
      const ran = await post(`/v1/workspaces/${id}/shell`, { command: 'echo hi > /a; cat /a' })
      expect(ran.json<{ exit_code: number }>().exit_code).toBe(126)
      expect((await app.inject({ method: 'DELETE', url: `/v1/workspaces/${id}` })).statusCode).toBe(
        200,
      )
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a policy file naming no method', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-policy-file-'))
    try {
      writeFileSync(join(dir, 'policy.yaml'), 'pre_build: []\n')
      expect(() => buildApp({ policyFile: join(dir, 'policy.yaml') })).toThrow(/names pre_build/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('holds a workspace to its posted network', async () => {
    const server = createServer((_req, res) => res.end('ok\n'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    const app = buildApp()
    const curl = async (network: boolean): Promise<number> => {
      const made = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { ...RAM, network } },
      })
      const id = made.json<{ id: string }>().id
      const ran = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/shell`,
        payload: { command: `curl -sS http://127.0.0.1:${String(port)}/` },
      })
      return ran.json<{ exit_code: number }>().exit_code
    }
    try {
      expect(await curl(true)).toBe(0)
      expect(await curl(false)).toBe(7)
    } finally {
      await app.close()
      server.close()
    }
  })

  it("keeps a posted config's ${VAR} as written, reading none of the server's env", async () => {
    const app = buildApp()
    try {
      const made = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { ...RAM, env: { GREETING: '${HOME}' } } },
      })
      expect(made.statusCode).toBe(201)
      const id = made.json<{ id: string }>().id
      const ran = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/shell`,
        payload: { command: 'echo "$GREETING"' },
      })
      expect(ran.json<{ stdout: string }>().stdout).toBe('${HOME}\n')
    } finally {
      await app.close()
    }
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

  it('GET /v1/workspaces/:id answers 404 while the workspace is deleted', async () => {
    const app = buildApp()
    const payload = {
      config: { workspace_id: 'going', mounts: { '/': { vfs: 'ram', mode: 'write' } } },
    }
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await app.inject({ method: 'POST', url: '/v1/workspaces', payload })
      const runner = app.registry.get('going').runner
      const stop = runner.stop.bind(runner)
      vi.spyOn(runner, 'stop').mockImplementationOnce(async (options) => {
        await stop(options)
        await gate
      })
      const removal = app.registry.remove('going')
      const during = await app.inject({ method: 'GET', url: '/v1/workspaces/going' })
      release()
      await removal
      expect(during.statusCode).toBe(404)
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
      const stateRoot = mkdtempSync(join(tmpdir(), 'mir-init-'))
      const app = buildApp({ stateRoot, authConfig: { mode, bearerToken: 'test-token' } })
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
          error: {
            code: 'invalid_request',
            message: 'runtime initModule is only allowed in operator-owned configuration',
          },
        })
        const list = await app.inject({ method: 'GET', url: '/v1/workspaces', headers })
        expect(list.json()).toEqual([])
      } finally {
        await app.close()
        rmSync(stateRoot, { recursive: true, force: true })
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

  it.each([
    { mounts: false, extra: false, invalidTime: undefined },
    { mounts: true, extra: true, invalidTime: undefined },
    { mounts: false, extra: true, invalidTime: undefined },
    { mounts: true, extra: false, invalidTime: 123 },
    { mounts: false, extra: true, invalidTime: 123 },
    { mounts: true, extra: false, invalidTime: 'tomorrow' },
    { mounts: false, extra: true, invalidTime: 'tomorrow' },
  ])(
    'POST /v1/workspaces validates config $mounts/$extra/$invalidTime',
    async ({ mounts, extra, invalidTime }) => {
      const app = buildApp()
      const config = {
        ...(mounts ? { mounts: {} } : {}),
        ...(invalidTime !== undefined ? { system_time: invalidTime } : {}),
        ...(extra ? { unknown_setting: true } : {}),
      }
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          payload: { id: 'bad', config },
        })
        const error = !mounts
          ? { code: 'missing_field', message: 'config.mounts is required', param: 'config.mounts' }
          : typeof invalidTime === 'number'
            ? {
                code: 'invalid_value',
                message: 'config.system_time must be a string',
                param: 'config.system_time',
              }
            : invalidTime !== undefined
              ? {
                  code: 'invalid_value',
                  message:
                    'system_time is not an ISO 8601 instant with an offset from 1970 through 2261, as 2026-03-02T09:00:00Z',
                  param: 'config.system_time',
                }
              : {
                  code: 'unknown_field',
                  message: 'config.unknown_setting is not a known field',
                  param: 'config.unknown_setting',
                }
        expect([res.statusCode, res.json()]).toEqual([400, { error }])
        expect(app.registry.has('bad')).toBe(false)
      } finally {
        await app.close()
      }
    },
  )

  it('POST /v1/workspaces 400s with the loader text when the VFS is unknown', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { vfs: 'not-a-real-VFS' } } } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_request')
    await app.close()
  })

  it('POST /v1/workspaces 400s for a bad secrets block', async () => {
    // An unresolvable source is the caller's config, and python's create
    // route refuses the same body with 400.
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
      expect([load.statusCode, load.json()]).toEqual([
        400,
        { error: { code: 'invalid_value', message: 'id must not be . or ..', param: 'id' } },
      ])
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
      expect(res.json()).toEqual({
        error: { code: 'internal', message: 'internal server error' },
      })
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
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        'disk: folder_versions: must be a boolean',
      )
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces/:id/clone 400s for two overrides on one disk root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-clone-disk-'))
    const app = buildApp()
    try {
      const src = new Workspace(
        { '/a': new RAMVFS(), '/b': new RAMVFS() },
        { mode: MountMode.WRITE },
      )
      let tar: Uint8Array
      try {
        tar = await src.snapshot()
      } finally {
        await src.close()
      }
      expect((await upload(app, tar, { id: 'src-disk' })).statusCode).toBe(201)
      const block = { vfs: 'disk', config: { root } }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-disk/clone',
        payload: { override: { mounts: { '/a': block, '/b': block } } },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        'is already mounted at',
      )
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('POST /v1/workspaces/:id/clone 400s for a bad capacity override', async () => {
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'src-c', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-c/clone',
        payload: {
          override: { mounts: { '/': { vfs: 'ram', config: { capacity: '1.5MB' } } } },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        'capacity must be a size like 100MB',
      )
    } finally {
      await app.close()
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
    expect(res.json<{ error: { message: string } }>().error.message).toContain('bogus')
    await app.close()
  })

  it.each([
    ['conditional', 400],
    ['bogus', 400],
    [true, 400],
    [null, 201],
  ] as const)(
    'POST /v1/workspaces/:id/clone judges an override write %j',
    async (write, status) => {
      // A refused write policy is the caller's mistake; null leaves the saved one.
      const app = buildApp()
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'src-w', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/src-w/clone',
        payload: { override: { mounts: { '/': { vfs: 'ram', write } } } },
      })
      expect(res.statusCode, res.body).toBe(status)
      await app.close()
    },
  )

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
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        'disk: folder_versions: must be a boolean',
      )
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
      expect(load.mock.calls[0]?.[1]).toEqual({
        s3: STORE,
        maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
        maxSnapshotEncodedBytes: 1024 * 1024 * 1024,
        policies: [],
        ceilings: app.registry.ceilings,
      })
      load.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      const missing = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/load',
        payload: { key: 'nope.tar' },
      })
      expect([missing.statusCode, missing.json()]).toEqual([
        400,
        { error: { code: 'invalid_value', message: 'key names no snapshot', param: 'key' } },
      ])
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
        expect(res.json<{ error: { message: string } }>().error.message).toBe(
          'this server has no snapshot store',
        )
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
      expect(both.json<{ error: { message: string } }>().error.message).toContain('not both')
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
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        'snapshot part too large',
      )
    } finally {
      limits.snapshot = undefined
      await app.close().catch(() => undefined)
    }
  })

  it('caps expanded snapshot bytes and releases the rejected workspace id', async () => {
    const app = buildApp()
    limits.expanded = 32_768
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'source', config: RAM },
      })
      expect(created.statusCode).toBe(201)
      const original = await download(app, 'source')
      const manifest = (await readSnapshotTar(original)) as Record<string, unknown>
      const oversized = await writeSnapshotTar({ ...manifest, padding: 'x'.repeat(128_000) }, {})
      const res = await upload(app, oversized, { id: 'limited' })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        'snapshot exceeds expanded size limit',
      )
      expect(app.registry.has('limited')).toBe(false)
      expect((await upload(app, original, { id: 'limited' })).statusCode).toBe(201)
    } finally {
      limits.expanded = undefined
      await app.close()
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
      expect([res.statusCode, res.json()]).toEqual([
        400,
        { error: { code: 'invalid_value', message: 'config must be an object', param: 'config' } },
      ])
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

describe('workspace cancel, kill, stop and start', () => {
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
        url: `/v1/workspaces/${wid}/shell?session_id=a`,
        payload: { command: 'sleep 30 &' },
      })
      void app.inject({
        method: 'POST',
        url: `/v1/workspaces/${wid}/shell`,
        payload: { command: 'sleep 30' },
      })
      for (let i = 0; i < 500; i += 1) {
        const running = app.jobs
          .requests()
          .some(
            (request) =>
              request.line.record.command === 'sleep 30' && request.line.record.state === 'running',
          )
        if (running) break
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

  const post = (app: App, url: string, payload: Record<string, JsonValue> = {}) =>
    app.inject({ method: 'POST', url, payload })

  it('starts a stopped workspace with its files and cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-start-'))
    const data = join(root, 'data')
    mkdirSync(data)
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const body = {
        id: 'keep',
        config: { mounts: { '/': { vfs: 'disk', mode: 'write', config: { root: data } } } },
      }
      expect((await post(app, '/v1/workspaces', body)).statusCode).toBe(201)
      expect(
        (await post(app, '/v1/workspaces/keep/sessions', { session_id: 's' })).statusCode,
      ).toBe(201)
      const made = await post(app, '/v1/workspaces/keep/shell?session_id=s', {
        command: 'mkdir /d && echo kept > /d/f.txt && cd /d',
      })
      expect(made.json<{ exit_code: number }>().exit_code).toBe(0)
      expect((await post(app, '/v1/workspaces/keep/stop')).statusCode).toBe(200)
      const off = await app.inject({ method: 'GET', url: '/v1/workspaces/keep' })
      expect(off.json<{ status: string }>().status).toBe('stopped')
      const started = await post(app, '/v1/workspaces/keep/start')
      expect(started.statusCode).toBe(200)
      expect(started.json<{ id: string; status: string }>()).toMatchObject({
        id: 'keep',
        status: 'running',
      })
      const r = await post(app, '/v1/workspaces/keep/shell?session_id=s', {
        command: 'pwd && cat f.txt',
      })
      expect(r.json<{ stdout: string }>().stdout).toBe('/d\nkept\n')
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers a second stop as the first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-stop-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      expect((await post(app, '/v1/workspaces', { ...RAM, id: 'keep' })).statusCode).toBe(201)
      for (let i = 0; i < 2; i++) {
        const r = await post(app, '/v1/workspaces/keep/stop')
        expect(r.statusCode).toBe(200)
        expect(r.json<{ id: string }>().id).toBe('keep')
      }
      const listed = await app.inject({ method: 'GET', url: '/v1/workspaces' })
      expect(listed.json()).toMatchObject([{ id: 'keep', status: 'stopped' }])
      // State kept with no config, as a workspace created before configs
      // were saved: it stops again, and cannot be started.
      rmSync(join(root, 'state', 'configs', 'keep.json'))
      expect((await post(app, '/v1/workspaces/keep/stop')).statusCode).toBe(200)
      expect((await post(app, '/v1/workspaces/keep/start')).statusCode).toBe(404)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers a second start with the running workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-start-twice-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      expect((await post(app, '/v1/workspaces', { ...RAM, id: 'keep' })).statusCode).toBe(201)
      await post(app, '/v1/workspaces/keep/stop')
      const first = await post(app, '/v1/workspaces/keep/start')
      const second = await post(app, '/v1/workspaces/keep/start')
      expect([first.statusCode, second.statusCode]).toEqual([200, 200])
      const createdAt = (r: typeof first) => r.json<{ created_at: number }>().created_at
      expect(createdAt(second)).toBe(createdAt(first))
      expect(app.registry.size()).toBe(1)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops the saved config when a clone takes a stopped id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-start-clone-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      for (const id of ['w', 'src']) {
        expect((await post(app, '/v1/workspaces', { ...RAM, id })).statusCode).toBe(201)
      }
      await post(app, '/v1/workspaces/w/stop')
      expect((await post(app, '/v1/workspaces/src/clone', { id: 'w' })).statusCode).toBe(201)
      await post(app, '/v1/workspaces/w/stop')
      expect((await post(app, '/v1/workspaces/w/start')).statusCode).toBe(404)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists, shows and deletes a stopped workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-stopped-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      for (const id of ['off', 'on']) {
        expect((await post(app, '/v1/workspaces', { ...RAM, id })).statusCode).toBe(201)
      }
      await post(app, '/v1/workspaces/off/stop')
      const listed = (await app.inject({ method: 'GET', url: '/v1/workspaces' })).json<
        { id: string; status: string; created_at: number }[]
      >()
      expect(listed.map((w) => [w.id, w.status])).toEqual([
        ['on', 'running'],
        ['off', 'stopped'],
      ])
      expect(listed[1]?.created_at).toBeGreaterThan(0)
      const got = await app.inject({ method: 'GET', url: '/v1/workspaces/off' })
      expect(got.json()).toMatchObject({
        id: 'off',
        status: 'stopped',
        mounts: [{ prefix: '/', vfs: 'ram', mode: 'write', description: '' }],
        sessions: [],
        internals: null,
      })
      const deleted = await app.inject({ method: 'DELETE', url: '/v1/workspaces/off' })
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json<{ id: string }>().id).toBe('off')
      expect((await app.inject({ method: 'GET', url: '/v1/workspaces/off' })).statusCode).toBe(404)
      expect((await post(app, '/v1/workspaces/off/start')).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/v1/workspaces' })).json()).toMatchObject([
        { id: 'on', status: 'running' },
      ])
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes a stopped workspace from the store its config names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-own-store-'))
    const own = join(root, 'own')
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const body = {
        id: 'mine',
        config: { mounts: { '/': { vfs: 'ram' } }, store: { type: 'disk', root: own } },
      }
      expect((await post(app, '/v1/workspaces', body)).statusCode).toBe(201)
      await post(app, '/v1/workspaces/mine/stop')
      const got = await app.inject({ method: 'GET', url: '/v1/workspaces/mine' })
      expect(got.json()).toMatchObject({ status: 'stopped' })
      expect(got.json<{ created_at: number }>().created_at).toBeGreaterThan(0)
      expect(existsSync(join(own, 'workspaces', 'mine'))).toBe(true)
      const deleted = await app.inject({ method: 'DELETE', url: '/v1/workspaces/mine' })
      expect(deleted.statusCode).toBe(200)
      expect(existsSync(join(own, 'workspaces', 'mine'))).toBe(false)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers 404 for an id with state but no saved config, as a rejected create leaves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-orphan-'))
    const stateRoot = join(root, 'state')
    const app = buildApp({ stateRoot })
    try {
      const store = new DiskWorkspaceStateStore({ root: stateRoot })
      await store.replaceMeta('orphan', {})
      await store.close()
      expect((await app.inject({ method: 'GET', url: '/v1/workspaces/orphan' })).statusCode).toBe(
        404,
      )
      expect((await app.inject({ method: 'GET', url: '/v1/workspaces' })).json()).toEqual([])
      expect(
        (await app.inject({ method: 'DELETE', url: '/v1/workspaces/orphan' })).statusCode,
      ).toBe(404)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists a stopped workspace whose store cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-lost-store-'))
    const own = join(root, 'own')
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const body = {
        id: 'mine',
        config: { mounts: { '/': { vfs: 'ram' } }, store: { type: 'disk', root: own } },
      }
      expect((await post(app, '/v1/workspaces', body)).statusCode).toBe(201)
      const ram = { mounts: { '/': { vfs: 'ram' } } }
      expect((await post(app, '/v1/workspaces', { id: 'on', config: ram })).statusCode).toBe(201)
      await post(app, '/v1/workspaces/mine/stop')
      rmSync(own, { recursive: true, force: true })
      writeFileSync(own, 'not a directory')
      const listed = await app.inject({ method: 'GET', url: '/v1/workspaces' })
      expect(listed.statusCode).toBe(200)
      expect(listed.json()).toEqual([
        expect.objectContaining({ id: 'on', status: 'running' }),
        expect.objectContaining({ id: 'mine', status: 'stopped', created_at: 0 }),
      ])
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows a stopped workspace with the mounts it ran with', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-same-view-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const config = {
        mode: 'rw',
        mounts: { '/': { vfs: 'ram', mode: 'r' }, '/data': { vfs: 'ram' } },
      }
      expect((await post(app, '/v1/workspaces', { id: 'w', config })).statusCode).toBe(201)
      const view = async () => {
        const d = (await app.inject({ method: 'GET', url: '/v1/workspaces/w' })).json<{
          mounts: { prefix: string; vfs: string; mode: string }[]
        }>()
        return d.mounts.map(({ prefix, vfs, mode }) => ({ prefix, vfs, mode }))
      }
      const running = await view()
      expect(running).toEqual([
        { prefix: '/data/', vfs: 'ram', mode: 'write' },
        { prefix: '/', vfs: 'ram', mode: 'read' },
      ])
      await post(app, '/v1/workspaces/w/stop')
      expect(await view()).toEqual(running)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers 404 for a start or stop of an unknown id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-start-unknown-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const r = await post(app, '/v1/workspaces/nope/start')
      expect(r.statusCode).toBe(404)
      expect(r.json()).toEqual({ error: { code: 'not_found', message: 'workspace not found' } })
      expect((await post(app, '/v1/workspaces/nope/stop')).statusCode).toBe(404)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('PUT /v1/workspaces/:id/profiles/:name defines and replaces a name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-profile-'))
    const app = buildApp({ stateRoot: join(root, 'state') })
    try {
      const create = await app.inject({ method: 'POST', url: '/v1/workspaces', payload: RAM })
      const id = create.json<{ id: string }>().id
      const route = `/v1/workspaces/${id}/profiles/reader`
      const set = await app.inject({
        method: 'PUT',
        url: route,
        payload: { commands: { allow: ['whoami'] } },
      })
      expect(set.statusCode).toBe(200)
      expect(set.json()).toEqual({ name: 'reader' })
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/sessions`,
        payload: { session_id: 'a', profile: 'reader' },
      })
      const run = async (): Promise<string> =>
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${id}/shell?session_id=a`,
            payload: { command: 'whoami; echo hi' },
          })
        ).json<{ stdout: string }>().stdout
      expect(await run()).toBe('reader\n')
      await app.inject({
        method: 'PUT',
        url: route,
        payload: { commands: { allow: ['whoami', 'echo'] } },
      })
      const moved = await app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}/sessions/a`,
        payload: { profile: 'reader' },
      })
      expect(moved.statusCode).toBe(200)
      expect(await run()).toBe('reader\nhi\n')
      const refused = await app.inject({
        method: 'PUT',
        url: route,
        payload: {
          commands: { allow: ['ls'], deny: [{ commands: ['cat *'], reason: 'sealed' }] },
        },
      })
      expect(refused.statusCode).toBe(400)
      const unknown = await app.inject({ method: 'PUT', url: `${route}x`, payload: { bogus: 1 } })
      expect(unknown.statusCode).toBe(400)
      mkdirSync(join(root, 'guard.py'))
      const unreadable = await app.inject({
        method: 'PUT',
        url: `${route}y`,
        payload: { policy: { pre_command: [{ script: join(root, 'guard.py') }] } },
      })
      expect(unreadable.statusCode).toBe(400)
      expect(unreadable.json<{ error: { message: string } }>().error.message).toContain('directory')
      const missing = await app.inject({
        method: 'PUT',
        url: '/v1/workspaces/nope/profiles/reader',
        payload: {},
      })
      expect(missing.statusCode).toBe(404)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The MCP fixture is outside rootDir, so it is imported by URL.
interface FakeMCP {
  url: string
  requests: unknown[]
  close: () => Promise<void>
}
interface Fixture {
  TOKEN: string
  TOOLS: unknown[]
  servedMcp: (tools?: unknown[]) => Promise<FakeMCP>
}
const FIXTURE = pathToFileURL(
  resolve(fileURLToPath(import.meta.url), '../../../../core/tests/fixtures/mcp_server.ts'),
).href

async function fixture(): Promise<Fixture> {
  return (await import(FIXTURE)) as Fixture
}

function mcpEntry(url: string, token: unknown): Record<string, unknown> {
  return { cli: 'mcp', config: { url, auth: { type: 'bearer', token } } }
}

function saved(key: string): Record<string, string> {
  return { from: 'strukto', ref: 'items', key }
}

async function run(
  app: App,
  id: string,
  command: string,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${id}/shell`,
    payload: { command },
  })
  return res.json()
}

// Mirrors test_workspaces.py's MCP CLI creates.
describe('MCP CLIs in a create', () => {
  class NoMCP implements Policy {
    preWorkspace(ctx: WorkspaceContext): Deny | null {
      const clis = (ctx.config.clis ?? {}) as Record<string, { cli?: string }>
      return Object.values(clis).some((entry) => entry.cli === 'mcp')
        ? { kind: 'deny', reason: 'no MCP servers' }
        : null
    }
  }

  it('never reaches a server a policy refuses', async () => {
    const { TOKEN, servedMcp } = await fixture()
    const fake = await servedMcp()
    const app = buildApp({ policies: [new NoMCP()] })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { ...RAM, clis: { fx: mcpEntry(fake.url, TOKEN) } } },
      })
      expect(res.statusCode).toBe(403)
      expect(fake.requests).toEqual([])
    } finally {
      await app.close()
      await fake.close()
    }
  })

  it('installs a saved MCP CLI', async () => {
    const { TOKEN, servedMcp } = await fixture()
    const fake = await servedMcp()
    const store = memoryResourceStore()
    const app = buildApp({ resourceStore: store })
    try {
      await store.createEntry('cli', {
        name: 'items',
        type: 'mcp',
        fields: { url: fake.url, 'auth.type': 'bearer' },
        sealed: { 'auth.token': TOKEN },
      })
      const config = {
        url: saved('url'),
        auth: { type: saved('auth.type'), token: saved('auth.token') },
      }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { ...RAM, clis: { fx: { cli: 'mcp', config } } } },
      })
      expect(res.statusCode, res.body).toBe(201)
      const listed = await run(app, res.json<{ id: string }>().id, 'fx list-items')
      expect(listed.stdout).toBe('apple\nbanana\n')
    } finally {
      await app.close()
      await fake.close()
    }
  })

  it('never reaches an MCP server outside a created workspace network', async () => {
    const { TOKEN, servedMcp } = await fixture()
    const fake = await servedMcp()
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: {
          config: { ...RAM, network: false, clis: { fx: mcpEntry(fake.url, TOKEN) } },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        "cannot list the server's tools",
      )
      expect(fake.requests).toEqual([])
    } finally {
      await app.close()
      await fake.close()
    }
  })

  it('answers a create whose MCP server lists no tools with 400', async () => {
    const { TOKEN, servedMcp } = await fixture()
    const empty = await servedMcp([])
    const app = buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { config: { ...RAM, clis: { fx: mcpEntry(empty.url, TOKEN) } } },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        'the server lists no tools',
      )
    } finally {
      await app.close()
      await empty.close()
    }
  })
})

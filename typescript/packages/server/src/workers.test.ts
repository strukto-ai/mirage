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

import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type MirageApp } from './app.ts'
import { DaemonConfigError } from './daemon_config.ts'
import { ENV_HOME, ENV_WORKER_TYPE, ENV_WORKERS } from './env.ts'
import {
  buildWorkerProxy,
  resolveWorkers,
  resolveWorkerType,
  WorkerPool,
  type WorkerProxy,
  WorkerType,
} from './workers.ts'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'daemon.ts')
const CONFIG = { mounts: { '/data': { vfs: 'ram', mode: 'write' } } }

describe('resolveWorkers', () => {
  it('reads the env, then config, else 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    try {
      const env = { [ENV_HOME]: home }
      expect(resolveWorkers(undefined, env)).toBe(1)
      await writeFile(join(home, 'config.toml'), '[daemon]\nworkers = 4\n')
      expect(resolveWorkers(undefined, env)).toBe(4)
      expect(resolveWorkers(undefined, { ...env, [ENV_WORKERS]: '2' })).toBe(2)
      expect(resolveWorkers(8, env)).toBe(8)
      expect(() => resolveWorkers(undefined, { [ENV_WORKERS]: '0' })).toThrow(DaemonConfigError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('resolveWorkerType', () => {
  it('reads the env, then config, else threads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    try {
      const env = { [ENV_HOME]: home }
      expect(resolveWorkerType(undefined, env)).toBe(WorkerType.Thread)
      await writeFile(join(home, 'config.toml'), '[daemon]\nworker_type = "process"\n')
      expect(resolveWorkerType(undefined, env)).toBe(WorkerType.Process)
      expect(resolveWorkerType(undefined, { ...env, [ENV_WORKER_TYPE]: 'thread' })).toBe(
        WorkerType.Thread,
      )
      expect(() => resolveWorkerType('cpu', env)).toThrow(DaemonConfigError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

/** Two servers on the pool's sockets, in this process, behind the proxy. */
interface Daemon {
  proxy: WorkerProxy
  apps: MirageApp[]
  url: string
  exited: () => number
}

async function daemon(maxWorkspaces: number | null = null): Promise<Daemon> {
  const pool = new WorkerPool({
    count: 2,
    type: WorkerType.Process,
    entry: ENTRY,
    execArgv: [],
    env: {},
    host: 'localhost',
    gracefulTimeout: 0,
  })
  const apps = pool.workers.map(() => buildApp({ maxWorkspaces: Number.MAX_SAFE_INTEGER }))
  await Promise.all(apps.map((app, i) => app.listen({ path: pool.workers[i]?.socket ?? '' })))
  let exits = 0
  const proxy = buildWorkerProxy({
    pool,
    maxWorkspaces,
    proxies: [],
    idleGraceSeconds: 60,
    exit: () => {
      exits += 1
    },
  })
  await proxy.listen(0, '127.0.0.1')
  const { port } = proxy.server.address() as AddressInfo
  return { proxy, apps, url: `http://127.0.0.1:${String(port)}`, exited: () => exits }
}

async function call(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) }
}

/** Where the next new workspaces go: worker 0 or worker 1, in order. */
function placeOn(...indexes: number[]): void {
  const spy = vi.spyOn(Math, 'random')
  for (const index of indexes) spy.mockReturnValueOnce(index === 0 ? 0 : 0.99)
}

const ids = (d: Daemon): string[][] => d.apps.map((app) => app.registry.list().map((e) => e.id))

describe('WorkerProxy', () => {
  let d: Daemon

  beforeEach(() => {
    vi.stubEnv('MIRAGE_HOME', process.env.HOME ?? tmpdir())
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await d.proxy.close()
    await Promise.all(d.apps.map((app) => app.close()))
    vi.unstubAllEnvs()
  })

  it('puts each new workspace on a worker at random, and lists them all', async () => {
    d = await daemon()
    placeOn(1, 0, 1)
    for (const id of ['a', 'b', 'c']) {
      expect((await call(`${d.url}/v1/workspaces`, 'POST', { id, config: CONFIG })).status).toBe(
        201,
      )
    }
    expect(ids(d)).toEqual([['b'], ['a', 'c']])
    const listed = (await call(`${d.url}/v1/workspaces`, 'GET')).json as { id: string }[]
    expect(listed.map((w) => w.id)).toEqual(['a', 'b', 'c'])
    expect((await call(`${d.url}/v1/health`, 'GET')).json).toMatchObject({
      workspaces: 3,
      workers: 2,
    })
  })

  it("sends a workspace's requests and jobs to its worker", async () => {
    d = await daemon()
    placeOn(0, 1)
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'b', config: CONFIG })
    const ran = await call(`${d.url}/v1/workspaces/b/shell`, 'POST', {
      command: 'echo hi > /data/x; cat /data/x',
    })
    expect(ran.json).toMatchObject({ exit_code: 0, stdout: 'hi\n' })
    const started = await call(`${d.url}/v1/workspaces/b/shell?background=true`, 'POST', {
      command: 'echo bg',
    })
    const job = (started.json as { job_id: string }).job_id
    const got = await call(`${d.url}/v1/jobs/${job}`, 'GET')
    expect(got.status).toBe(200)
    expect(got.json).toMatchObject({ job_id: job, workspace_id: 'b' })
    expect((await call(`${d.url}/v1/jobs/nope`, 'GET')).status).toBe(404)
    const missing = await call(`${d.url}/v1/workspaces/nope/shell`, 'POST', { command: 'true' })
    expect(missing.status).toBe(404)
  })

  it('sends a create under a held id, or its config workspace_id, to its worker', async () => {
    d = await daemon()
    placeOn(0, 1)
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces`, 'POST', { config: { ...CONFIG, workspace_id: 'n' } })
    expect(ids(d)).toEqual([['a'], ['n']])
    expect((await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })).status).toBe(
      200,
    )
    const again = { config: { ...CONFIG, workspace_id: 'n' } }
    expect((await call(`${d.url}/v1/workspaces`, 'POST', again)).status).toBe(200)
    const other = { mounts: { '/other': { vfs: 'ram', mode: 'write' } } }
    expect((await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: other })).status).toBe(
      409,
    )
    expect(ids(d)).toEqual([['a'], ['n']])
    expect((await call(`${d.url}/v1/workspaces/n/clone`, 'POST', { id: 'n2' })).status).toBe(201)
    expect(ids(d)[1]).toContain('n2')
    expect((await call(`${d.url}/v1/workspaces/n/clone`, 'POST', { id: 'a' })).status).toBe(409)
  })

  it('sends creates of one id racing each other to one worker', async () => {
    d = await daemon()
    placeOn(0, 1)
    const both = await Promise.all([
      call(`${d.url}/v1/workspaces`, 'POST', { id: 'same', config: CONFIG }),
      call(`${d.url}/v1/workspaces`, 'POST', { id: 'same', config: CONFIG }),
    ])
    expect(both.map((r) => r.status).sort()).toEqual([200, 201])
    expect(ids(d).flat()).toEqual(['same'])
  })

  it('holds max_workspaces across workers, and lets a retry of a live id through', async () => {
    d = await daemon(2)
    const racing = await Promise.all(
      ['a', 'b', 'c'].map((id) => call(`${d.url}/v1/workspaces`, 'POST', { id, config: CONFIG })),
    )
    expect(racing.map((r) => r.status).sort()).toEqual([201, 201, 503])
    const live = (await call(`${d.url}/v1/workspaces`, 'GET')).json as { id: string }[]
    const [kept, other] = live.map((w) => w.id)
    const retry = await call(`${d.url}/v1/workspaces`, 'POST', { id: kept, config: CONFIG })
    expect(retry.status).toBe(200)
    expect((await call(`${d.url}/v1/ready`, 'GET')).json).toEqual({ status: 'full' })
    expect((await call(`${d.url}/v1/workspaces/${String(kept)}`, 'DELETE')).status).toBe(200)
    expect((await call(`${d.url}/v1/workspaces/${String(other)}/close`, 'POST')).status).toBe(200)
    expect((await call(`${d.url}/v1/health`, 'GET')).json).toMatchObject({ workspaces: 0 })
    expect((await call(`${d.url}/v1/ready`, 'GET')).json).toEqual({ status: 'ready' })
  })

  it('refuses a caller the worker refuses, and holds no slot while a body uploads', async () => {
    d = await daemon(1)
    const { port } = d.proxy.server.address() as AddressInfo
    const open = (host: string): Promise<number> & { finish: () => void } => {
      const req = request({
        port,
        method: 'POST',
        path: '/v1/workspaces',
        headers: { host, 'content-type': 'application/json' },
      })
      const done = new Promise<number>((resolve, reject) => {
        req.once('response', (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
      })
      req.write('{"id": "slow", ')
      return Object.assign(done, {
        finish: () => req.end(`"config": ${JSON.stringify(CONFIG)}}`),
      })
    }
    const refused = open('evil.example')
    expect(await refused).toBe(400)
    const slow = open('localhost')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })).status).toBe(
      201,
    )
    slow.finish()
    expect(await slow).toBe(503)
    expect(ids(d).flat()).toEqual(['a'])
  })

  it('reads a multipart load up to its request part, and routes what it loads', async () => {
    d = await daemon()
    placeOn(0, 1)
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces/a/shell`, 'POST', { command: 'echo kept > /data/x' })
    const tar = await (await fetch(`${d.url}/v1/workspaces/a/snapshot`)).arrayBuffer()
    const form = new FormData()
    form.append('request', JSON.stringify({ id: 'r' }))
    form.append('snapshot', new Blob([tar]), 'snapshot.tar')
    const loaded = await fetch(`${d.url}/v1/workspaces/load`, { method: 'POST', body: form })
    expect(loaded.status).toBe(201)
    expect(ids(d)[1]).toContain('r')
    const read = await call(`${d.url}/v1/workspaces/r/shell`, 'POST', { command: 'cat /data/x' })
    expect(read.json).toMatchObject({ stdout: 'kept\n' })
    const late = new FormData()
    late.append('snapshot', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'snapshot.tar')
    late.append('request', JSON.stringify({ id: 'a' }))
    const lost = await fetch(`${d.url}/v1/workspaces/load`, { method: 'POST', body: late })
    expect(lost.status).toBe(413)
    expect(ids(d)).toEqual([['a'], ['r']])
  })

  it('stops the daemon on a shutdown its worker lets through', async () => {
    d = await daemon()
    const res = await call(`${d.url}/v1/shutdown`, 'POST')
    expect(res.json).toMatchObject({ status: 'shutting_down', pid: process.pid })
    expect(d.exited()).toBe(1)
  })
})

describe.each([WorkerType.Process, WorkerType.Thread])('%s workers', (type) => {
  it('serve, lose their workspaces when one stops, and leave nothing behind', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    const pool = new WorkerPool({
      count: 2,
      type,
      entry: ENTRY,
      execArgv: ['--experimental-transform-types', '--no-warnings'],
      env: { ...process.env, MIRAGE_HOME: home },
      host: 'localhost',
      gracefulTimeout: 0,
    })
    await pool.start()
    const proxy = buildWorkerProxy({
      pool,
      maxWorkspaces: null,
      proxies: [],
      idleGraceSeconds: 60,
      exit: () => undefined,
    })
    try {
      await proxy.listen(0, '127.0.0.1')
      const url = `http://127.0.0.1:${String((proxy.server.address() as AddressInfo).port)}`
      placeOn(0, 1)
      await call(`${url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
      await call(`${url}/v1/workspaces`, 'POST', { id: 'b', config: CONFIG })
      const ran = await call(`${url}/v1/workspaces/b/shell`, 'POST', { command: 'echo hi' })
      expect(ran.json).toMatchObject({ stdout: 'hi\n' })
      await pool.workers[1]?.stop(0)
      expect(pool.workers[1]?.dead).toBe(true)
      expect((await call(`${url}/v1/health`, 'GET')).json).toMatchObject({
        workspaces: 1,
        workers: 1,
      })
      const gone = await call(`${url}/v1/workspaces/b/shell`, 'POST', { command: 'true' })
      expect(gone.status).toBe(404)
      const kept = await call(`${url}/v1/workspaces/a/shell`, 'POST', { command: 'true' })
      expect(kept.status).toBe(200)
      const made = await call(`${url}/v1/workspaces`, 'POST', { id: 'c', config: CONFIG })
      expect(made.status).toBe(201)
    } finally {
      vi.restoreAllMocks()
      await proxy.close()
      await rm(home, { recursive: true, force: true })
    }
    expect(pool.workers.every((worker) => worker.dead)).toBe(true)
    expect(existsSync(dirname(pool.workers[0]?.socket ?? ''))).toBe(false)
  }, 120_000)
})

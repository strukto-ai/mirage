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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type MirageApp } from './app.ts'
import { DaemonConfigError } from './daemon_config.ts'
import { ENV_CPUS, ENV_HOME, ENV_WORKERS } from './env.ts'
import { buildFront, type Front, parseCpuList, resolveWorkers, WorkerPool } from './workers.ts'

describe('parseCpuList', () => {
  it('reads CPUs and ranges in order, once each', () => {
    expect(parseCpuList('0-3,6')).toEqual([0, 1, 2, 3, 6])
    expect(parseCpuList(' 4 , 1-2, 2 ')).toEqual([4, 1, 2])
  })

  it.each(['', 'a', '3-1', '-1', '0-99999'])('refuses %j', (text) => {
    expect(() => parseCpuList(text)).toThrow(DaemonConfigError)
  })
})

describe('resolveWorkers', () => {
  it('reads the env, then config, then one per CPU of cpus, else 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    try {
      const env = { [ENV_HOME]: home }
      expect(resolveWorkers(undefined, env)).toBe(1)
      expect(resolveWorkers(undefined, { ...env, [ENV_CPUS]: '0-2' })).toBe(3)
      await writeFile(join(home, 'config.toml'), '[daemon]\nworkers = 4\n')
      expect(resolveWorkers(undefined, env)).toBe(4)
      expect(resolveWorkers(undefined, { ...env, [ENV_WORKERS]: '2' })).toBe(2)
      expect(resolveWorkers(8, env)).toBe(8)
      expect(() => resolveWorkers(undefined, { [ENV_WORKERS]: '0' })).toThrow(/workers/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

/** Two in-process workers on the pool's sockets, behind a front. */
interface Daemon {
  front: Front
  workers: MirageApp[]
  url: string
  exited: () => number
}

async function daemon(maxWorkspaces: number | null = null): Promise<Daemon> {
  const pool = new WorkerPool({
    count: 2,
    cpus: null,
    command: [process.execPath],
    env: {},
    gracefulTimeout: 0,
  })
  const workers = pool.workers.map(() => buildApp({ maxWorkspaces: Number.MAX_SAFE_INTEGER }))
  await Promise.all(workers.map((app, i) => app.listen({ path: pool.workers[i]?.socket ?? '' })))
  let exits = 0
  const front = buildFront({
    pool,
    maxWorkspaces,
    proxies: [],
    idleGraceSeconds: 60,
    exit: () => {
      exits += 1
    },
  })
  await front.listen(0, '127.0.0.1')
  const { port } = front.server.address() as AddressInfo
  return { front, workers, url: `http://127.0.0.1:${String(port)}`, exited: () => exits }
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

const CONFIG = { mounts: { '/data': { vfs: 'ram', mode: 'write' } } }

describe('Front', () => {
  let d: Daemon

  beforeEach(() => {
    vi.stubEnv('MIRAGE_HOME', process.env.HOME ?? tmpdir())
  })

  afterEach(async () => {
    await d.front.close()
    await Promise.all(d.workers.map((app) => app.close()))
    vi.unstubAllEnvs()
  })

  it('puts each new workspace on the worker holding the fewest', async () => {
    d = await daemon()
    for (const id of ['a', 'b', 'c']) {
      expect((await call(`${d.url}/v1/workspaces`, 'POST', { id, config: CONFIG })).status).toBe(
        201,
      )
    }
    expect(d.workers.map((app) => app.registry.list().map((e) => e.id))).toEqual([
      ['a', 'c'],
      ['b'],
    ])
    const listed = (await call(`${d.url}/v1/workspaces`, 'GET')).json as { id: string }[]
    expect(listed.map((w) => w.id)).toEqual(['a', 'b', 'c'])
    expect((await call(`${d.url}/v1/health`, 'GET')).json).toMatchObject({
      workspaces: 3,
      workers: 2,
    })
  })

  it("sends a workspace's requests and jobs to its worker", async () => {
    d = await daemon()
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
    expect(
      (await call(`${d.url}/v1/workspaces/nope/shell`, 'POST', { command: 'true' })).status,
    ).toBe(404)
  })

  it('sends a create under a held id to the worker holding it', async () => {
    d = await daemon()
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'b', config: CONFIG })
    expect((await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })).status).toBe(
      200,
    )
    const other = { mounts: { '/other': { vfs: 'ram', mode: 'write' } } }
    expect((await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: other })).status).toBe(
      409,
    )
    expect(d.workers.map((app) => app.registry.size())).toEqual([1, 1])
    const cloned = await call(`${d.url}/v1/workspaces/b/clone`, 'POST', { id: 'b2' })
    expect(cloned.status).toBe(201)
    expect(d.workers[1]?.registry.has('b2')).toBe(true)
    expect((await call(`${d.url}/v1/workspaces/b/clone`, 'POST', { id: 'a' })).status).toBe(409)
  })

  it('reads a multipart load up to its request part, and routes what it loads', async () => {
    d = await daemon()
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces/a/shell`, 'POST', { command: 'echo kept > /data/x' })
    const tar = await (await fetch(`${d.url}/v1/workspaces/a/snapshot`)).arrayBuffer()
    const form = new FormData()
    form.append('request', JSON.stringify({ id: 'r' }))
    form.append('snapshot', new Blob([tar]), 'snapshot.tar')
    const loaded = await fetch(`${d.url}/v1/workspaces/load`, { method: 'POST', body: form })
    expect(loaded.status).toBe(201)
    expect(d.workers[1]?.registry.has('r')).toBe(true)
    const read = await call(`${d.url}/v1/workspaces/r/shell`, 'POST', { command: 'cat /data/x' })
    expect(read.json).toMatchObject({ stdout: 'kept\n' })
  })

  it('counts deletes and closes, and holds max_workspaces across workers', async () => {
    d = await daemon(2)
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'a', config: CONFIG })
    await call(`${d.url}/v1/workspaces`, 'POST', { id: 'b', config: CONFIG })
    const full = await call(`${d.url}/v1/workspaces`, 'POST', { id: 'c', config: CONFIG })
    expect(full).toEqual({ status: 503, json: { detail: 'server is at max_workspaces (2)' } })
    expect((await call(`${d.url}/v1/ready`, 'GET')).json).toEqual({ status: 'full' })
    expect((await call(`${d.url}/v1/workspaces/a`, 'DELETE')).status).toBe(200)
    expect((await call(`${d.url}/v1/workspaces/b/close`, 'POST')).status).toBe(200)
    expect((await call(`${d.url}/v1/health`, 'GET')).json).toMatchObject({ workspaces: 0 })
    expect((await call(`${d.url}/v1/ready`, 'GET')).json).toEqual({ status: 'ready' })
  })

  it('stops the daemon on a shutdown its worker lets through', async () => {
    d = await daemon()
    const res = await call(`${d.url}/v1/shutdown`, 'POST')
    expect(res.json).toMatchObject({ status: 'shutting_down', pid: process.pid })
    expect(d.exited()).toBe(1)
  })
})

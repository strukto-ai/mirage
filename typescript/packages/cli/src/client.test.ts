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

import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonConfigError } from '@struktoai/mirage-server/daemon_config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient, DaemonUnreachable } from './client.ts'
import { LoginError, readLogin, removeLogin, writeLogin, type Login } from './credentials.ts'

describe('DaemonClient spawn config validation', () => {
  let home: string
  let originalHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mirage-cli-client-'))
    originalHome = process.env.MIRAGE_HOME
    process.env.MIRAGE_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MIRAGE_HOME
    else process.env.MIRAGE_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses to spawn when config.toml has an unknown key', async () => {
    writeFileSync(join(home, 'config.toml'), '[daemon]\ntypo_key = "x"\n')
    const client = new DaemonClient({
      context: 'local',
      url: 'http://127.0.0.1:1',
      authToken: 't',
      idleGraceSeconds: 30,
    })
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(DaemonConfigError)
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(/typo_key/)
  })

  it('never spawns for a remote URL', async () => {
    const client = new DaemonClient({
      context: 'local',
      url: 'https://mirage.invalid',
      authToken: '',
      idleGraceSeconds: 30,
    })
    vi.spyOn(client, 'isReachable').mockResolvedValue(false)
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(DaemonUnreachable)
    expect(existsSync(join(home, 'auth_token'))).toBe(false)
    expect(existsSync(join(home, 'daemon.log'))).toBe(false)
  })

  it('gives a remote server 10 s to answer, and a local daemon half a second', async () => {
    const remote = new DaemonClient({
      context: 'local',
      url: 'https://mirage.invalid',
      authToken: '',
      idleGraceSeconds: 30,
    })
    const remoteProbe = vi.spyOn(remote, 'isReachable').mockResolvedValue(true)
    await remote.ensureRunning({ allowSpawn: false })
    expect(remoteProbe).toHaveBeenCalledWith(10_000)
    const local = new DaemonClient({
      context: 'local',
      url: 'http://127.0.0.1:1',
      authToken: 't',
      idleGraceSeconds: 30,
    })
    const localProbe = vi.spyOn(local, 'isReachable').mockResolvedValue(true)
    await local.ensureRunning({ allowSpawn: false })
    expect(localProbe).toHaveBeenCalledWith()
  })
})

describe('DaemonClient spawn wait', () => {
  // Twins of test_a_daemon_that_exits_ends_the_wait and
  // test_a_daemon_that_lost_the_bind_waits_for_the_winner.
  let home: string
  let originalHome: string | undefined
  const gone = { exitCode: 3, signalCode: null } as unknown as ChildProcess
  const spawned = (): void => {
    vi.spyOn(
      DaemonClient.prototype as unknown as { spawnDaemon: () => ChildProcess },
      'spawnDaemon',
    ).mockReturnValue(gone)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mirage-cli-client-'))
    originalHome = process.env.MIRAGE_HOME
    process.env.MIRAGE_HOME = home
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalHome === undefined) delete process.env.MIRAGE_HOME
    else process.env.MIRAGE_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('ends when the spawned daemon exits', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))
    spawned()
    const client = new DaemonClient({
      context: 'local',
      url: `http://127.0.0.1:${String(port)}`,
      authToken: 't',
      idleGraceSeconds: 30,
    })
    const started = Date.now()
    await expect(client.ensureRunning()).rejects.toThrow(/exited with code 3/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('waits for the daemon that won the bind', async () => {
    // Two commands spawned at once: the loser exits on a held port while
    // the winner, already listening, is still starting up.
    const asked: string[] = []
    const server = createServer((req, res) => {
      asked.push(req.url ?? '')
      res.writeHead(asked.length > 3 ? 200 : 503).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    spawned()
    const client = new DaemonClient({
      context: 'local',
      url: `http://127.0.0.1:${String(port)}`,
      authToken: 't',
      idleGraceSeconds: 30,
    })
    try {
      await client.ensureRunning()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect([asked.length, asked.at(-1)]).toEqual([4, '/v1/health'])
  })

  it('waits for a local daemon busy past the first probe', async () => {
    // Twin of test_a_local_daemon_busy_past_the_first_probe_is_waited_for.
    let asked = 0
    const server = createServer((_req, res) => {
      asked += 1
      setTimeout(() => res.writeHead(200).end(), asked === 1 ? 1000 : 0)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const spawn = vi.spyOn(
      DaemonClient.prototype as unknown as { spawnDaemon: () => ChildProcess },
      'spawnDaemon',
    )
    const client = new DaemonClient({
      context: 'local',
      url: `http://127.0.0.1:${String(port)}`,
      authToken: 't',
      idleGraceSeconds: 30,
    })
    try {
      await client.ensureRunning({ allowSpawn: false })
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('DaemonClient token', () => {
  const login: Login = {
    url: 'https://mirage.example.com',
    access_token: 'from-login',
    logged_in_at: Date.now() / 1000,
    refresh_token: null,
    expires_at: null,
    client_id: null,
    token_endpoint: null,
  }
  const ending: Login = {
    ...login,
    access_token: 'old',
    refresh_token: 'r1',
    expires_at: Date.now() / 1000 - 1,
    client_id: 'client_cli',
    token_endpoint: 'https://clerk.example.com/oauth/token',
  }
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mirage-cli-client-'))
    vi.stubEnv('MIRAGE_HOME', home)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  function client(kept: Login): DaemonClient {
    return new DaemonClient({
      context: 'local',
      url: login.url,
      idleGraceSeconds: 30,
      authToken: '',
      login: kept,
    })
  }

  it("is the settings' own, else the login's", async () => {
    writeLogin(login)
    const base = { context: 'local', url: login.url, idleGraceSeconds: 30 }
    expect(await new DaemonClient({ ...base, authToken: 'set', login }).token()).toBe('set')
    expect(await client(login).token()).toBe('from-login')
    expect(await new DaemonClient({ ...base, authToken: '' }).token()).toBe('')
  })

  it('stops the command when the login has ended', async () => {
    const old = { ...login, logged_in_at: Date.now() / 1000 - 31 * 24 * 60 * 60 }
    writeLogin(old)
    await expect(client(old).token()).rejects.toThrow(LoginError)
  })

  it('refreshes the login once for requests sent at once', async () => {
    let posted = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      posted += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
      return Response.json({ access_token: 'new', expires_in: 86400 })
    })
    writeLogin(ending)
    const running = client(ending)
    const got = await Promise.all([1, 2, 3, 4].map(() => running.token()))
    expect(got).toEqual(['new', 'new', 'new', 'new'])
    expect(posted).toBe(1)
  })

  it('stops sending the login once it is logged out', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    writeLogin(ending)
    const running = client(ending)
    removeLogin()
    await expect(running.token()).rejects.toThrow(/not logged in to/)
    expect(fetched).not.toHaveBeenCalled()
    expect(readLogin()).toBeNull()
  })

  it('stops when a new login replaces the one it is bound to', async () => {
    const first = { ...login, access_token: 'alice', logged_in_at: Date.now() / 1000 - 60 }
    writeLogin(first)
    const running = client(first)
    expect(await running.token()).toBe('alice')
    expect(running.held).toBe('alice')
    writeLogin({ ...first, access_token: 'bob', logged_in_at: Date.now() / 1000 })
    await expect(running.token()).rejects.toThrow(/changed/)
  })
})

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
      url: 'http://127.0.0.1:1',
      authToken: 't',
      idleGraceSeconds: 30,
    })
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(DaemonConfigError)
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(/typo_key/)
  })

  it('never spawns for a remote URL', async () => {
    const client = new DaemonClient({
      url: 'https://mirage.invalid',
      authToken: '',
      idleGraceSeconds: 30,
    })
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(DaemonUnreachable)
    expect(existsSync(join(home, 'auth_token'))).toBe(false)
    expect(existsSync(join(home, 'daemon.log'))).toBe(false)
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
    return new DaemonClient({ url: login.url, idleGraceSeconds: 30, authToken: '', login: kept })
  }

  it("is the settings' own, else the login's", async () => {
    writeLogin(login)
    const base = { url: login.url, idleGraceSeconds: 30 }
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
})

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

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLogin, removeLogin, writeLogin, type Login } from './credentials.ts'
import { ENV_AUTH_MODE, ENV_AUTH_TOKEN, ENV_DAEMON_PORT, ENV_DAEMON_URL, ENV_TOKEN } from './env.ts'
import { MCP_ENV_NAMES, relayWorkspace } from './mcp.ts'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-mcp-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mirage mcp', () => {
  it('reads the mcp config names first', () => {
    expect(MCP_ENV_NAMES).toEqual(['MIRAGE_MCP_CONFIG', 'MIRAGE_CONFIG'])
  })
})

const TOKEN = 'mcp-test-token'

function daemonEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k !== ENV_AUTH_TOKEN && k !== ENV_TOKEN) env[k] = v
  }
  env.MIRAGE_HOME = mkTempDir()
  env[ENV_DAEMON_URL] = `http://127.0.0.1:${String(port)}`
  env[ENV_DAEMON_PORT] = String(port)
  env[ENV_AUTH_MODE] = 'local'
  env[ENV_AUTH_TOKEN] = TOKEN
  env[ENV_TOKEN] = TOKEN
  return env
}

function writeConfig(): string {
  const path = join(mkTempDir(), 'workspace.yaml')
  writeFileSync(path, 'mounts:\n  /:\n    vfs: ram\n    mode: WRITE\n')
  return path
}

describe('mirage mcp over stdio', () => {
  it('deletes its workspace when the daemon refuses the session check', async () => {
    const calls: string[] = []
    const stub = createHttpServer((req, res) => {
      calls.push(`${req.method ?? ''} ${req.url ?? ''}`)
      const refused = req.url?.endsWith('/sessions') === true
      res.writeHead(refused ? 500 : req.method === 'POST' ? 201 : 200, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify(refused ? { detail: 'sessions on fire' } : { id: 'minted' }))
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = stub.address() as AddressInfo
      const child = spawn(process.execPath, [BIN, 'mcp', writeConfig(), '-s', 'agent'], {
        env: daemonEnv(port),
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.stdin.end()
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(code).toBe(2)
      expect(stderr).toBe('daemon error 500: sessions on fire\n')
      expect(calls).toContain('DELETE /v1/workspaces/minted')
    } finally {
      await new Promise((resolve) => stub.close(resolve))
    }
  }, 60_000)

  it('takes a config or a workspace, not both', async () => {
    const child = spawn(process.execPath, [BIN, 'mcp', writeConfig(), '-w', 'ws_1'])
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(2)
  })
})

async function stubDaemon(
  refused: readonly string[] = [],
): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = []
  const stub = createHttpServer((req, res) => {
    const sent = req.headers.authorization ?? ''
    calls.push(`${req.method ?? ''} ${req.url ?? ''} ${sent}`)
    const refresh = req.url === '/oauth/token'
    const refuse = req.method === 'DELETE' && refused.includes(sent)
    res.writeHead(refuse ? 401 : req.method === 'POST' && !refresh ? 201 : 200, {
      'content-type': 'application/json',
    })
    res.end(
      JSON.stringify(refresh ? { access_token: 'fresh', expires_in: 86400 } : { id: 'minted' }),
    )
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        stub.close(() => {
          resolve()
        })
      }),
  }
}

function loggedIn(url: string, fields: Partial<Login> = {}): Login {
  vi.stubEnv('MIRAGE_HOME', mkTempDir())
  vi.stubEnv(ENV_DAEMON_URL, url)
  vi.stubEnv(ENV_TOKEN, undefined)
  const login: Login = {
    url,
    access_token: 'from-login',
    logged_in_at: Date.now() / 1000,
    refresh_token: null,
    expires_at: null,
    client_id: null,
    token_endpoint: null,
    ...fields,
  }
  writeLogin(login)
  return login
}

describe('relayWorkspace', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('deletes its workspace with its own token after its login ended', async () => {
    const daemon = await stubDaemon()
    try {
      loggedIn(daemon.url)
      await relayWorkspace(writeConfig(), undefined, undefined, 'mcp', async (_url, token) => {
        expect(await token()).toBe('from-login')
        removeLogin()
      })
    } finally {
      await daemon.close()
    }
    expect(daemon.calls).toContain('DELETE /v1/workspaces/minted Bearer from-login')
    expect(readLogin()).toBeNull()
  })

  it('deletes its workspace on its own server', async () => {
    const daemon = await stubDaemon()
    const other = await stubDaemon()
    try {
      loggedIn(daemon.url)
      await relayWorkspace(writeConfig(), undefined, undefined, 'mcp', async (_url, token) => {
        await token()
        vi.stubEnv(ENV_DAEMON_URL, other.url)
      })
    } finally {
      await daemon.close()
      await other.close()
    }
    expect(daemon.calls).toContain('DELETE /v1/workspaces/minted Bearer from-login')
    expect(other.calls).toEqual([])
  })

  it('refreshes an ended token to delete its workspace', async () => {
    const daemon = await stubDaemon(['Bearer from-login'])
    try {
      const login = loggedIn(daemon.url, {
        refresh_token: 'r1',
        expires_at: Date.now() / 1000 + 3600,
        client_id: 'client_cli',
        token_endpoint: `${daemon.url}/oauth/token`,
      })
      await relayWorkspace(writeConfig(), undefined, undefined, 'mcp', async (_url, token) => {
        expect(await token()).toBe('from-login')
        writeLogin({ ...login, expires_at: Date.now() / 1000 - 1 })
      })
    } finally {
      await daemon.close()
    }
    expect(daemon.calls).toContain('DELETE /v1/workspaces/minted Bearer fresh')
  })

  it('deletes its workspace without waiting on a refresh', async () => {
    const daemon = await stubDaemon()
    try {
      const login = loggedIn(daemon.url, {
        refresh_token: 'r1',
        expires_at: Date.now() / 1000 + 3600,
        client_id: 'client_cli',
        token_endpoint: 'http://127.0.0.1:1/oauth/token',
      })
      await relayWorkspace(writeConfig(), undefined, undefined, 'mcp', async (_url, token) => {
        expect(await token()).toBe('from-login')
        writeLogin({ ...login, expires_at: Date.now() / 1000 + 10 })
      })
    } finally {
      await daemon.close()
    }
    expect(daemon.calls).toContain('DELETE /v1/workspaces/minted Bearer from-login')
  })
})

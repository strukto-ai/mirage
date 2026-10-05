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
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { AuthMode } from '@struktoai/mirage-server/auth/config'
import { defaultTokenFile, ensureTokenFile } from '@struktoai/mirage-server/auth/storage'
import { readDaemonTable, validateDaemonTable } from '@struktoai/mirage-server/daemon_config'
import { mirageHome } from '@struktoai/mirage-server/paths'

import { ENV_AUTH_MODE, ENV_AUTH_TOKEN, ENV_DAEMON_PORT, ENV_IDLE_GRACE_SECONDS } from './env.ts'
import { LoginError, freshToken, readLogin } from './credentials.ts'
import { isLocalUrl, type DaemonSettings } from './settings.ts'

const requireFromHere = createRequire(import.meta.url)

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** The daemon is down and may not be spawned, or a spawned one never answered. */
export class DaemonUnreachable extends Error {
  override readonly name = 'DaemonUnreachable'
}

export class DaemonClient {
  readonly settings: DaemonSettings
  private refreshing: Promise<string> | undefined
  /** The last login token this client sent. */
  held = ''

  constructor(settings: DaemonSettings) {
    this.settings = settings
  }

  /**
   * The bearer token to send: the settings' own, else the login's,
   * refreshed when it is about to end; empty when there is none. The client
   * stays bound to the login it started with. That login is read from its
   * file each time, so a refresh made by another process is shared, while
   * `mirage logout` or a new login stops this one; requests sent at once
   * share one read, so they refresh it once. The token sent is kept as
   * `held`. Throws `LoginError` when the login ended or changed, or cannot
   * give a token.
   */
  async token(): Promise<string> {
    const login = this.settings.login
    if (this.settings.authToken !== '' || login === undefined) {
      this.held = this.settings.authToken
      return this.held
    }
    this.refreshing ??= (async () => {
      const stored = readLogin()
      if (stored?.url !== login.url) {
        throw new LoginError(`not logged in to ${login.url} any more; run \`mirage login\``)
      }
      if (stored.logged_in_at !== login.logged_in_at) {
        throw new LoginError(`the login to ${login.url} changed; run the command again`)
      }
      this.held = await freshToken(stored)
      return this.held
    })().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...extra }
    const token = await this.token()
    if (token !== '') h.Authorization = `Bearer ${token}`
    return h
  }

  async request(
    method: string,
    path: string,
    init: RequestInit & { timeoutMs?: number | null } = {},
  ): Promise<Response> {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...rest } = init
    const headers: Record<string, string> = {
      ...(await this.headers()),
      ...((rest.headers ?? {}) as Record<string, string>),
    }
    if (rest.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (timeoutMs === null) return fetch(this.settings.url + path, { ...rest, method, headers })
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
    }, timeoutMs)
    try {
      return await fetch(this.settings.url + path, {
        ...rest,
        method,
        headers,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * Send a JSON `request` part and then `part`, streamed from its data
   * as it is read, as one multipart body. There is no overall timeout,
   * since the upload lasts as long as its input; `signal` aborts it.
   */
  async requestUpload(
    method: string,
    path: string,
    request: Record<string, unknown>,
    part: { name: string; data: AsyncIterable<Uint8Array> },
    signal?: AbortSignal,
  ): Promise<Response> {
    const boundary = `mirage-${randomUUID()}`
    const text = new TextEncoder()
    const head = text.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="request"; filename="request.json"\r\n` +
        `Content-Type: application/json\r\n\r\n${JSON.stringify(request)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.name}.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    )
    const tail = text.encode(`\r\n--${boundary}--\r\n`)
    async function* parts(): AsyncGenerator<Uint8Array> {
      yield head
      for await (const chunk of part.data) yield chunk
      yield tail
    }
    return fetch(this.settings.url + path, {
      method,
      headers: await this.headers({
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      }),
      body: ReadableStream.from(parts()),
      duplex: 'half',
      ...(signal !== undefined ? { signal } : {}),
    } as RequestInit)
  }

  async isReachable(timeoutMs = 500): Promise<boolean> {
    const headers = await this.headers()
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
    }, timeoutMs)
    try {
      const r = await fetch(this.settings.url + '/v1/health', {
        headers,
        signal: ctrl.signal,
      })
      return r.status === 200
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }

  async ensureRunning(opts: { allowSpawn?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const allowSpawn = opts.allowSpawn ?? true
    const timeoutMs = opts.timeoutMs ?? 5000
    if (await this.isReachable()) return
    if (!isLocalUrl(this.settings.url)) {
      throw new DaemonUnreachable(`daemon not reachable at ${this.settings.url}`)
    }
    if (!allowSpawn) {
      throw new DaemonUnreachable(
        `daemon not reachable at ${this.settings.url}; run \`mirage workspace create CONFIG.yaml\` to spawn one`,
      )
    }
    this.spawnDaemon()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isReachable(300)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new DaemonUnreachable(
      `daemon spawned but did not answer /v1/health within ${String(timeoutMs)}ms`,
    )
  }

  private spawnDaemon(): void {
    const table = readDaemonTable(mirageHome())
    validateDaemonTable(table)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env[ENV_DAEMON_PORT] = String(this.resolvePort(table))
    if ((env[ENV_IDLE_GRACE_SECONDS] ?? '') === '') {
      env[ENV_IDLE_GRACE_SECONDS] = String(this.settings.idleGraceSeconds)
    }
    if (this.settings.authToken === '') {
      this.settings.authToken = ensureTokenFile(defaultTokenFile())
    }
    env[ENV_AUTH_TOKEN] = this.settings.authToken
    if ((env[ENV_AUTH_MODE] ?? '') === '' && (table.auth_mode ?? '') === '') {
      env[ENV_AUTH_MODE] = AuthMode.Local
    }
    const logDir = mirageHome()
    mkdirSync(logDir, { recursive: true })
    const out = openSync(join(logDir, 'daemon.log'), 'a')
    const daemonEntry = requireFromHere.resolve('@struktoai/mirage-server/bin/daemon')
    if (!existsSync(daemonEntry)) {
      throw new Error(
        `daemon binary not found at ${daemonEntry}; reinstall @struktoai/mirage-server`,
      )
    }
    const child = spawn(process.execPath, [daemonEntry], {
      env,
      detached: true,
      stdio: ['ignore', out, out],
    })
    child.on('error', (err) => {
      console.error('failed to spawn daemon:', err)
    })
    child.unref()
  }

  private resolvePort(table: Record<string, string>): number {
    const envPort = process.env[ENV_DAEMON_PORT]
    if (envPort !== undefined && envPort !== '') return Number(envPort)
    const configPort = table.port
    if (configPort !== undefined && configPort !== '') return Number(configPort)
    return this.portFromUrl()
  }

  private portFromUrl(): number {
    const u = new URL(this.settings.url)
    return Number(u.port) || 8765
  }
}

export function makeClient(settings: DaemonSettings): DaemonClient {
  return new DaemonClient(settings)
}

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
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuthMode, DEFAULT_TOKEN_FILE, ensureTokenFile } from '@struktoai/mirage-server'

import { ENV_AUTH_MODE, ENV_AUTH_TOKEN, ENV_DAEMON_PORT, ENV_IDLE_GRACE_SECONDS } from './env.ts'
import type { DaemonSettings } from './settings.ts'

const requireFromHere = createRequire(import.meta.url)

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export class DaemonClient {
  readonly settings: DaemonSettings

  constructor(settings: DaemonSettings) {
    this.settings = settings
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (this.settings.authToken !== '') h.Authorization = `Bearer ${this.settings.authToken}`
    return h
  }

  async request(
    method: string,
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...rest } = init
    const headers: Record<string, string> = {
      ...this.headers(),
      ...((rest.headers ?? {}) as Record<string, string>),
    }
    if (rest.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json'
    }
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

  async requestMultipart(method: string, path: string, form: FormData): Promise<Response> {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
    }, DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      return await fetch(this.settings.url + path, {
        method,
        headers: this.headers(),
        body: form,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }

  async isReachable(timeoutMs = 500): Promise<boolean> {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
    }, timeoutMs)
    try {
      const r = await fetch(this.settings.url + '/v1/health', {
        headers: this.headers(),
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
    if (!allowSpawn) {
      throw new Error(
        `daemon not reachable at ${this.settings.url}; run \`mirage workspace create CONFIG.yaml\``,
      )
    }
    this.spawnDaemon()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isReachable(300)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`daemon spawned but did not answer /v1/health within ${String(timeoutMs)}ms`)
  }

  private spawnDaemon(): void {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env[ENV_DAEMON_PORT] = String(this.portFromUrl())
    env[ENV_IDLE_GRACE_SECONDS] = String(this.settings.idleGraceSeconds)
    if (this.settings.authToken === '') {
      this.settings.authToken = ensureTokenFile(DEFAULT_TOKEN_FILE)
    }
    env[ENV_AUTH_TOKEN] = this.settings.authToken
    env[ENV_AUTH_MODE] ??= AuthMode.Local
    const logDir = join(homedir(), '.mirage')
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

  private portFromUrl(): number {
    const u = new URL(this.settings.url)
    return Number(u.port) || 8765
  }
}

export function makeClient(settings: DaemonSettings): DaemonClient {
  return new DaemonClient(settings)
}

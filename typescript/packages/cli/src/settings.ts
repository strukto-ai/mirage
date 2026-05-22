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

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TOKEN_FILE, readTokenFile } from '@struktoai/mirage-server'

import { ENV_DAEMON_URL, ENV_TOKEN } from './env.ts'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8765'

export interface DaemonSettings {
  url: string
  authToken: string
  idleGraceSeconds: number
}

export interface LoadOptions {
  env?: Record<string, string | undefined>
  configPath?: string
  tokenFile?: string
}

function defaultConfigPath(): string {
  return join(homedir(), '.mirage', 'config.toml')
}

function parseValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

function readDaemonTable(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf-8')
  const out: Record<string, string> = {}
  let inDaemon = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '[daemon]') {
      inDaemon = true
      continue
    }
    if (trimmed.startsWith('[')) {
      inDaemon = false
      continue
    }
    if (!inDaemon) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    out[key] = parseValue(trimmed.slice(eq + 1).trim())
  }
  return out
}

export function loadDaemonSettings(options: LoadOptions = {}): DaemonSettings {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const path = options.configPath ?? defaultConfigPath()
  const table = readDaemonTable(path)
  const settings: DaemonSettings = {
    url: table.url ?? DEFAULT_DAEMON_URL,
    authToken: table.auth_token ?? '',
    idleGraceSeconds: Number(table.idle_grace_seconds ?? '30'),
  }
  const envUrl = env[ENV_DAEMON_URL]
  if (envUrl !== undefined && envUrl !== '') {
    settings.url = envUrl
  }
  const envToken = env[ENV_TOKEN]
  if (envToken !== undefined && envToken !== '') {
    settings.authToken = envToken
  }
  if (settings.authToken === '') {
    const fileToken = readTokenFile(options.tokenFile ?? DEFAULT_TOKEN_FILE)
    if (fileToken !== undefined && fileToken !== '') {
      settings.authToken = fileToken
    }
  }
  return settings
}

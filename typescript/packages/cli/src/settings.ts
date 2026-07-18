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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ALLOWED_KEYS,
  DaemonConfigError,
  DEFAULT_ALLOWED_HOSTS,
  NUMERIC_KEYS,
  defaultTokenFile,
  mirageHome,
  parseDaemonTable,
  readDaemonTable,
  readTokenFile,
} from '@struktoai/mirage-server'

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

export function loadDaemonSettings(options: LoadOptions = {}): DaemonSettings {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const table =
    options.configPath !== undefined
      ? existsSync(options.configPath)
        ? parseDaemonTable(readFileSync(options.configPath, 'utf-8'))
        : {}
      : readDaemonTable(mirageHome(env))
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
    const fileToken = readTokenFile(options.tokenFile ?? defaultTokenFile(env))
    if (fileToken !== undefined && fileToken !== '') {
      settings.authToken = fileToken
    }
  }
  return settings
}

function defaultConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), 'config.toml')
}

const ENV_FOR_KEY: Record<string, string> = {
  url: ENV_DAEMON_URL,
  allowed_hosts: 'MIRAGE_ALLOWED_HOSTS',
  auth_mode: 'MIRAGE_AUTH_MODE',
  jwt_alg: 'MIRAGE_JWT_ALG',
  jwt_issuer: 'MIRAGE_JWT_ISSUER',
  jwt_audience: 'MIRAGE_JWT_AUDIENCE',
  jwt_pubkey_file: 'MIRAGE_JWT_PUBKEY_FILE',
  jwt_clock_skew: 'MIRAGE_JWT_CLOCK_SKEW_SECONDS',
  jwt_authorized_parties: 'MIRAGE_JWT_AUTHORIZED_PARTIES',
  auth_token: ENV_TOKEN,
  idle_grace_seconds: 'MIRAGE_IDLE_GRACE_SECONDS',
  port: 'MIRAGE_DAEMON_PORT',
}

function defaultForKey(key: string): string {
  const defaults: Record<string, string> = {
    url: DEFAULT_DAEMON_URL,
    allowed_hosts: DEFAULT_ALLOWED_HOSTS.join(','),
    auth_mode: 'local',
    jwt_alg: '',
    jwt_issuer: '',
    jwt_audience: '',
    jwt_pubkey_file: '',
    jwt_clock_skew: '5',
    jwt_authorized_parties: '',
    socket: '',
    auth_token: '',
    idle_grace_seconds: '30',
    port: '8765',
  }
  return defaults[key] ?? ''
}

export function resolvedConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, [string, string]> {
  const home = mirageHome(env)
  const table = readDaemonTable(home)
  const out: Record<string, [string, string]> = {}
  for (const key of [...ALLOWED_KEYS].sort()) {
    const envName = ENV_FOR_KEY[key]
    if (envName !== undefined) {
      const envValue = env[envName]
      if (envValue !== undefined && envValue !== '') {
        out[key] = [envValue, `env ${envName}`]
        continue
      }
    }
    const fileValue = table[key]
    if (fileValue !== undefined && fileValue !== '') {
      out[key] = [fileValue, 'file']
    } else {
      out[key] = [defaultForKey(key), 'default']
    }
  }
  return out
}

function checkKey(key: string): void {
  if (!ALLOWED_KEYS.has(key)) {
    throw new DaemonConfigError(
      `unknown config key: '${key}'; allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
}

function formatValue(key: string, value: string): string {
  if (NUMERIC_KEYS.has(key)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function listConfig(path?: string): Record<string, string> {
  const p = path ?? defaultConfigPath(process.env as Record<string, string | undefined>)
  if (!existsSync(p)) return {}
  return parseDaemonTable(readFileSync(p, 'utf-8'))
}

export function getConfig(key: string, path?: string): string | undefined {
  checkKey(key)
  return listConfig(path)[key]
}

export function setConfig(key: string, value: string, path?: string): void {
  checkKey(key)
  const p = path ?? defaultConfigPath(process.env as Record<string, string | undefined>)
  const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n') : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rendered = `${key} = ${formatValue(key, value)}`
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '[daemon]') {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) {
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('')
    lines.push('[daemon]', rendered)
  } else {
    let end = lines.length
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim().startsWith('[')) {
        end = i
        break
      }
    }
    let replaced = false
    for (let i = headerIdx + 1; i < end; i++) {
      const t = (lines[i] ?? '').trim()
      if (t.startsWith('#') || !t.includes('=')) continue
      if (t.slice(0, t.indexOf('=')).trim() === key) {
        lines[i] = rendered
        replaced = true
        break
      }
    }
    if (!replaced) lines.splice(end, 0, rendered)
  }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, lines.join('\n') + '\n')
  chmodSync(p, 0o600)
}

export function unsetConfig(key: string, path?: string): void {
  const p = path ?? defaultConfigPath(process.env as Record<string, string | undefined>)
  if (!existsSync(p)) return
  const lines = readFileSync(p, 'utf-8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const kept: string[] = []
  let inDaemon = false
  for (const line of lines) {
    const t = line.trim()
    if (t === '[daemon]') {
      inDaemon = true
      kept.push(line)
      continue
    }
    if (t.startsWith('[')) inDaemon = false
    if (
      inDaemon &&
      t.includes('=') &&
      !t.startsWith('#') &&
      t.slice(0, t.indexOf('=')).trim() === key
    )
      continue
    kept.push(line)
  }
  writeFileSync(p, kept.join('\n') + '\n')
  chmodSync(p, 0o600)
}

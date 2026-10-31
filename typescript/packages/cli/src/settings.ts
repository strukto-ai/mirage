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
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { CONFIG_ENV_KEYS } from '@struktoai/mirage-server/auth/config'
import { defaultTokenFile, readTokenFile } from '@struktoai/mirage-server/auth/storage'
import {
  ENV_ALLOWED_HOSTS,
  ENV_DAEMON_PORT,
  ENV_FORWARDED_ALLOW_IPS,
  ENV_GRACEFUL_TIMEOUT,
  ENV_IDLE_GRACE_SECONDS,
  ENV_MAX_SESSIONS,
  ENV_MAX_WORKSPACES,
  ENV_POLICY_FILE,
  ENV_RATE_LIMITS,
  ENV_WORKER_TYPE,
  ENV_WORKERS,
} from '@struktoai/mirage-server/env'
import {
  ALLOWED_KEYS,
  DEFAULT_RATE_LIMITS,
  DaemonConfigError,
  NUMERIC_KEYS,
  parseDaemonTable,
  readDaemonTable,
} from '@struktoai/mirage-server/daemon_config'
import { DEFAULT_ALLOWED_HOSTS } from '@struktoai/mirage-server/host_validation_constants'
import { mirageHome } from '@struktoai/mirage-server/paths'
import {
  AUTHORIZED_KEYS_NAME,
  DEFAULT_SSH_HOST,
  HOST_KEY_NAME,
  SSH_ENV_KEYS,
} from '@struktoai/mirage-server/ssh/constants'
import { defaultSSHDir } from '@struktoai/mirage-server/ssh/config'

import { loginPath, readLogin, type Login } from './credentials.ts'
import { ENV_DAEMON_URL, ENV_TOKEN } from './env.ts'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8765'

/**
 * Whether a daemon URL points at this machine. Only such a URL may use
 * the local token file or start a daemon, so neither the file's token
 * nor a spawn ever goes to a remote host.
 *
 * @param url - The daemon URL.
 * @returns True when its host is a loopback name.
 */
export function isLocalUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return DEFAULT_ALLOWED_HOSTS.includes(host.replace(/^\[(.*)\]$/, '$1'))
}

export interface DaemonSettings {
  url: string
  authToken: string
  idleGraceSeconds: number
  /** The `mirage login` made for this URL, used when no token is set. */
  login?: Login
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
    const login = readLogin(loginPath(env))
    if (login !== null && login.url === rstripSlash(settings.url)) {
      settings.login = login
      return settings
    }
  }
  if (settings.authToken === '' && isLocalUrl(settings.url)) {
    const fileToken = readTokenFile(options.tokenFile ?? defaultTokenFile(env))
    if (fileToken !== undefined && fileToken !== '') {
      settings.authToken = fileToken
    }
  }
  return settings
}

function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), 'config.toml')
}

const ENV_FOR_KEY: Record<string, string> = {
  url: ENV_DAEMON_URL,
  allowed_hosts: ENV_ALLOWED_HOSTS,
  forwarded_allow_ips: ENV_FORWARDED_ALLOW_IPS,
  ...CONFIG_ENV_KEYS,
  auth_token: ENV_TOKEN,
  idle_grace_seconds: ENV_IDLE_GRACE_SECONDS,
  graceful_timeout: ENV_GRACEFUL_TIMEOUT,
  max_workspaces: ENV_MAX_WORKSPACES,
  max_sessions: ENV_MAX_SESSIONS,
  workers: ENV_WORKERS,
  worker_type: ENV_WORKER_TYPE,
  rate_limits: ENV_RATE_LIMITS,
  policy_file: ENV_POLICY_FILE,
  port: ENV_DAEMON_PORT,
  ...SSH_ENV_KEYS,
}

function defaultForKey(key: string, home: string): string {
  const defaults: Record<string, string> = {
    url: DEFAULT_DAEMON_URL,
    allowed_hosts: DEFAULT_ALLOWED_HOSTS.join(','),
    forwarded_allow_ips: '',
    auth_mode: 'local',
    jwt_alg: '',
    jwt_issuer: '',
    jwt_audience: '',
    jwt_pubkey_file: '',
    jwt_jwks_url: '',
    jwt_clock_skew: '5',
    jwt_authorized_parties: '',
    login_client_id: '',
    socket: '',
    auth_token: '',
    idle_grace_seconds: '30',
    graceful_timeout: '0',
    max_workspaces: '',
    max_sessions: '',
    workers: '1',
    worker_type: '',
    rate_limits: DEFAULT_RATE_LIMITS,
    policy_file: '',
    port: '8765',
    ssh_port: '',
    ssh_host: DEFAULT_SSH_HOST,
    ssh_host_key_file: join(defaultSSHDir(home), HOST_KEY_NAME),
    ssh_authorized_keys: join(defaultSSHDir(home), AUTHORIZED_KEYS_NAME),
  }
  return defaults[key] ?? ''
}

export function resolvedConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, [string, string]> {
  const home = mirageHome(env)
  const table = readDaemonTable(home)
  const out: Record<string, [string, string]> = {}
  for (const key of [...ALLOWED_KEYS].sort(compareCodePoints)) {
    const envName = ENV_FOR_KEY[key]
    if (envName !== undefined) {
      const envValue = env[envName]
      if (envValue !== undefined && envValue !== '') {
        out[key] = [envValue, `env ${envName}`]
        continue
      }
    }
    const fileValue = table[key]
    if (fileValue !== undefined && (fileValue !== '' || key === 'rate_limits')) {
      out[key] = [fileValue, 'file']
    } else {
      out[key] = [defaultForKey(key, home), 'default']
    }
  }
  return out
}

function checkKey(key: string): void {
  if (!ALLOWED_KEYS.has(key)) {
    throw new DaemonConfigError(
      `unknown config key: '${key}'; allowed: ${[...ALLOWED_KEYS].sort(compareCodePoints).join(', ')}`,
    )
  }
}

function formatValue(key: string, value: string): string {
  if (NUMERIC_KEYS.has(key)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function listConfig(path?: string): Record<string, string> {
  const p = path ?? configPath(process.env as Record<string, string | undefined>)
  if (!existsSync(p)) return {}
  return parseDaemonTable(readFileSync(p, 'utf-8'))
}

export function getConfig(key: string, path?: string): string | undefined {
  checkKey(key)
  return listConfig(path)[key]
}

export function setConfig(key: string, value: string, path?: string): void {
  checkKey(key)
  const p = path ?? configPath(process.env as Record<string, string | undefined>)
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
  const p = path ?? configPath(process.env as Record<string, string | undefined>)
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

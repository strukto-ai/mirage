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

import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { CONFIG_ENV_KEYS } from '@struktoai/mirage-server/auth/config'
import { defaultTokenFile, readTokenFile } from '@struktoai/mirage-server/auth/storage'
import {
  ALLOWED_KEYS,
  DaemonConfigError,
  DEFAULT_RATE_LIMITS,
  NUMERIC_KEYS,
  parseDaemonTable,
  readDaemonTable,
} from '@struktoai/mirage-server/daemon_config'
import {
  ENV_ALLOWED_HOSTS,
  ENV_DAEMON_PORT,
  ENV_FORWARDED_ALLOW_IPS,
  ENV_GRACEFUL_TIMEOUT,
  ENV_IDLE_GRACE_SECONDS,
  ENV_MAX_ENV,
  ENV_MAX_LINE_SECONDS,
  ENV_MAX_MEMORY,
  ENV_MAX_PROCESSES,
  ENV_MAX_SESSIONS,
  ENV_MAX_WORKSPACES,
  ENV_POLICY_FILE,
  ENV_RATE_LIMITS,
  ENV_RESOURCE_STORE,
  ENV_WORKER_TYPE,
  ENV_WORKERS,
} from '@struktoai/mirage-server/env'
import { DEFAULT_ALLOWED_HOSTS } from '@struktoai/mirage-server/host_validation_constants'
import { mirageHome } from '@struktoai/mirage-server/paths'
import { defaultSSHDir } from '@struktoai/mirage-server/ssh/config'
import {
  AUTHORIZED_KEYS_NAME,
  DEFAULT_SSH_HOST,
  HOST_KEY_NAME,
  SSH_ENV_KEYS,
} from '@struktoai/mirage-server/ssh/constants'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PORT, LOCAL } from './constants.ts'
import {
  ContextError,
  currentName,
  loginPath,
  readContext,
  readLogin,
  writeContext,
  type Login,
} from './credentials.ts'
import { ENV_DAEMON_URL, ENV_TOKEN, ENV_WORKSPACE } from './env.ts'
import { fail } from './output.ts'

type Env = Record<string, string | undefined>

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8765'

/**
 * The URL `local` follows when it keeps none of its own: config.toml's
 * `url`, else this machine at the port a spawned daemon listens on.
 */
export function defaultLocalUrl(table: Record<string, string>, env: Env = process.env): string {
  const fromEnv = env[ENV_DAEMON_PORT]
  const port =
    fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : table.port !== undefined && table.port !== ''
        ? table.port
        : String(DEFAULT_PORT)
  if (table.url !== undefined && table.url !== '') return table.url
  return `http://127.0.0.1:${port}`
}

/** The `local` context's URL: the one it logged in to, else `defaultLocalUrl`. */
export function localUrl(table: Record<string, string>, env: Env = process.env): string {
  const own = readContext(LOCAL, env)?.url ?? ''
  return own !== '' ? own : defaultLocalUrl(table, env)
}

/** The workspace a command uses when given none: `$MIRAGE_WORKSPACE`, else the current context's. */
export function currentWorkspace(env: Env = process.env): string | null {
  const fromEnv = env[ENV_WORKSPACE]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return readContext(currentName(env), env)?.workspace ?? null
}

/** The workspace to act on: `-w`, else `$MIRAGE_WORKSPACE`, else the current context's. */
export function resolveWorkspace(given: string | undefined): string {
  const found = given !== undefined && given !== '' ? given : currentWorkspace()
  if (found === null || found === '') {
    fail('no workspace selected · run `mirage workspace use <id>` or pass -w', 2)
  }
  return found
}

/**
 * Say on a terminal which context and team a command acted in, as
 * `strukto · team acme · created demo`; `name` is the current context
 * when left out.
 */
export function header(action: string, name?: string): void {
  if (!process.stderr.isTTY) return
  const used = name ?? currentName()
  const team = readContext(used)?.team ?? null
  const parts = [used, ...(team !== null && team !== '' ? [`team ${team}`] : []), action]
  process.stderr.write(parts.join(' · ') + '\n')
}

/** Make a workspace the current one of context `name`, as the command chose it. */
export function useWorkspace(name: string, workspaceId: string): void {
  const context = readContext(name)
  if (context === null) throw new ContextError(`no context '${name}'`)
  writeContext(name, { ...context, workspace: workspaceId })
}

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
  /** The context the settings are for. */
  context: string
  url: string
  authToken: string
  idleGraceSeconds: number
  /** The `mirage login` made for this URL, used when no token is set. */
  login?: Login
}

/**
 * The settings for the current context. The URL is `MIRAGE_DAEMON_URL`,
 * else the context's: a context made by `mirage login` keeps its URL, and
 * `local` follows config.toml. The token is `MIRAGE_TOKEN`, else, for
 * `local` only, config.toml's `auth_token`. With neither, the context's
 * login gives one when it was made for this URL, and then a local URL
 * takes the token file's.
 */
export function loadDaemonSettings(
  options: {
    env?: Record<string, string | undefined>
    configPath?: string
    tokenFile?: string
  } = {},
): DaemonSettings {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const table =
    options.configPath !== undefined
      ? existsSync(options.configPath)
        ? parseDaemonTable(readFileSync(options.configPath, 'utf-8'))
        : {}
      : readDaemonTable(mirageHome(env))
  const name = currentName(env)
  const local = name === LOCAL
  const context = readContext(name, env)
  if (context === null) throw new ContextError(`no context '${name}'; run \`mirage context list\``)
  const settings: DaemonSettings = {
    context: name,
    url: local ? localUrl(table, env) : context.url,
    authToken: local ? (table.auth_token ?? '') : '',
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
    const login = readLogin(loginPath(name, env))
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
  max_memory: ENV_MAX_MEMORY,
  max_env: ENV_MAX_ENV,
  max_processes: ENV_MAX_PROCESSES,
  max_line_seconds: ENV_MAX_LINE_SECONDS,
  workers: ENV_WORKERS,
  worker_type: ENV_WORKER_TYPE,
  rate_limits: ENV_RATE_LIMITS,
  policy_file: ENV_POLICY_FILE,
  resource_store: ENV_RESOURCE_STORE,
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
    max_memory: '',
    max_env: '',
    max_processes: '',
    max_line_seconds: '',
    workers: '1',
    worker_type: '',
    rate_limits: DEFAULT_RATE_LIMITS,
    policy_file: '',
    resource_store: 'files',
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

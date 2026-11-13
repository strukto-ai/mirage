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
import { join } from 'node:path'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'url',
  'auth_token',
  'auth_mode',
  'allowed_hosts',
  'forwarded_allow_ips',
  'jwt_alg',
  'jwt_issuer',
  'jwt_audience',
  'jwt_pubkey',
  'jwt_pubkey_file',
  'jwt_jwks_url',
  'jwt_clock_skew_seconds',
  'jwt_authorized_parties',
  'login_client_id',
  'idle_grace_seconds',
  'graceful_timeout',
  'max_workspaces',
  'max_sessions',
  'max_memory',
  'max_env',
  'max_processes',
  'max_line_seconds',
  'rate_limits',
  'policy_file',
  'resource_store',
  'port',
  'ssh_port',
  'ssh_host',
  'ssh_host_key_file',
  'ssh_authorized_keys',
  'workers',
  'worker_type',
])
export const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'idle_grace_seconds',
  'graceful_timeout',
  'jwt_clock_skew_seconds',
  'max_workspaces',
  'max_sessions',
  'max_processes',
  'max_line_seconds',
  'port',
  'ssh_port',
  'workers',
])
export const DEFAULT_RATE_LIMITS = 'ip=1000/minute'
export const RENAMED_KEYS: Readonly<Record<string, string>> = {
  jwt_clock_skew: 'jwt_clock_skew_seconds',
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonConfigError'
  }
}

/** Name the new key for a `[daemon]` key under its old name. */
export function renamedKeyMessage(key: string): string {
  return `config.toml: \`daemon.${key}\` is now \`daemon.${RENAMED_KEYS[key] ?? ''}\`; rename the key`
}

export function validateDaemonTable(table: Record<string, string>): void {
  const renamed = Object.keys(table)
    .filter((k) => Object.hasOwn(RENAMED_KEYS, k))
    .sort(compareCodePoints)
  if (renamed.length > 0) {
    throw new DaemonConfigError(renamed.map(renamedKeyMessage).join('; '))
  }
  const unknown = Object.keys(table)
    .filter((k) => !ALLOWED_KEYS.has(k))
    .sort(compareCodePoints)
  if (unknown.length > 0) {
    throw new DaemonConfigError(
      "config.toml: the following [daemon] keys don't match any " +
        `configuration option: ${unknown.join(', ')}`,
    )
  }
  const badTypes = Object.entries(table)
    .filter(([k, v]) => NUMERIC_KEYS.has(k) && !Number.isFinite(Number(v)))
    .map(([k]) => k)
    .sort(compareCodePoints)
  if (badTypes.length > 0) {
    throw new DaemonConfigError(
      'config.toml: the following [daemon] keys have the wrong ' + `type: ${badTypes.join(', ')}`,
    )
  }
}

const BASIC_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

function unescapeBasicString(body: string): string {
  return body.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g,
    (whole, short?: string, long?: string, one?: string) => {
      const code = short ?? long
      if (code !== undefined) {
        const point = Number.parseInt(code, 16)
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
          throw new DaemonConfigError(
            `malformed config.toml: ${whole} is not a Unicode scalar value`,
          )
        }
        return String.fromCodePoint(point)
      }
      return (one !== undefined ? BASIC_ESCAPES[one] : undefined) ?? whole
    },
  )
}

export function parseDaemonTable(text: string): Record<string, string> {
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
      if (!trimmed.endsWith(']')) {
        throw new DaemonConfigError(`malformed config.toml section line: ${trimmed}`)
      }
      inDaemon = false
      continue
    }
    if (!inDaemon) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) {
      throw new DaemonConfigError(`malformed config.toml [daemon] line: ${trimmed}`)
    }
    const raw = trimmed.slice(eq + 1).trim()
    out[trimmed.slice(0, eq).trim()] =
      raw.startsWith('"') && raw.endsWith('"') ? unescapeBasicString(raw.slice(1, -1)) : raw
  }
  return out
}

export function readDaemonTable(home: string): Record<string, string> {
  const path = join(home, 'config.toml')
  if (!existsSync(path)) return {}
  return parseDaemonTable(readFileSync(path, 'utf-8'))
}

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
import type { NetworkSetting } from '@struktoai/mirage-core/io/network'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

export const NETWORK_SHAPE =
  'config.toml: [daemon] network is true, false or {allowed_domains = [...], denied_domains = [...]}'

export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'url',
  'socket',
  'auth_token',
  'auth_mode',
  'allowed_hosts',
  'jwt_alg',
  'jwt_issuer',
  'jwt_audience',
  'jwt_pubkey_file',
  'jwt_jwks_url',
  'jwt_clock_skew',
  'jwt_authorized_parties',
  'login_client_id',
  'idle_grace_seconds',
  'max_workspaces',
  'network',
  'policy_file',
  'port',
  'ssh_port',
  'ssh_host',
  'ssh_host_key_file',
  'ssh_authorized_keys',
])
export const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'idle_grace_seconds',
  'jwt_clock_skew',
  'max_workspaces',
  'port',
  'ssh_port',
])

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonConfigError'
  }
}

export function validateDaemonTable(table: Record<string, string>): void {
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
  if (table.network !== undefined) parseNetwork(table.network)
}

/**
 * The `[daemon]` table's `network` as written: `true`, `false` or an inline
 * table of `allowed_domains` and `denied_domains`, each a one-line list of
 * double-quoted entries. Only the shape is read here; the server compiles the
 * entries as it starts.
 */
export function parseNetwork(raw: string): NetworkSetting {
  if (raw === 'true' || raw === 'false') return raw === 'true'
  const inner = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1).trim() : ''
  // Each `key = [...]` becomes a JSON member; an entry holds no `=` or space.
  const members = inner.replace(/(^|,)\s*(allowed_domains|denied_domains)\s*=/g, '$1"$2":')
  let parsed: unknown
  try {
    parsed = inner === '' ? undefined : JSON.parse(`{${members}}`)
  } catch {
    parsed = undefined
  }
  const lists = typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []
  if (
    lists.length === 0 ||
    !lists.every(
      ([key, entries]) =>
        (key === 'allowed_domains' || key === 'denied_domains') &&
        Array.isArray(entries) &&
        entries.every((entry) => typeof entry === 'string'),
    )
  ) {
    throw new DaemonConfigError(NETWORK_SHAPE)
  }
  return parsed as NetworkSetting
}

function parseValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return raw
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
    out[trimmed.slice(0, eq).trim()] = parseValue(trimmed.slice(eq + 1).trim())
  }
  return out
}

export function readDaemonTable(home: string): Record<string, string> {
  const path = join(home, 'config.toml')
  if (!existsSync(path)) return {}
  return parseDaemonTable(readFileSync(path, 'utf-8'))
}

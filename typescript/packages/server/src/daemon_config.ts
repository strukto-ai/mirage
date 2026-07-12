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
  'jwt_clock_skew',
  'jwt_authorized_parties',
  'idle_grace_seconds',
  'port',
  'pid_file',
  'version_root',
  'snapshot_root',
])
export const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'idle_grace_seconds',
  'jwt_clock_skew',
  'port',
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
    .sort()
  if (unknown.length > 0) {
    throw new DaemonConfigError(
      "config.toml: the following [daemon] keys don't match any " +
        `configuration option: ${unknown.join(', ')}`,
    )
  }
  const badTypes = Object.entries(table)
    .filter(([k, v]) => NUMERIC_KEYS.has(k) && !Number.isFinite(Number(v)))
    .map(([k]) => k)
    .sort()
  if (badTypes.length > 0) {
    throw new DaemonConfigError(
      'config.toml: the following [daemon] keys have the wrong ' + `type: ${badTypes.join(', ')}`,
    )
  }
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

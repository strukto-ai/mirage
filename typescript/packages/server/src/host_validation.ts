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

import { readDaemonTable } from './daemon_config.ts'
import { ENV_ALLOWED_HOSTS } from './env.ts'
import { DEFAULT_ALLOWED_HOSTS, HOST_PATTERN } from './host_validation_constants.ts'
import { mirageHome } from './paths.ts'

export function parseAllowedHosts(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_ALLOWED_HOSTS]
  const items = value
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
  return items.length > 0 ? items : [...DEFAULT_ALLOWED_HOSTS]
}

export function resolveAllowedHosts(
  allowedHosts?: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (allowedHosts !== undefined) return [...allowedHosts]
  const raw = env[ENV_ALLOWED_HOSTS]
  if (raw !== undefined && raw !== '') return parseAllowedHosts(raw)
  const fromConfig = readDaemonTable(mirageHome(env)).allowed_hosts
  if (fromConfig !== undefined && fromConfig !== '') return parseAllowedHosts(fromConfig)
  return parseAllowedHosts(undefined)
}

export function stripPort(rawHost: string): string {
  const match = HOST_PATTERN.exec(rawHost)
  if (match === null) return rawHost
  return match[1] ?? match[2] ?? rawHost
}

export function isHostAllowed(rawHost: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true
  if (rawHost === undefined || rawHost === '') return false
  const host = stripPort(rawHost)
  return allowed.includes(host)
}

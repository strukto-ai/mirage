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

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1']

export const ENV_VAR = 'MIRAGE_ALLOWED_HOSTS'

export function parseAllowedHosts(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_ALLOWED_HOSTS]
  const items = value
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
  return items.length > 0 ? items : [...DEFAULT_ALLOWED_HOSTS]
}

export function resolveAllowedHosts(allowedHosts?: readonly string[]): string[] {
  if (allowedHosts !== undefined) return [...allowedHosts]
  return parseAllowedHosts(process.env[ENV_VAR])
}

export function stripPort(rawHost: string): string {
  if (rawHost.startsWith('[')) {
    const close = rawHost.indexOf(']')
    if (close !== -1) return rawHost.slice(1, close)
  }
  const parts = rawHost.split(':')
  if (parts.length <= 2) return parts[0] ?? ''
  return rawHost
}

export function isHostAllowed(rawHost: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true
  if (rawHost === undefined || rawHost === '') return false
  const host = stripPort(rawHost)
  return allowed.includes(host)
}

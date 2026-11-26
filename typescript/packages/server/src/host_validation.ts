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
import { ENV_ALLOWED_HOSTS, ENV_FORWARDED_ALLOW_IPS } from './env.ts'
import { HttpError } from './errors.ts'
import {
  HOST_PATTERN,
  LOOPBACK_HOSTS,
  SAME_ORIGIN_FETCH_SITES,
} from './host_validation_constants.ts'
import { mirageHome } from './paths.ts'

/**
 * Parse a comma-separated host list, as `MIRAGE_ALLOWED_HOSTS` and the
 * `allowed_hosts` key hold it; undefined or blank lists none.
 */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
}

/**
 * The host names the server answers: the loopback names, then the names
 * added to them, each once. An added entry is kept without its port or IPv6
 * brackets and in lower case, as a Host is compared. Undefined adds
 * `$MIRAGE_ALLOWED_HOSTS`, else the `allowed_hosts` key in config.toml's
 * `[daemon]` (both comma-separated); `*` turns the Host check off. Mirrors
 * Python's `resolve_allowed_hosts`.
 */
export function resolveAllowedHosts(
  allowedHosts?: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  let entries = allowedHosts
  if (entries === undefined) {
    const fromEnv = env[ENV_ALLOWED_HOSTS]
    entries = parseAllowedHosts(
      fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : readDaemonTable(mirageHome(env)).allowed_hosts,
    )
  }
  const hosts = [...LOOPBACK_HOSTS]
  for (const entry of entries) {
    const name = stripPort(entry).toLowerCase()
    if (!hosts.includes(name)) hosts.push(name)
  }
  return hosts
}

/**
 * The proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` the server
 * believes, so the client address a rate limit counts is the caller's and
 * not the proxy's. Each entry is an address or a network (`10.0.0.0/8`);
 * `*` believes every peer. Undefined falls back to
 * `$MIRAGE_FORWARDED_ALLOW_IPS`, then the `forwarded_allow_ips` key in
 * config.toml's `[daemon]` (both comma-separated), then none. Mirrors
 * Python's `resolve_forwarded_allow_ips`.
 */
export function resolveForwardedAllowIps(
  forwardedAllowIps?: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (forwardedAllowIps !== undefined) return [...forwardedAllowIps]
  const fromEnv = env[ENV_FORWARDED_ALLOW_IPS]
  const raw =
    fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : (readDaemonTable(mirageHome(env)).forwarded_allow_ips ?? '')
  return raw
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)
}

export function stripPort(rawHost: string): string {
  const match = HOST_PATTERN.exec(rawHost)
  if (match === null) return rawHost
  return match[1] ?? match[2] ?? rawHost
}

/**
 * Whether a Host header value is allowed: `allowed` holds the names from
 * `resolveAllowedHosts`, and the host is compared without its port and in
 * lower case. `*` accepts any host.
 */
export function isHostAllowed(rawHost: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true
  if (rawHost === undefined || rawHost === '') return false
  return allowed.includes(stripPort(rawHost).toLowerCase())
}

/**
 * Whether a browser sent this request from another origin. A browser names
 * the page that made a request in `Origin` and `Sec-Fetch-Site`; other
 * clients send neither, so a request without them is never cross-origin.
 */
export function isCrossOrigin(
  rawHost: string | undefined,
  origin: string | undefined,
  fetchSite: string | undefined,
): boolean {
  if (fetchSite !== undefined && !SAME_ORIGIN_FETCH_SITES.has(fetchSite)) return true
  if (origin === undefined) return false
  const sep = origin.indexOf('://')
  return sep < 0 || origin.slice(sep + 3).toLowerCase() !== (rawHost ?? '').toLowerCase()
}

/**
 * The 403 for a request the server answers before any route: a Host it does
 * not serve, or a browser page from another origin. The message names no
 * header value. Undefined lets the request on. Mirrors Python's `refusal`.
 */
export function refusal(
  rawHost: string | undefined,
  origin: string | undefined,
  fetchSite: string | undefined,
  allowed: readonly string[],
): HttpError | undefined {
  if (!isHostAllowed(rawHost, allowed)) {
    return new HttpError('host_not_allowed', `host is not allowed; add it to ${ENV_ALLOWED_HOSTS}`)
  }
  if (isCrossOrigin(rawHost, origin, fetchSite)) {
    return new HttpError('origin_not_allowed', 'cross-origin request refused')
  }
  return undefined
}

/** The warning logged for a `refusal`, with the headers it was decided on. */
export function refusalLine(
  client: string,
  refused: HttpError,
  rawHost: string | undefined,
  origin: string | undefined,
  fetchSite: string | undefined,
  allowed: readonly string[],
): string {
  return (
    `rejecting request from ${client}: ${refused.code}: Host=${JSON.stringify(rawHost)} ` +
    `Origin=${JSON.stringify(origin)} Sec-Fetch-Site=${JSON.stringify(fetchSite)}, ` +
    `allowed ${JSON.stringify(allowed)}`
  )
}

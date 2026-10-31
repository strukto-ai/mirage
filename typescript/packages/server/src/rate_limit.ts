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

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import { PUBLIC_PATHS } from './auth/middleware.ts'
import { DEFAULT_RATE_LIMITS, DaemonConfigError, readDaemonTable } from './daemon_config.ts'
import { ENV_RATE_LIMITS } from './env.ts'
import { refused } from './metrics.ts'
import { mirageHome } from './paths.ts'

const PER: Readonly<Record<string, number>> = { second: 1, minute: 60, hour: 3600, day: 86400 }
const KEYS: ReadonlySet<string> = new Set(['ip', 'account', 'workspace'])
const HEADER = 'header:'

/**
 * At most `rate` requests for each value of `key`.
 *
 * `rate` is a count per unit: `'600/minute'`, `'50/second'`; the units are
 * second, minute, hour and day. `key` is what requests are counted by:
 * `'ip'` (the client's address, the forwarded one behind a trusted proxy),
 * `'account'` (the signed-in account), `'workspace'` (the workspace the
 * path names), `'header:<name>'` (that header's value), or a function of
 * the request. A request whose key has no value (no account, no workspace
 * in the path, no such header, a function answering null) is not counted
 * by this limit. Each value gets a window of one unit from its first
 * request; past the count, requests answer 429 with `Retry-After` until it
 * ends. Mirrors Python's `RateLimit`.
 */
export interface RateLimit {
  readonly key: string | ((request: FastifyRequest) => string | null)
  readonly rate: string
}

/** The count and window seconds of a limit; throws for a bad key or rate. */
function measure(limit: RateLimit): [number, number] {
  const { key, rate } = limit
  if (
    typeof key === 'string' &&
    !(KEYS.has(key) || (key.startsWith(HEADER) && key.length > HEADER.length))
  ) {
    throw new Error(
      `rate limit key must be ip, account, workspace or header:<name>, got ${JSON.stringify(key)}`,
    )
  }
  const at = rate.indexOf('/')
  const count = (at < 0 ? rate : rate.slice(0, at)).trim()
  const unit = at < 0 ? '' : rate.slice(at + 1).trim()
  const seconds = PER[unit.endsWith('s') ? unit.slice(0, -1) : unit]
  if (!/^[0-9]+$/.test(count) || Number(count) < 1 || seconds === undefined) {
    throw new Error(
      `rate must be a count per second, minute, hour or day, like 600/minute, got ${JSON.stringify(rate)}`,
    )
  }
  return [Number(count), seconds]
}

/**
 * The limits a `rate_limits` setting names, comma-separated `key=rate`
 * entries: `'ip=1000/minute, header:x-tenant=50/second'`. Throws for an
 * entry without `=`, or a bad key or rate.
 */
export function parseRateLimits(text: string): RateLimit[] {
  const limits: RateLimit[] = []
  for (const entry of text.split(',')) {
    if (entry.trim() === '') continue
    const eq = entry.indexOf('=')
    if (eq < 0) {
      throw new Error(`rate limit entries are key=rate, got ${JSON.stringify(entry.trim())}`)
    }
    const limit = { key: entry.slice(0, eq).trim(), rate: entry.slice(eq + 1).trim() }
    measure(limit)
    limits.push(limit)
  }
  return limits
}

/**
 * The server's rate limits: `rateLimits` when given, else those
 * `$MIRAGE_RATE_LIMITS` names, else the `rate_limits` key in config.toml's
 * `[daemon]` table, else 1000 requests per minute per IP. An explicit empty
 * list or empty config value disables the limits. Mirrors Python's
 * `resolve_rate_limits`.
 */
export function resolveRateLimits(
  rateLimits?: readonly RateLimit[],
  env: Record<string, string | undefined> = process.env,
): RateLimit[] {
  if (rateLimits !== undefined) {
    for (const limit of rateLimits) measure(limit)
    return [...rateLimits]
  }
  const fromEnv = env[ENV_RATE_LIMITS]
  const text =
    fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : (readDaemonTable(mirageHome(env)).rate_limits ?? DEFAULT_RATE_LIMITS)
  try {
    return parseRateLimits(text)
  } catch (err) {
    throw new DaemonConfigError(`rate_limits: ${(err as Error).message}`)
  }
}

/** What `request` is counted as under `key`, null when nothing. */
function value(key: RateLimit['key'], request: FastifyRequest): string | null {
  if (typeof key === 'function') return key(request)
  if (key === 'ip') return request.ip
  if (key === 'account') return request.account
  if (key === 'workspace') {
    const parts = request.url.split('?', 1)[0]?.split('/') ?? []
    if (parts[1] !== 'v1' || parts[2] !== 'workspaces' || parts.length < 4) return null
    const id = parts[3]
    if (id === undefined || id === '') return null
    try {
      return decodeURIComponent(id)
    } catch (err) {
      console.debug('rate limit: workspace id is not percent-encoded:', err)
      return id
    }
  }
  const header = request.headers[key.slice(HEADER.length).toLowerCase()]
  return typeof header === 'string' ? header : (header?.[0] ?? null)
}

/**
 * Answer 429 past the server's rate limits, each counted on its own. The
 * server registers it twice: before authentication for the limits keyed on
 * the address, the workspace or a header, so a caller with a bad token is
 * counted too, and after it, with `signedIn`, for those keyed on the account
 * or a function, which may read the signed-in account. WebSocket handshakes
 * count too; public paths are not counted. Mirrors Python's
 * `RateLimitMiddleware`.
 */
export function registerRateLimits(
  app: FastifyInstance,
  rateLimits: readonly RateLimit[],
  signedIn = false,
): void {
  const counted = rateLimits.filter(
    (limit) => (typeof limit.key === 'function' || limit.key === 'account') === signedIn,
  )
  for (const limit of counted) {
    const [points, duration] = measure(limit)
    const limiter = new RateLimiterMemory({ points, duration })
    app.addHook('onRequest', async (req, reply) => {
      if (PUBLIC_PATHS.has(req.url.split('?', 1)[0] ?? '')) return
      const by = limit.key === 'ip' ? req.ip : value(limit.key, req)
      if (by === null) return
      try {
        await limiter.consume(by)
      } catch (e) {
        if (!(e instanceof RateLimiterRes)) throw e
        reply.header('Retry-After', String(Math.max(1, Math.ceil(e.msBeforeNext / 1000))))
        // The limit, never the value counted, which may be a token.
        const name = typeof limit.key === 'function' ? 'function' : limit.key
        console.warn(`rate-limiting a request past ${name}=${limit.rate}`)
        refused('rate_limit')
        await reply.code(429).send({ detail: 'Too Many Requests' })
      }
    })
  }
}

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

import { advertiseHost, authorityHost } from '../kit/typescript/bind.ts'
import { DEFAULT_RUN, DEFAULT_TENANT, RUN_QUERY, TENANT_QUERY } from '../kit/typescript/tenant.ts'
import type { JsonValue, Reply } from '../kit/typescript/types.ts'

export const DISCORD_EPOCH = 1420070400000n
// 2026-06-03T00:00:00Z, one day past the newest fixture message and the day
// POST_TIMESTAMP names, so a posted message files under the day it is
// stamped, after every fixture day.
export const POST_SNOWFLAKE_BASE = 1780444800000n
export const MESSAGES_MAX_LIMIT = 100
export const MEMBERS_MAX_LIMIT = 1000
export const POST_TIMESTAMP = '2026-06-03T00:00:00.000000+00:00'
export const EDIT_TIMESTAMP = '2026-06-03T00:05:00.000000+00:00'
export const BASE_TOKEN = '{base}'

// python's int() reads digit-group underscores (`int("1_0") == 10`), so the
// spelling has to be part of the pattern rather than a rejection.
const PY_INT_RE = /^[+-]?\d+(?:_\d+)*$/
// SQLite has no integer wider than 64 bits.
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

export class BodyError extends Error {}

export function snowflakeAt(ms: bigint): string {
  // Python shifts an arbitrary-precision int; JavaScript's `<<` is 32-bit, so
  // this has to be BigInt or every posted id comes back truncated.
  return ((ms - DISCORD_EPOCH) << 22n).toString()
}

export function postSnowflake(n: number): string {
  return snowflakeAt(POST_SNOWFLAKE_BASE + BigInt(n) * 1000n)
}

// int(str) in python: surrounding whitespace is allowed, anything else raises.
export function pyInt(raw: string): number | null {
  const s = raw.trim()
  return PY_INT_RE.test(s) ? Number(digitsOf(s)) : null
}

// Number() and BigInt() both refuse the underscores python accepts, and
// BigInt() additionally refuses the leading plus python accepts.
function digitsOf(s: string): string {
  const bare = s.replace(/_/g, '')
  return bare.startsWith('+') ? bare.slice(1) : bare
}

export function pyIntStrict(raw: string): number {
  const parsed = pyInt(raw)
  if (parsed === null) throw new BodyError(`not an integer: ${JSON.stringify(raw)}`)
  return parsed
}

// The cursors are compared as integers, and python raised on anything that is
// not one, which aiohttp answered as a 500. BigInt('') is 0n, so the check has
// to be explicit or an empty ?after= silently becomes "from the beginning".
export function pyBigInt(raw: string): bigint {
  const s = raw.trim()
  if (!PY_INT_RE.test(s)) throw new BodyError(`not an integer: ${JSON.stringify(raw)}`)
  return BigInt(digitsOf(s))
}

// A cursor is only ever compared against a stored snowflake, and every stored
// snowflake sits strictly inside the 64-bit range, so clamping an out-of-range
// cursor to the extreme selects the same rows python's arbitrary-precision
// comparison selected. Passing it through unclamped reached Prisma as an
// unconvertible BigInt argument and answered 500, where paging from the top
// with `before=<large sentinel>` is a normal way to walk a snowflake API.
export function cursor(raw: string): bigint {
  const value = pyBigInt(raw)
  if (value > INT64_MAX) return INT64_MAX
  return value < INT64_MIN ? INT64_MIN : value
}

export function clamp(raw: string | null, fallback: number, maximum: number): number {
  const parsed = raw === null ? fallback : pyInt(raw)
  if (parsed === null) return fallback
  return Math.max(1, Math.min(parsed, maximum))
}

export function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// aiohttp's request.json() raises on an empty body and on a non-object top
// level once the handler indexes it, and both come back as a 500. The kit
// reads an empty body as {}, so the check is restated here.
export function bodyObject(raw: JsonValue): { [key: string]: JsonValue } {
  if (!isObject(raw)) throw new BodyError('request body must be a JSON object')
  return raw
}

export function requireBody(body: Buffer): void {
  if (body.length === 0) throw new BodyError('request body is empty')
}

// The fixture authors attachment urls as `{base}/attachments/...` and the
// python fake substituted the live origin on the way out. The port is read off
// the request rather than captured at listen time, so an in-process host and a
// spawned one produce the same string.
export function baseOf(url: URL): string {
  const port = url.port === '' ? '' : `:${url.port}`
  return `http://${authorityHost(advertiseHost())}${port}`
}

// The CDN route carries no Authorization header and therefore no other way to
// say which world the blob belongs to, so the run and the tenant ride in the
// url the client is told to fetch. Both are omitted at their defaults, which
// keeps the bytes byte-identical to the python fake for every caller that never
// names one.
export function cdnQuery(run: string, tenant: string): string {
  const parts: string[] = []
  if (run !== DEFAULT_RUN) parts.push(`${RUN_QUERY}=${encodeURIComponent(run)}`)
  if (tenant !== DEFAULT_TENANT) parts.push(`${TENANT_QUERY}=${encodeURIComponent(tenant)}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

export function resolveBase(value: JsonValue, base: string, suffix = ''): JsonValue {
  if (typeof value === 'string') {
    if (!value.includes(BASE_TOKEN)) return value
    return value.split(BASE_TOKEN).join(base) + suffix
  }
  if (Array.isArray(value)) return value.map((item) => resolveBase(item, base, suffix))
  if (isObject(value)) {
    const out: { [key: string]: JsonValue } = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveBase(v, base, suffix)
    return out
  }
  return value
}

export function unauthorized(): Reply {
  return { status: 401, body: { message: '401: Unauthorized', code: 0 } }
}

export function unknownChannel(): Reply {
  return { status: 404, body: { message: 'Unknown Channel', code: 10003 } }
}

export function missingAccess(): Reply {
  return { status: 403, body: { message: 'Missing Access', code: 50001 } }
}

export function unknownMessage(): Reply {
  return { status: 404, body: { message: 'Unknown Message', code: 10008 } }
}

export function invalidFormBody(): Reply {
  return { status: 400, body: { message: 'Invalid Form Body', code: 50035 } }
}

export interface ByteRange {
  start: number
  end: number
}

// Deliberately as narrow as the python original: a suffix range (`bytes=-500`)
// is read as start 0 / end 501, because that is what the partition-based parser
// it replaces did, and the CDN cases pin that answer.
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (header === undefined || !header.startsWith('bytes=')) return null
  const spec = header.slice('bytes='.length)
  const dash = spec.indexOf('-')
  const startText = dash === -1 ? spec : spec.slice(0, dash)
  const endText = dash === -1 ? '' : spec.slice(dash + 1)
  // python parsed both halves with int(), so a junk bound raised and answered
  // 500. Number() answered NaN instead, which rendered a 206 with an empty body
  // and `Content-Range: bytes NaN-NaN/<size>` -- an answer a range-applying
  // client accepts and reads zero bytes from, which is worse than an error.
  const start = startText === '' ? 0 : pyIntStrict(startText)
  const end = endText === '' ? size : pyIntStrict(endText) + 1
  return { start, end: Math.min(end, size) }
}

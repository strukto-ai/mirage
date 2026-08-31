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

import type { ErrorOf } from '../../types.ts'
import { type ByteWindow, rangeHeader, windowOf } from '../../utils/ranges.ts'

export interface RetryPolicy {
  /** Response statuses worth retrying. */
  readonly statuses: ReadonlySet<number>
  /** Retries allowed after the first attempt. */
  readonly maxRetries: number
  /**
   * Ceiling on every inter-attempt wait, whether the server asked for it
   * or the exponential fallback chose it.
   */
  readonly maxBackoff: number
  /**
   * Where the wait between attempts comes from: 'header' reads Retry-After
   * and falls back to exponential backoff (Graph's convention); 'body'
   * reads a JSON `retry_after` field and falls back to 1s (Discord's).
   */
  readonly delaySource: 'header' | 'body'
  /**
   * Also retry connection-level failures, which never carry a response;
   * the wait for those is the exponential backoff.
   */
  readonly retryTransport?: boolean
}

export const NO_RETRY: RetryPolicy = {
  statuses: new Set(),
  maxRetries: 0,
  maxBackoff: 30,
  delaySource: 'header',
}

/**
 * How to read the reply: 'json' parses the body (an empty one reads as
 * null); 'none' ignores it; 'bytes' returns it raw, trimmed to the window
 * when the server ignored the Range; 'text' returns it as a string;
 * 'location' returns the Location header.
 */
export type ReadMode = 'json' | 'none' | 'bytes' | 'text' | 'location' | 'response'

/** Decoded body plus the wire metadata cursor pagination reads. Mirrors
 * python's `ApiResponse`; a caller asking for `read: 'response'` gets this
 * rather than the bare body, because a `Link` header is the only thing that
 * says whether another page exists. */
export interface ApiResponse {
  data: unknown
  status: number
  /** Lower-cased, the way python's dump spells them, so one header is read
   * by one name in both languages. */
  headers: Record<string, string>
}

// Optional fields admit an explicit undefined (exactOptionalPropertyTypes)
// because every consumer checks `!== undefined`: missing and undefined mean
// the same thing here, and callers forward their own optional parameters.
export interface ApiRequestOptions {
  errorOf: ErrorOf
  /** Request headers, already merged by the caller. */
  headers?: Record<string, string> | undefined
  params?: Record<string, string | number | boolean> | undefined
  /** JSON request body; absent sends no body, so a caller that means "send
   * an empty object" passes `{}` explicitly. */
  json?: unknown
  /** Raw request body (bytes, form data), for endpoints that do not speak
   * JSON; exclusive with `json`. */
  body?: BodyInit | undefined
  retry?: RetryPolicy | undefined
  read?: ReadMode | undefined
  /** The byte range to request; the Range header and the trim-if-unranged
   * guard both come from it. */
  window?: ByteWindow | undefined
  /** Per-attempt timeout; absent leaves the platform default. */
  timeoutSeconds?: number | undefined
  /** The fetch to use, so transports keep their injection seam. */
  fetchFn?: typeof fetch | undefined
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

/**
 * Whether a server-supplied delay is one we can actually wait out. NaN and
 * infinity are unusable (`setTimeout` silently clamps both to 1ms, turning
 * the wait into a hot retry), and a negative delay is malformed per RFC
 * 9110, so all three fall back the way an unparseable header does.
 */
export function usableDelay(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export function headerDelay(response: Response, attempt: number, retry: RetryPolicy): number {
  const value = response.headers.get('Retry-After')
  if (value !== null) {
    const parsed = Number.parseFloat(value)
    // maxBackoff is the policy's ceiling on every inter-attempt wait, so a
    // server asking for more gets the ceiling
    if (usableDelay(parsed)) return Math.min(parsed, retry.maxBackoff)
  }
  return Math.min(2 ** attempt, retry.maxBackoff)
}

export async function bodyDelay(response: Response, retry: RetryPolicy): Promise<number> {
  const data = (await response.json().catch(() => ({}))) as { retry_after?: unknown }
  // JSON.parse rejects a bare NaN literal but overflows 1e999 to Infinity,
  // so a body delay needs the same guard as a header one.
  return typeof data.retry_after === 'number' && usableDelay(data.retry_after)
    ? Math.min(data.retry_after, retry.maxBackoff)
    : Math.min(1, retry.maxBackoff)
}

async function retryDelay(
  response: Response,
  attempt: number,
  retry: RetryPolicy,
): Promise<number> {
  if (retry.delaySource === 'body') return bodyDelay(response, retry)
  return headerDelay(response, attempt, retry)
}

/**
 * One round-trip against an HTTP API, with retry and error mapping.
 * Returns the reply per `options.read`, defaulting to the parsed JSON
 * body (null when the body is empty, e.g. a 204).
 */
export async function apiRequest(
  method: string,
  url: string,
  options: ApiRequestOptions,
): Promise<unknown> {
  const doFetch = options.fetchFn ?? fetch
  const target = new URL(url)
  for (const [name, value] of Object.entries(options.params ?? {})) {
    target.searchParams.set(name, String(value))
  }
  const headers: Record<string, string> = { ...options.headers }
  if (options.window !== undefined) {
    const range = rangeHeader(options.window.offset, options.window.size)
    if (range !== null) headers.Range = range
  }
  const retry = options.retry ?? NO_RETRY
  let attempt = 0
  for (;;) {
    const init: RequestInit = { method, headers: { ...headers } }
    if (options.json !== undefined) init.body = JSON.stringify(options.json)
    else if (options.body !== undefined) init.body = options.body
    if (options.timeoutSeconds !== undefined) {
      init.signal = AbortSignal.timeout(options.timeoutSeconds * 1000)
    }
    let response: Response
    try {
      response = await doFetch(target.toString(), init)
    } catch (err) {
      // a rejection is connection-level: HTTP errors resolve normally
      if (retry.retryTransport === true && attempt < retry.maxRetries) {
        await sleep(Math.min(2 ** attempt, retry.maxBackoff))
        attempt += 1
        continue
      }
      throw err
    }
    if (retry.statuses.has(response.status) && attempt < retry.maxRetries) {
      await sleep(await retryDelay(response, attempt, retry))
      attempt += 1
      continue
    }
    if (response.status >= 400) throw options.errorOf(response, await response.text())
    const read = options.read ?? 'json'
    // The reads that do not consume the body still have to release it, or
    // Node/undici holds the connection until GC; python's api_request drains
    // it the same way when its `async with` response context exits.
    if (read === 'none') {
      await response.arrayBuffer()
      return null
    }
    if (read === 'location') {
      const location = response.headers.get('Location')
      await response.arrayBuffer()
      return location
    }
    if (read === 'bytes') {
      const data = new Uint8Array(await response.arrayBuffer())
      return windowOf(data, response.status, options.window)
    }
    const text = await response.text()
    if (read === 'text') return text
    if (read === 'response') {
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value
      })
      let data: unknown = null
      if (text !== '') {
        try {
          data = JSON.parse(text) as unknown
        } catch {
          data = text
        }
      }
      return { data, status: response.status, headers } satisfies ApiResponse
    }
    return text === '' ? null : (JSON.parse(text) as unknown)
  }
}

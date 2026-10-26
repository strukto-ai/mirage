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

import { sleep } from '../../utils/abort.ts'
import { type ByteWindow, rangeHeader } from '../../utils/ranges.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { CHUNK_SIZE, chunks } from '../../io/cooperative.ts'
import { DEFAULT_TIMEOUT } from './constants.ts'
import { ResponseTooLargeError } from './errors.ts'

export const MAX_BODY_BYTES = 64 * 1024 * 1024

// How a >= 400 API response and its body text become the backend's own
// error; the engine here calls it, each backend supplies one.
export type ErrorOf = (response: Response, body: string) => Error

/**
 * `fetchFn` (the global fetch, read per call, when absent) bounded by how
 * long a request may wait on the server: to connect and answer, then for
 * each chunk of the body the caller asks for. The clock restarts when the
 * headers arrive and on every chunk, and stops while the caller is not
 * reading, once the body ends and when the caller cancels it, so a download
 * that keeps flowing is never cut off. A request that waits longer fails
 * with a `TimeoutError` DOMException. Python's twin is `stall_timeout`,
 * which aiohttp spells as sock_connect and sock_read; `seconds` of 0 is no
 * bound.
 */
export function stallFetch(seconds: number, fetchFn?: typeof fetch): typeof fetch {
  const send: typeof fetch = fetchFn ?? ((input, init) => fetch(input, init))
  if (!(seconds > 0)) return send
  return async (input, init) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      clearTimeout(timer)
    }
    const arm = (): void => {
      stop()
      timer = setTimeout(
        () => {
          controller.abort(
            new DOMException(`no progress for ${String(seconds)}s`, 'TimeoutError'),
          )
        },
        Math.min(seconds * 1000, 2 ** 31 - 1),
      )
    }
    const timedOut = (err: unknown): unknown =>
      controller.signal.aborted ? controller.signal.reason : err
    const signal =
      init?.signal == null ? controller.signal : AbortSignal.any([init.signal, controller.signal])
    arm()
    let response: Response
    try {
      response = await send(input, { ...init, signal })
    } catch (err) {
      throw timedOut(err)
    } finally {
      stop()
    }
    if (response.body === null) return response
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(sink) {
          arm()
          try {
            const result = await reader.read()
            if (result.done) sink.close()
            else sink.enqueue(result.value)
          } catch (err) {
            throw timedOut(err)
          } finally {
            stop()
          }
        },
        cancel(reason) {
          stop()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * Pull a GET response in bounded chunks, cancelling its body on early exit.
 * `retry` applies to opening the response only: once a chunk has reached the
 * caller a failure propagates, since a second attempt would hand it the same
 * bytes twice.
 */
export async function* apiStream(
  url: string,
  options: Pick<
    ApiRequestOptions,
    'errorOf' | 'headers' | 'fetchFn' | 'retry' | 'sleep' | 'timeout'
  > & {
    signal?: AbortSignal
    /** Told the answering response's headers, lower-cased, once and before
     * the first chunk, so an empty body reports them too. */
    onResponse?: (headers: Record<string, string>) => void
  },
): AsyncGenerator<Uint8Array, void> {
  const retry = options.retry ?? NO_RETRY
  const wait = options.sleep ?? ((seconds: number) => sleep(seconds * 1000, options.signal))
  const doFetch = stallFetch(options.timeout ?? DEFAULT_TIMEOUT, options.fetchFn)
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= retry.maxRetries
    let response: Response
    try {
      response = await doFetch(url, {
        method: 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (err) {
      // a caller's abort is not a transport failure worth another attempt
      if (last || retry.retryTransport !== true || options.signal?.aborted === true) throw err
      await wait(Math.min(2 ** attempt, retry.maxBackoff))
      continue
    }
    let text = ''
    let chunksOf: AsyncGenerator<Uint8Array, void> | null = null
    let first: IteratorResult<Uint8Array, void> | null = null
    // Reading the error body or the first chunk is still opening the
    // response: nothing has reached the caller, so a drop here retries.
    try {
      if (response.status >= 400) text = await response.text()
      else if (response.body !== null) {
        chunksOf = bodyChunks(response.body, options.signal)
        first = await chunksOf.next()
      }
    } catch (err) {
      if (last || retry.retryTransport !== true || options.signal?.aborted === true) throw err
      await wait(Math.min(2 ** attempt, retry.maxBackoff))
      continue
    }
    if (response.status >= 400) {
      if (last || !worthRetrying(response.status, text, retry)) {
        throw options.errorOf(response, text)
      }
      await wait(retryDelay(response, text, attempt, retry))
      continue
    }
    options.onResponse?.(loweredHeaders(response.headers))
    if (chunksOf === null || first === null || first.done === true) return
    try {
      yield first.value
      yield* chunksOf
    } finally {
      // a caller that stops at the first chunk never entered the delegation,
      // so the body is released here rather than by it
      await chunksOf.return()
    }
    return
  }
}

/** Pull a response body in bounded chunks, cancelling it on early exit. */
export async function* bodyChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void> {
  const reader = body.getReader()
  let finished = false
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) {
        finished = true
        return
      }
      yield* chunks(result.value, signal)
    }
  } finally {
    try {
      if (!finished) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

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
  /**
   * A veto over a listed status, given the status and the body text, for
   * an API whose one status means two things. Airtable answers both "slow
   * down" and "monthly quota spent" with a 429, and only the first is worth
   * waiting for; a vetoed response maps through `errorOf` at once. Absent
   * retries every listed status.
   */
  readonly retryable?: (status: number, text: string) => boolean
  /**
   * Per-status floor under the wait, for an API that documents a penalty
   * window: after a 429, Airtable refuses every request for 30 seconds, so
   * a shorter backoff only spends the retries inside the window.
   * `maxBackoff` still caps the result.
   */
  readonly minDelays?: Readonly<Record<number, number>>
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
 * 'location' returns the Location header; 'response' returns the decoded body
 * with status and lower-cased headers; 'bytes_response' returns the 'bytes'
 * body with the same status and headers, for a caller that needs a content
 * token the response carries.
 */
export type ReadMode =
  | 'json'
  | 'none'
  | 'bytes'
  | 'bytes_response'
  | 'text'
  | 'location'
  | 'response'

/**
 * `base` and `path` joined by one slash, with each defined `query` entry
 * URI-encoded onto the end; an undefined value is left out.
 */
export function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const trimmed = rstripSlash(base)
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const params: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    params.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : ''
  return `${trimmed}${cleanPath}${qs}`
}

/**
 * A response's headers as a plain record, names lower-cased; fetch already
 * joins a repeated header, as python's lowered_headers does.
 */
export function loweredHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value
  })
  return out
}

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
  /** Maximum decoded bytes retained by successful bytes/bytes_response reads.
   * Defaults to 64 MiB; use a stream for larger downloads. Ignored Range
   * prefixes do not count, and overflow fails rather than truncates. */
  maxBodyBytes?: number | undefined
  /** Seconds a request may wait to connect, or between two reads of its
   * response, before it fails (`stallFetch`); 0 is no bound, absent is
   * `DEFAULT_TIMEOUT`. */
  timeout?: number | undefined
  /** The fetch to use, so transports keep their injection seam. */
  fetchFn?: typeof fetch | undefined
  /** The wait between attempts, in seconds, injectable so a test or a
   * simulated clock spends no real time; absent is a real timer. */
  sleep?: ((seconds: number) => Promise<void>) | undefined
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

export function bodyDelay(text: string, retry: RetryPolicy): number {
  let data: unknown = {}
  try {
    data = JSON.parse(text) as unknown
  } catch {
    data = {}
  }
  const value =
    typeof data === 'object' && data !== null
      ? (data as { retry_after?: unknown }).retry_after
      : undefined
  // JSON.parse rejects a bare NaN literal but overflows 1e999 to Infinity,
  // so a body delay needs the same guard as a header one.
  return typeof value === 'number' && usableDelay(value)
    ? Math.min(value, retry.maxBackoff)
    : Math.min(1, retry.maxBackoff)
}

/** Raise a wait to the policy's floor for this status, then cap it. */
export function flooredDelay(delay: number, status: number, retry: RetryPolicy): number {
  const floor = retry.minDelays?.[status]
  if (floor === undefined) return delay
  return Math.min(Math.max(delay, floor), retry.maxBackoff)
}

function worthRetrying(status: number, text: string, retry: RetryPolicy): boolean {
  return (
    retry.statuses.has(status) && (retry.retryable === undefined || retry.retryable(status, text))
  )
}

function retryDelay(response: Response, text: string, attempt: number, retry: RetryPolicy): number {
  const delay =
    retry.delaySource === 'body' ? bodyDelay(text, retry) : headerDelay(response, attempt, retry)
  return flooredDelay(delay, response.status, retry)
}

/** Collect a bounded byte response, discarding an ignored Range prefix. */
export async function readBytes(
  response: Pick<Response, 'body' | 'status'>,
  window: ByteWindow | undefined,
  maxBodyBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) return new Uint8Array()
  const ranged = response.status === 206
  let skip = ranged ? 0 : (window?.offset ?? 0)
  const size = window?.size
  const limit = size === undefined || size === null ? maxBodyBytes : Math.min(size, maxBodyBytes)
  let data = new Uint8Array()
  let length = 0
  for await (const chunk of bodyChunks(response.body)) {
    const skipped = Math.min(skip, chunk.length)
    skip -= skipped
    const available = chunk.subarray(skipped)
    const take =
      !ranged && size != null ? Math.min(available.length, size - length) : available.length
    if (length + take > limit) throw new ResponseTooLargeError(limit)
    if (take > 0) {
      const needed = length + take
      if (needed > data.length) {
        const capacity = Math.min(limit, Math.max(CHUNK_SIZE, needed, data.length * 2))
        const grown = new Uint8Array(capacity)
        grown.set(data)
        data = grown
      }
      data.set(available.subarray(0, take), length)
      length = needed
    }
    if (!ranged && size != null && length === size) break
  }
  return data.slice(0, length)
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
  const { maxBodyBytes = MAX_BODY_BYTES } = options
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError('max_body_bytes must be a non-negative safe integer')
  }
  const doFetch = stallFetch(options.timeout ?? DEFAULT_TIMEOUT, options.fetchFn)
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
  const wait = options.sleep ?? ((seconds: number) => sleep(seconds * 1000))
  const read = options.read ?? 'json'
  const asBytes = read === 'bytes' || read === 'bytes_response'
  const discard = read === 'none' || read === 'location'
  let attempt = 0
  for (;;) {
    const init: RequestInit = { method, headers: { ...headers } }
    if (options.json !== undefined) init.body = JSON.stringify(options.json)
    else if (options.body !== undefined) init.body = options.body
    let response: Response
    try {
      response = await doFetch(target.toString(), init)
    } catch (err) {
      // a rejection is connection-level: HTTP errors resolve normally
      if (retry.retryTransport === true && attempt < retry.maxRetries) {
        await wait(Math.min(2 ** attempt, retry.maxBackoff))
        attempt += 1
        continue
      }
      throw err
    }
    let text = ''
    let data = new Uint8Array()
    // A body that drops mid-read is a transport failure like one before the
    // answer: a policy with retryTransport resends on either, so a write that
    // must never repeat rides a policy without it. Nothing past this block
    // touches the network.
    try {
      if (response.status >= 400 || (!asBytes && !discard)) text = await response.text()
      else if (discard) await response.body?.cancel()
      else data = await readBytes(response, options.window, maxBodyBytes)
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err
      if (retry.retryTransport === true && attempt < retry.maxRetries) {
        await wait(Math.min(2 ** attempt, retry.maxBackoff))
        attempt += 1
        continue
      }
      throw err
    }
    if (retry.statuses.has(response.status)) {
      if (worthRetrying(response.status, text, retry) && attempt < retry.maxRetries) {
        await wait(retryDelay(response, text, attempt, retry))
        attempt += 1
        continue
      }
      // retries ran dry or were vetoed: the final retryable response maps
      // through the same hook a plain error status does
      throw options.errorOf(response, text)
    }
    if (response.status >= 400) throw options.errorOf(response, text)
    if (read === 'none') return null
    if (read === 'location') return response.headers.get('Location')
    if (read === 'bytes') return data
    if (read === 'bytes_response') {
      return {
        data,
        status: response.status,
        headers: loweredHeaders(response.headers),
      } satisfies ApiResponse
    }
    if (read === 'text') return text
    if (read === 'response') {
      let decoded: unknown = null
      if (text !== '') {
        try {
          decoded = JSON.parse(text) as unknown
        } catch {
          decoded = text
        }
      }
      return {
        data: decoded,
        status: response.status,
        headers: loweredHeaders(response.headers),
      } satisfies ApiResponse
    }
    return text === '' ? null : (JSON.parse(text) as unknown)
  }
}

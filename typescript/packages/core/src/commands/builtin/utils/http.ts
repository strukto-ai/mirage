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

// This layer reports what the server said and never decides whether that is an
// error: curl treats a 404 as a successful transfer (exit 0, body on stdout)
// while wget treats it as exit 8, so the status has to reach the command. An
// earlier version threw on !resp.ok here, which made both tools fail on any
// 4xx and leaked 'fetch failed' onto stderr for a refused connection.

import { callerSignal, currentCaller } from '../../../context/session_context.ts'
import { networkPolicies } from '../../../io/network.ts'
import { primeStream } from '../../../io/stream.ts'
import type { ByteSource } from '../../../io/types.ts'
import { PolicyDenied } from '../../../policy/errors.ts'
import { type Policies, postNetworkGate, preNetworkGate } from '../../../policy/policies.ts'
import type { NetworkContext } from '../../../policy/types.ts'
import { makeAbortError, mergeSignals } from '../../../utils/abort.ts'
import { HttpConnectError, HttpTimeoutError } from '../errors.ts'
import { HTTP_TIMEOUT_SECONDS } from './constants.ts'
import { type CookieJar, cookieValue, sameOrigin } from './cookie.ts'

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; mirage/1.0)'
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

export interface HttpResponse {
  status: number
  reason: string
  // Whole for every redirect hop; the final hop's arrives as it is read when
  // the request asked for a stream.
  body: ByteSource
  // The URL this hop was asked for and the method the client sent for it:
  // a redirect can move both (a POST becomes a GET on 301, 302 and 303, in
  // fetch as in curl).
  url: string
  method: string
  // Wire order, repeats kept; names arrive lowercased, which is all the
  // Headers class ever exposes.
  headers: [string, string][]
  // The redirect responses followed on the way here, in order; empty when
  // none was followed. curl -i and -v show every hop.
  history: HttpResponse[]
}

// A chain past this many hops reads as a loop. undici's own limit, and the
// connect failure is what its native following reported at it.
const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// The Fetch standard's rule, which curl shares by default: 303 answers with
// a GET for anything but HEAD, 301 and 302 turn a POST into a GET, and 307
// and 308 keep the method and its body.
function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET'
  if ((status === 301 || status === 302) && method === 'POST') return 'GET'
  return method
}

function nextHop(location: string, current: string): { url: string; sameOrigin: boolean } | null {
  try {
    const from = new URL(current)
    const to = new URL(location, from)
    return { url: to.href, sameOrigin: to.origin === from.origin }
  } catch {
    return null
  }
}

function hopOf(resp: Response, url: string, method: string, body: ByteSource): HttpResponse {
  return {
    status: resp.status,
    reason: resp.statusText,
    body,
    url,
    method,
    headers: [...resp.headers.entries()],
    history: [],
  }
}

export function isHttpError(resp: HttpResponse): boolean {
  return resp.status >= 400
}

function endpoint(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url)
    const port = parsed.port !== '' ? Number(parsed.port) : (DEFAULT_PORTS[parsed.protocol] ?? 80)
    return { host: parsed.hostname, port }
  } catch {
    return { host: url, port: 80 }
  }
}

// A fetch that does not verify the server's certificate, which curl's -k
// asks for. fetch itself takes no TLS options, so this runtime-agnostic core
// cannot build one; a host that can registers it (the node package: undici
// over an agent with `rejectUnauthorized: false`). The browser registers
// none, since the platform always verifies, so there -k still verifies.
let insecureFetch: typeof fetch | null = null

export function registerInsecureFetch(fn: typeof fetch | null): void {
  insecureFetch = fn
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array
  // Milliseconds before the request is abandoned; null is no deadline at
  // all (curl's `--max-time 0`).
  timeoutMs?: number | null
  followRedirects?: boolean
  // False skips certificate verification (curl's -k), where the host
  // registered a fetch that can (`registerInsecureFetch`).
  verify?: boolean
  // The invocation's cancellation, which aborts the request with it.
  signal?: AbortSignal
  // The jar every hop sends from and keeps the Set-Cookie headers in. A
  // Cookie header among `headers` rides after the jar's, on the hops that
  // stay on the first origin. A deliberate divergence the browser forces:
  // its fetch drops a Cookie header and hides Set-Cookie, so there the jar
  // sends and keeps nothing.
  cookies?: CookieJar
  // Hand the final body over as it arrives instead of holding all of it
  // first, so a download costs one chunk of memory however large it is.
  stream?: boolean
}

// What a failed transfer is reported as. Past a canceled invocation, the only
// abort is the deadline, which curl answers with its own code (28), so it is
// told apart from a connection that never opened.
function failure(
  err: unknown,
  caller: AbortSignal | undefined,
  url: string,
  started: number,
): Error {
  if (caller?.aborted === true) return makeAbortError(caller)
  const { host, port } = endpoint(url)
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new HttpTimeoutError(host, port, Date.now() - started)
  }
  return new HttpConnectError(host, port)
}

// postNetwork once the transfer ends, however it ends: a refusal of one that
// worked fails it as a broken transfer does.
async function ended(
  judges: Policies | null,
  asked: NetworkContext,
  status: number,
  size: number,
  failed: boolean,
): Promise<void> {
  try {
    await postNetworkGate(judges, { ...asked, status, size, failed })
  } catch (err) {
    if (!(err instanceof PolicyDenied)) throw err
    if (!failed) throw new HttpConnectError(asked.host, asked.port)
  }
}

// The body as it arrives, under the same deadline and with the same failures
// as the request; the deadline ends with it, and letting it go cancels the
// rest of the transfer.
async function* streamed(
  resp: Response,
  url: string,
  caller: AbortSignal | undefined,
  started: number,
  timer: ReturnType<typeof setTimeout> | null,
  judges: Policies | null,
  asked: NetworkContext,
): AsyncGenerator<Uint8Array> {
  const reader = resp.body?.getReader()
  let size = 0
  // Whether the transfer reached its end or broke off; neither when the
  // reader let it go first.
  let over = false
  try {
    if (reader !== undefined) {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>
        try {
          step = await reader.read()
        } catch (err) {
          over = true
          await ended(judges, asked, resp.status, size, true)
          throw failure(err, caller, url, started)
        }
        if (step.done) break
        size += step.value.byteLength
        yield step.value
      }
    }
    over = true
  } finally {
    if (timer !== null) clearTimeout(timer)
    await reader?.cancel().catch((err: unknown) => {
      console.debug('body cancel failed:', err)
    })
    if (!over) await ended(judges, asked, resp.status, size, true)
  }
  await ended(judges, asked, resp.status, size, false)
}

async function doFetch(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  // The policies of the line sending it judge the request before any
  // connection opens; a refusal reads as a port that would not open.
  const judges = networkPolicies()
  const first = endpoint(url)
  const sender = currentCaller()
  const asked: NetworkContext = {
    url,
    method: options.method ?? 'GET',
    host: first.host,
    port: first.port,
    command: sender.command ?? '',
    sessionId: sender.session?.sessionId ?? '',
  }
  try {
    await preNetworkGate(judges, asked)
  } catch (err) {
    if (err instanceof PolicyDenied) throw new HttpConnectError(first.host, first.port)
    throw err
  }
  const timeoutMs =
    options.timeoutMs === undefined ? HTTP_TIMEOUT_SECONDS * 1000 : options.timeoutMs
  const send = options.verify === false && insecureFetch !== null ? insecureFetch : fetch
  const started = Date.now()
  // What the invocation answers to: its own signal and the call's (a line's
  // stop, a job's kill or limit), so a stopped CLI that reaches here (git)
  // ends its request as Python's cancelled task does.
  const caller = mergeSignals(options.signal, callerSignal())
  const controller = new AbortController()
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          controller.abort()
        }, timeoutMs)
  // A streamed body takes the deadline with it.
  let handed = false
  try {
    // Header names are case-insensitive, so a `user-agent` the caller set
    // replaces the default rather than riding beside it.
    const given = options.headers ?? {}
    let headers: Record<string, string> = Object.keys(given).some(
      (name) => name.toLowerCase() === 'user-agent',
    )
      ? { ...given }
      : { 'User-Agent': DEFAULT_USER_AGENT, ...given }
    const follow = options.followRedirects !== false
    // Redirects are followed by hand so every hop stays observable, the way
    // httpx keeps `response.history` for the python twin; one deadline
    // spans the whole chain, as curl's --max-time does.
    const history: HttpResponse[] = []
    let current = url
    let method = options.method ?? 'GET'
    let body = options.body
    const typed = Object.entries(headers).find(([name]) => name.toLowerCase() === 'cookie')?.[1]
    for (;;) {
      let sent = headers
      if (options.cookies !== undefined) {
        const value = cookieValue(
          options.cookies.header(current),
          sameOrigin(current, url) ? (typed ?? null) : null,
        )
        sent = Object.fromEntries(
          Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie'),
        )
        if (value !== null) sent.Cookie = value
      }
      const init: RequestInit = {
        method,
        headers: sent,
        signal: mergeSignals(controller.signal, caller) ?? controller.signal,
        redirect: 'manual',
      }
      if (body !== undefined) {
        init.body = body as BodyInit
      }
      let resp: Response
      try {
        resp = await send(current, init)
        if (follow && resp.type === 'opaqueredirect') {
          // A browser answers a manual redirect with an opaque one: status
          // 0, no headers, no Location, so the hops cannot be walked here.
          // The platform follows them instead and the history stays empty,
          // a deliberate divergence from curl, whose -iL shows every hop.
          resp = await send(current, { ...init, redirect: 'follow' })
        }
        // The cookies count once the headers are in, as curl keeps them: a
        // body that then fails still leaves them in the jar.
        options.cookies?.store(
          current,
          [...resp.headers.entries()]
            .filter(([name]) => name === 'set-cookie')
            .map(([, value]) => value),
        )
      } catch (err) {
        // A transport failure carries no status.
        await ended(judges, asked, 0, 0, true)
        throw failure(err, caller, current, started)
      }
      const location = resp.headers.get('location')
      const next =
        follow && REDIRECT_STATUSES.has(resp.status) && location !== null
          ? nextHop(location, current)
          : null
      if (next === null && options.stream === true) {
        const body = await primeStream(
          streamed(resp, current, caller, started, timer, judges, asked),
        )
        handed = true
        return { ...hopOf(resp, current, method, body), history }
      }
      let buf: ArrayBuffer
      try {
        // The deadline can fire while the body is still arriving, so the
        // body is read under the same failures, as httpx reads it inside
        // the request the python twin wraps.
        buf = await resp.arrayBuffer()
      } catch (err) {
        await ended(judges, asked, resp.status, 0, true)
        throw failure(err, caller, current, started)
      }
      const hop = hopOf(resp, current, method, new Uint8Array(buf))
      if (next === null) {
        await ended(judges, asked, resp.status, buf.byteLength, false)
        return { ...hop, history }
      }
      if (history.length >= MAX_REDIRECTS) {
        const { host, port } = endpoint(current)
        throw new HttpConnectError(host, port)
      }
      history.push(hop)
      if (!next.sameOrigin) {
        // Credentials stay with the host they were typed for, as the native
        // follow and curl (without --location-trusted) both keep them: the
        // Authorization and the Cookie header a line typed.
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) => !['authorization', 'cookie'].includes(name.toLowerCase()),
          ),
        )
      }
      const switched = redirectMethod(resp.status, method)
      if (switched !== method) body = undefined
      method = switched
      current = next.url
    }
  } finally {
    if (!handed && timer !== null) clearTimeout(timer)
  }
}

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const method = options.method ?? 'GET'
  return doFetch(url, { ...options, method })
}

export function httpFormRequest(
  url: string,
  opts: {
    method?: string
    formData?: Record<string, string>
    headers?: Record<string, string>
    timeoutMs?: number | null
    followRedirects?: boolean
    verify?: boolean
    signal?: AbortSignal
    cookies?: CookieJar
    stream?: boolean
  } = {},
): Promise<HttpResponse> {
  const method = opts.method ?? 'POST'
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.formData ?? {})) {
    form.append(k, v)
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(opts.headers ?? {}),
  }
  return doFetch(url, {
    method,
    headers,
    body: new TextEncoder().encode(form.toString()),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.followRedirects !== undefined ? { followRedirects: opts.followRedirects } : {}),
    ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
  })
}

export function httpGet(
  url: string,
  opts: {
    headers?: Record<string, string>
    timeoutMs?: number | null
    signal?: AbortSignal
    stream?: boolean
  } = {},
): Promise<HttpResponse> {
  const options: HttpRequestOptions = { method: 'GET' }
  if (opts.headers !== undefined) options.headers = opts.headers
  if (opts.timeoutMs !== undefined) options.timeoutMs = opts.timeoutMs
  if (opts.signal !== undefined) options.signal = opts.signal
  if (opts.stream !== undefined) options.stream = opts.stream
  return httpRequest(url, options)
}

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

import { HttpConnectError, HttpTimeoutError } from '../errors.ts'

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; mirage/1.0)'
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

export interface HttpResponse {
  status: number
  reason: string
  body: Uint8Array
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

function hopOf(resp: Response, url: string, method: string, buf: ArrayBuffer): HttpResponse {
  return {
    status: resp.status,
    reason: resp.statusText,
    body: new Uint8Array(buf),
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

let httpProxyBase: string | null = null

export function setHttpProxyBase(base: string | null): void {
  httpProxyBase = base
}

function applyProxy(url: string): string {
  if (httpProxyBase === null) return url
  if (url.startsWith(httpProxyBase) || url.startsWith('/')) return url
  const sep = httpProxyBase.includes('?') ? '&' : '?'
  return `${httpProxyBase}${sep}url=${encodeURIComponent(url)}`
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array
  // Milliseconds before the request is abandoned; null is no deadline at
  // all (curl's `--max-time 0`).
  timeoutMs?: number | null
  followRedirects?: boolean
}

async function doFetch(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
  const started = Date.now()
  const controller = new AbortController()
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          controller.abort()
        }, timeoutMs)
  try {
    let headers: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      ...(options.headers ?? {}),
    }
    const follow = options.followRedirects !== false
    // Redirects are followed by hand so every hop stays observable, the way
    // httpx keeps `response.history` for the python twin; one deadline
    // spans the whole chain, as curl's --max-time does.
    const history: HttpResponse[] = []
    let current = url
    let method = options.method ?? 'GET'
    let body = options.body
    for (;;) {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      }
      if (body !== undefined) {
        init.body = body as BodyInit
      }
      let resp: Response
      let buf: ArrayBuffer
      try {
        resp = await fetch(applyProxy(current), init)
        if (follow && resp.type === 'opaqueredirect') {
          // A browser answers a manual redirect with an opaque one: status
          // 0, no headers, no Location, so the hops cannot be walked here.
          // The platform follows them instead and the history stays empty,
          // a deliberate divergence from curl, whose -iL shows every hop.
          resp = await fetch(applyProxy(current), { ...init, redirect: 'follow' })
        }
        // The deadline can fire while the body is still arriving, so the
        // body is read inside the same catch, as httpx reads it inside the
        // request the python twin wraps.
        buf = await resp.arrayBuffer()
      } catch (err) {
        // A transport failure carries no status. The only abort here is the
        // deadline above, which curl answers with its own code (28), so it
        // is told apart from a connection that never opened.
        const { host, port } = endpoint(current)
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new HttpTimeoutError(host, port, Date.now() - started)
        }
        throw new HttpConnectError(host, port)
      }
      const hop = hopOf(resp, current, method, buf)
      const location = resp.headers.get('location')
      const next =
        follow && REDIRECT_STATUSES.has(resp.status) && location !== null
          ? nextHop(location, current)
          : null
      if (next === null) return { ...hop, history }
      if (history.length >= MAX_REDIRECTS) {
        const { host, port } = endpoint(current)
        throw new HttpConnectError(host, port)
      }
      history.push(hop)
      if (!next.sameOrigin) {
        // Credentials stay with the host they were typed for, as the native
        // follow and curl (without --location-trusted) both keep them.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
        )
      }
      const switched = redirectMethod(resp.status, method)
      if (switched !== method) body = undefined
      method = switched
      current = next.url
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
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
  })
}

export function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const options: HttpRequestOptions = { method: 'GET' }
  if (opts.headers !== undefined) options.headers = opts.headers
  if (opts.timeoutMs !== undefined) options.timeoutMs = opts.timeoutMs
  return httpRequest(url, options)
}

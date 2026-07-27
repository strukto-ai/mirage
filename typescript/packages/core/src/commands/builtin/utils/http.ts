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

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; mirage/1.0)'
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

export interface HttpResponse {
  status: number
  reason: string
  body: Uint8Array
  url: string
}

export function isHttpError(resp: HttpResponse): boolean {
  return resp.status >= 400
}

/**
 * The request never got an HTTP response. Carries the host and port rather
 * than the platform's error text, which differs between runtimes and
 * platforms and so cannot be asserted in a cross-language test.
 */
export class HttpConnectError extends Error {
  readonly host: string
  readonly port: number

  constructor(host: string, port: number) {
    super(`Failed to connect to ${host} port ${String(port)}`)
    this.name = 'HttpConnectError'
    this.host = host
    this.port = port
  }
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
  timeoutMs?: number
  followRedirects?: boolean
}

async function doFetch(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  const method = options.method ?? 'GET'
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      ...(options.headers ?? {}),
    }
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
    }
    if (options.body !== undefined) {
      init.body = options.body as BodyInit
    }
    let resp: Response
    try {
      resp = await fetch(applyProxy(url), init)
    } catch (err) {
      // A transport failure carries no status. Abort (the timeout) has to
      // propagate as itself so the safeguard layer can report it.
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      const { host, port } = endpoint(url)
      throw new HttpConnectError(host, port)
    }
    const buf = await resp.arrayBuffer()
    return {
      status: resp.status,
      reason: resp.statusText,
      body: new Uint8Array(buf),
      url,
    }
  } finally {
    clearTimeout(timer)
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
    timeoutMs?: number
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

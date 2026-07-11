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

const JINA_READER_PREFIX = 'https://r.jina.ai/'
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; mirage/1.0)'

function toJinaUrl(url: string): string {
  if (url.startsWith(JINA_READER_PREFIX)) return url
  return `${JINA_READER_PREFIX}${url}`
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
  jina?: boolean
  followRedirects?: boolean
}

async function doFetch(url: string, options: HttpRequestOptions): Promise<Uint8Array> {
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
    const resp = await fetch(applyProxy(url), init)
    if (!resp.ok) {
      throw new Error(`HTTP ${String(resp.status)} ${resp.statusText}`)
    }
    const buf = await resp.arrayBuffer()
    return new Uint8Array(buf)
  } finally {
    clearTimeout(timer)
  }
}

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<Uint8Array> {
  const method = options.method ?? 'GET'
  const resolved =
    options.jina === true && method === 'GET' && options.body === undefined ? toJinaUrl(url) : url
  return doFetch(resolved, { ...options, method })
}

export function httpFormRequest(
  url: string,
  opts: {
    method?: string
    formData?: Record<string, string>
    headers?: Record<string, string>
    timeoutMs?: number
  } = {},
): Promise<Uint8Array> {
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
  })
}

export function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; jina?: boolean } = {},
): Promise<Uint8Array> {
  const options: HttpRequestOptions = { method: 'GET' }
  if (opts.headers !== undefined) options.headers = opts.headers
  if (opts.timeoutMs !== undefined) options.timeoutMs = opts.timeoutMs
  if (opts.jina !== undefined) options.jina = opts.jina
  return httpRequest(url, options)
}

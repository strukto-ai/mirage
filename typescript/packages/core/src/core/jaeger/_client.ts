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

import { rstripSlash } from '../../utils/slash.ts'

const TRACE_ID_RE = /^[0-9a-f]{16}$|^[0-9a-f]{32}$/i

// Jaeger's own query service self-instruments, so a `jaeger` service shows up
// in listings alongside the ones a user actually sent.
export class JaegerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'JaegerApiError'
  }
}

/**
 * Report whether a name is a syntactically valid Jaeger trace id.
 *
 * Checked before calling the API so a malformed id becomes ENOENT instead of
 * the API's 400 "invalid length for TraceID".
 */
export function isTraceId(value: string): boolean {
  return TRACE_ID_RE.test(value)
}

export interface JaegerTransport {
  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>
}

export interface HttpJaegerTransportOptions {
  host?: string
  // Seconds, mirroring python's JaegerConfig.request_timeout and the
  // requestTimeout config field it is normalized from.
  timeout?: number
}

const DEFAULT_TIMEOUT_SECONDS = 30

function buildUrl(
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

function errorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    const errors = (body as Record<string, unknown>).errors
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as Record<string, unknown> | undefined
      const msg = first?.msg
      if (typeof msg === 'string' && msg !== '') return msg
    }
  }
  return `Jaeger API error: HTTP ${String(status)}`
}

export class HttpJaegerTransport implements JaegerTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)
  private readonly host: string
  private readonly timeoutSeconds: number

  constructor(opts: HttpJaegerTransportOptions = {}) {
    this.host = opts.host ?? 'http://localhost:16686'
    this.timeoutSeconds = opts.timeout ?? DEFAULT_TIMEOUT_SECONDS
  }

  async request(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    // Without a deadline a stalled Jaeger endpoint hangs the command forever;
    // python gets this from the httpx timeout.
    const res = await this.fetch(buildUrl(this.host, path, query), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new JaegerApiError(`Jaeger API: invalid JSON: ${msg}`, res.status)
    }
    if (res.status >= 400) throw new JaegerApiError(errorMessage(body, res.status), res.status)
    return body
  }
}

function dataList(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object') return []
  const data = (body as Record<string, unknown>).data
  return Array.isArray(data) ? data : []
}

function micros(iso: string | undefined, fallback: number): number {
  if (iso === undefined || iso === '') return fallback
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return fallback
  return parsed * 1000
}

export async function fetchServices(transport: JaegerTransport): Promise<string[]> {
  const body = await transport.request('/api/services')
  return dataList(body).map((name) => String(name))
}

/**
 * List operations recorded for a service.
 *
 * An unknown service yields an empty list rather than an error, so callers
 * that need existence semantics must check the service list first.
 */
export async function fetchOperations(
  transport: JaegerTransport,
  service: string,
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/operations', { service })
  return dataList(body).filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  )
}

export interface FetchTracesOptions {
  limit?: number
  fromTimestamp?: string
  toTimestamp?: string
}

/**
 * Search traces for a service within an explicit time window.
 *
 * `service` is required by the API and `lookback` is ignored, so the window is
 * always sent as explicit microsecond bounds.
 */
export async function fetchTraces(
  transport: JaegerTransport,
  service: string,
  opts: FetchTracesOptions = {},
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/traces', {
    service,
    limit: opts.limit ?? 100,
    start: micros(opts.fromTimestamp, 0),
    end: micros(opts.toTimestamp, Date.now() * 1000),
  })
  return dataList(body).filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  )
}

export async function fetchTrace(
  transport: JaegerTransport,
  traceId: string,
): Promise<Record<string, unknown>> {
  const body = await transport.request(`/api/traces/${encodeURIComponent(traceId)}`)
  const traces = dataList(body).filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  )
  const first = traces[0]
  if (first === undefined) throw new JaegerApiError('trace not found', 404)
  return first
}

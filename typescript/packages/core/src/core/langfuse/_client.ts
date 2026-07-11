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

export class LangfuseApiError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly unknown[] = [],
    public readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'LangfuseApiError'
  }
}

export interface LangfuseTransport {
  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>
}

export interface HttpLangfuseTransportOptions {
  publicKey: string
  secretKey: string
  host?: string
}

function encodeBasicAuth(publicKey: string, secretKey: string): string {
  const raw = `${publicKey}:${secretKey}`
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(raw)
  const buf = (globalThis as { Buffer?: { from(s: string): { toString(enc: string): string } } })
    .Buffer
  if (buf !== undefined) return buf.from(raw).toString('base64')
  throw new LangfuseApiError('no base64 encoder available')
}

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

export class HttpLangfuseTransport implements LangfuseTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)
  private readonly host: string
  private readonly auth: string

  constructor(opts: HttpLangfuseTransportOptions) {
    this.host = opts.host ?? 'https://cloud.langfuse.com'
    this.auth = encodeBasicAuth(opts.publicKey, opts.secretKey)
  }

  async request(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const url = buildUrl(this.host, path, query)
    const res = await this.fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
      },
    })
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new LangfuseApiError(`Langfuse API: invalid JSON: ${msg}`, [], res.status)
    }
    if (res.status >= 400) {
      const message =
        body !== null && typeof body === 'object' && 'message' in body
          ? String((body as Record<string, unknown>).message)
          : `Langfuse API error: HTTP ${String(res.status)}`
      throw new LangfuseApiError(message, [], res.status)
    }
    return body
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value as Record<string, unknown>[]
  return []
}

function getData(body: unknown): Record<string, unknown>[] {
  if (body === null || typeof body !== 'object') return []
  const data = (body as Record<string, unknown>).data
  return asArray(data)
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export interface FetchTracesOptions {
  limit?: number
  name?: string | null
  userId?: string | null
  sessionId?: string | null
  orderBy?: string | null
  fromTimestamp?: string | null
  toTimestamp?: string | null
}

const TRACES_PAGE_SIZE = 100

export async function fetchTraces(
  transport: LangfuseTransport,
  opts: FetchTracesOptions = {},
): Promise<Record<string, unknown>[]> {
  const total = opts.limit ?? TRACES_PAGE_SIZE
  const base: Record<string, string | number | undefined> = {}
  if (opts.name !== undefined && opts.name !== null && opts.name !== '') base.name = opts.name
  if (opts.userId !== undefined && opts.userId !== null && opts.userId !== '') {
    base.userId = opts.userId
  }
  if (opts.sessionId !== undefined && opts.sessionId !== null && opts.sessionId !== '') {
    base.sessionId = opts.sessionId
  }
  if (opts.orderBy !== undefined && opts.orderBy !== null && opts.orderBy !== '') {
    base.orderBy = opts.orderBy
  }
  if (
    opts.fromTimestamp !== undefined &&
    opts.fromTimestamp !== null &&
    opts.fromTimestamp !== ''
  ) {
    base.fromTimestamp = opts.fromTimestamp
  }
  if (opts.toTimestamp !== undefined && opts.toTimestamp !== null && opts.toTimestamp !== '') {
    base.toTimestamp = opts.toTimestamp
  }
  const out: Record<string, unknown>[] = []
  let page = 1
  while (out.length < total) {
    const remaining = total - out.length
    const pageLimit = Math.min(TRACES_PAGE_SIZE, remaining)
    const body = await transport.request('/api/public/traces', {
      ...base,
      limit: pageLimit,
      page,
    })
    const data = getData(body)
    if (data.length === 0) break
    out.push(...data)
    if (data.length < pageLimit) break
    page += 1
  }
  return out
}

export async function fetchTrace(
  transport: LangfuseTransport,
  traceId: string,
): Promise<Record<string, unknown>> {
  const body = await transport.request(`/api/public/traces/${encodeURIComponent(traceId)}`)
  return asObject(body)
}

export async function fetchSessions(
  transport: LangfuseTransport,
  opts: { limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/public/sessions', { limit: opts.limit ?? 100 })
  return getData(body)
}

export async function fetchPrompts(
  transport: LangfuseTransport,
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/public/v2/prompts')
  return getData(body)
}

export async function fetchPrompt(
  transport: LangfuseTransport,
  name: string,
  version?: number | null,
): Promise<Record<string, unknown>> {
  const query: Record<string, string | number | undefined> = {}
  if (version !== undefined && version !== null) query.version = version
  const body = await transport.request(`/api/public/v2/prompts/${encodeURIComponent(name)}`, query)
  return asObject(body)
}

export async function fetchDatasets(
  transport: LangfuseTransport,
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/public/v2/datasets')
  return getData(body)
}

export async function fetchDatasetItems(
  transport: LangfuseTransport,
  datasetName: string,
  opts: { limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const body = await transport.request('/api/public/dataset-items', {
    datasetName,
    limit: opts.limit ?? 100,
  })
  return getData(body)
}

export async function fetchDatasetRuns(
  transport: LangfuseTransport,
  datasetName: string,
  opts: { limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const body = await transport.request(
    `/api/public/v2/datasets/${encodeURIComponent(datasetName)}/runs`,
    { limit: opts.limit ?? 100 },
  )
  return getData(body)
}

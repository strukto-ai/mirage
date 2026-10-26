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

import type { PathSpec } from '../../types.ts'
import { apiRequest, buildUrl } from '../api/client.ts'
import { enoent } from '../../errors/fs.ts'

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

/**
 * Await a Langfuse fetch, translating a 404 into ENOENT.
 *
 * Every other status stays a LangfuseApiError: only "this VFS does not
 * exist" is a filesystem-level missing file.
 */
export async function fetchOrEnoent<T>(pending: Promise<T>, path: PathSpec): Promise<T> {
  try {
    return await pending
  } catch (err) {
    if (err instanceof LangfuseApiError && err.status === 404) throw enoent(path)
    throw err
  }
}

export interface LangfuseTransport {
  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>
}

export interface HttpLangfuseTransportOptions {
  publicKey: string
  secretKey: string
  host?: string
  timeout?: number
}

function encodeBasicAuth(publicKey: string, secretKey: string): string {
  const raw = `${publicKey}:${secretKey}`
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(raw)
  const buf = (globalThis as { Buffer?: { from(s: string): { toString(enc: string): string } } })
    .Buffer
  if (buf !== undefined) return buf.from(raw).toString('base64')
  throw new LangfuseApiError('no base64 encoder available')
}

// The parse comes before the status check, so a non-JSON error body reports
// as invalid JSON rather than a bare status, matching the old transport. The
// status must land on the error either way: fetchOrEnoent keys on it.
function langfuseError(response: Response, text: string): LangfuseApiError {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new LangfuseApiError(`Langfuse API: invalid JSON: ${msg}`, [], response.status)
  }
  const message =
    body !== null && typeof body === 'object' && 'message' in body
      ? String((body as Record<string, unknown>).message)
      : `Langfuse API error: HTTP ${String(response.status)}`
  return new LangfuseApiError(message, [], response.status)
}

export class HttpLangfuseTransport implements LangfuseTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)
  private readonly host: string
  private readonly auth: string
  private readonly timeout: number | undefined

  constructor(opts: HttpLangfuseTransportOptions) {
    this.host = opts.host ?? 'https://cloud.langfuse.com'
    this.auth = encodeBasicAuth(opts.publicKey, opts.secretKey)
    this.timeout = opts.timeout
  }

  async request(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const text = (await apiRequest('GET', buildUrl(this.host, path, query), {
      fetchFn: this.fetch,
      timeout: this.timeout,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
      },
      read: 'text',
      errorOf: langfuseError,
    })) as string
    try {
      return JSON.parse(text) as unknown
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new LangfuseApiError(`Langfuse API: invalid JSON: ${msg}`)
    }
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

// A root observation stands for its trace: v4 keeps no trace entity, and the
// root carries the trace's name, user, session and tags.
const TRACE_FIELDS = 'core,basic'
const OBSERVATION_FIELDS = 'core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context'
const SCORE_FIELDS = 'details,subject'
const EXPERIMENT_FIELDS = 'core,metadata,scores'
// The experiments endpoint requires a lower bound; the epoch asks for all.
const EXPERIMENTS_FROM = '1970-01-01T00:00:00.000Z'
const PAGE_SIZE = 100

async function collect(
  transport: LangfuseTransport,
  path: string,
  query: Record<string, string | number | undefined>,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let cursor: string | undefined
  while (limit === undefined || out.length < limit) {
    const size = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length)
    const body = await transport.request(path, { ...query, limit: size, cursor })
    const data = getData(body)
    for (const item of data) out.push(item)
    const next = asObject(asObject(body).meta).cursor
    cursor = typeof next === 'string' && next !== '' ? next : undefined
    if (data.length === 0 || cursor === undefined) break
  }
  return out
}

export interface FetchTracesOptions {
  limit?: number
  sessionId?: string | null | undefined
  fromTimestamp?: string | null | undefined
}

/** The root observations of the newest traces, one or more per trace. */
export async function fetchTraces(
  transport: LangfuseTransport,
  opts: FetchTracesOptions = {},
): Promise<Record<string, unknown>[]> {
  const query: Record<string, string | number | undefined> = {
    fields: TRACE_FIELDS,
    isRootObservation: 'true',
  }
  if (opts.sessionId !== undefined && opts.sessionId !== null && opts.sessionId !== '') {
    query.sessionId = opts.sessionId
  }
  if (
    opts.fromTimestamp !== undefined &&
    opts.fromTimestamp !== null &&
    opts.fromTimestamp !== ''
  ) {
    query.fromStartTime = opts.fromTimestamp
  }
  return collect(transport, '/api/public/v2/observations', query, opts.limit ?? PAGE_SIZE)
}

function startTime(observation: Record<string, unknown>): string {
  return typeof observation.startTime === 'string' ? observation.startTime : ''
}

/** One trace: its root observation with the rest and its scores added. */
export async function fetchTrace(
  transport: LangfuseTransport,
  traceId: string,
): Promise<Record<string, unknown>> {
  const observations = await collect(transport, '/api/public/v2/observations', {
    traceId,
    fields: OBSERVATION_FIELDS,
  })
  const roots = observations.filter((o) => o.isRootObservation === true)
  const candidates = roots.length > 0 ? roots : observations
  const root = candidates.reduce<Record<string, unknown> | undefined>(
    (best, o) => (best === undefined || startTime(o) < startTime(best) ? o : best),
    undefined,
  )
  if (root === undefined) {
    throw new LangfuseApiError(`trace ${traceId} not found`, [], 404)
  }
  const scores = await collect(transport, '/api/public/v3/scores', {
    traceId,
    fields: SCORE_FIELDS,
  })
  return { ...root, observations: observations.filter((o) => o !== root), scores }
}

/** The distinct sessions of the newest traces, newest first. */
export async function fetchSessions(
  transport: LangfuseTransport,
  opts: { limit?: number; fromTimestamp?: string | null | undefined } = {},
): Promise<string[]> {
  const roots = await fetchTraces(transport, opts)
  const ids = new Set<string>()
  for (const root of roots) {
    const id = root.sessionId
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return [...ids]
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

/** The experiments run on a dataset, or only the one named `runName`. */
export async function fetchDatasetRuns(
  transport: LangfuseTransport,
  datasetName: string,
  runName?: string,
): Promise<Record<string, unknown>[]> {
  const dataset = asObject(
    await transport.request(`/api/public/v2/datasets/${encodeURIComponent(datasetName)}`),
  )
  const datasetId = typeof dataset.id === 'string' ? dataset.id : ''
  const query: Record<string, string | number | undefined> = {
    fromStartTime: EXPERIMENTS_FROM,
    datasetId,
    fields: EXPERIMENT_FIELDS,
  }
  // The name parameter splits on commas; the filter matches whole names.
  if (runName !== undefined) {
    query.filter = JSON.stringify([
      { type: 'string', column: 'name', operator: '=', value: runName },
    ])
  }
  return collect(transport, '/api/public/experiments', query)
}

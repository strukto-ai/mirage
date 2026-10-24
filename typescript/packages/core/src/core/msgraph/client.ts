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
import { graphApi, type MsGraphConfigResolved } from './config.ts'
import { type ByteWindow } from '../../utils/ranges.ts'
import { apiRequest, headerDelay, type ApiRequestOptions, type RetryPolicy } from '../api/client.ts'
import { MAX_BACKOFF, RETRY_STATUSES } from './constants.ts'

// A drive-relative item path as a Graph URL path: each segment escaped on
// its own, so a `/` inside the path stays a separator.
export function encodedPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/')
}

export class GraphError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(`Graph API error ${String(status)} (${code}): ${message}`)
    this.status = status
    this.code = code
  }
}

type GraphRead = 'json' | 'bytes' | 'none' | 'location'

interface RequestOptions {
  params?: Record<string, string | number | boolean>
  json?: Record<string, unknown>
  data?: Uint8Array
  headers?: Record<string, string>
  auth?: boolean
  read?: GraphRead
  window?: ByteWindow | undefined
}

async function tokenOf(config: MsGraphConfigResolved): Promise<string> {
  return typeof config.accessToken === 'function' ? await config.accessToken() : config.accessToken
}

async function graphHeaders(config: MsGraphConfigResolved): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokenOf(config)}`,
    'Content-Type': 'application/json',
  }
}

function policy(config: MsGraphConfigResolved): RetryPolicy {
  return {
    statuses: RETRY_STATUSES,
    maxRetries: config.maxRetries,
    maxBackoff: MAX_BACKOFF,
    delaySource: 'header',
  }
}

function graphErrorOf(method: string, url: string, response: Response, text: string): GraphError {
  let code = 'unknownError'
  let message = `${method} ${url}`
  try {
    const payload = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
    if (typeof payload.error?.code === 'string') code = payload.error.code
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    message = `${method} ${url}`
  }
  return new GraphError(response.status, code, message)
}

// Graph answers 204 and the odd empty 200 for calls that worked; the caller
// gets an empty object rather than a parse error. A non-object body reads as
// empty too.
function lenientJson(text: string): Record<string, unknown> {
  if (text === '') return {}
  const value: unknown = JSON.parse(text)
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function graphRequest(
  config: MsGraphConfigResolved,
  method: string,
  rawUrl: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const target = new URL(rawUrl)
  for (const [name, value] of Object.entries(options.params ?? {})) {
    target.searchParams.set(name, String(value))
  }
  const url = target.toString()
  const read = options.read ?? 'json'
  let refreshed = false
  for (;;) {
    const headers = options.auth === false ? {} : await graphHeaders(config)
    Object.assign(headers, options.headers)
    const opts: ApiRequestOptions = {
      errorOf: (response, text) => graphErrorOf(method, url, response, text),
      headers,
      retry: policy(config),
      read: read === 'json' ? 'text' : read,
      window: options.window,
      timeoutSeconds: config.timeout,
    }
    if (options.json !== undefined) opts.json = options.json
    else if (options.data !== undefined) opts.body = options.data as BodyInit
    try {
      const result = await apiRequest(method, url, opts)
      return read === 'json' ? lenientJson(result as string) : result
    } catch (err) {
      // a 401 under a token provider means the token aged out mid-flight:
      // mint a fresh one and replay the call once
      if (
        err instanceof GraphError &&
        err.status === 401 &&
        options.auth !== false &&
        !refreshed &&
        typeof config.accessToken === 'function'
      ) {
        refreshed = true
        continue
      }
      throw err
    }
  }
}

export async function graphGet(
  config: MsGraphConfigResolved,
  url: string,
  params?: Record<string, string | number | boolean>,
): Promise<Record<string, unknown>> {
  return (await graphRequest(config, 'GET', url, params === undefined ? {} : { params })) as Record<
    string,
    unknown
  >
}

/**
 * Every item a Graph collection answers, a page at a time; no page past the
 * one that brings `limit` items. Mirrors Python's `graph_list`.
 */
export async function graphList(
  config: MsGraphConfigResolved,
  url: string,
  params?: Record<string, string | number | boolean>,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  let next: string | null = url
  let nextParams = params
  while (next !== null) {
    const payload = await graphGet(config, next, nextParams)
    if (Array.isArray(payload.value)) {
      for (const item of payload.value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          items.push(item as Record<string, unknown>)
        }
      }
    }
    if (limit !== undefined && items.length >= limit) break
    next = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null
    nextParams = undefined
  }
  return items
}

export async function graphGetBytes(
  config: MsGraphConfigResolved,
  url: string,
  window?: ByteWindow,
  auth = true,
): Promise<Uint8Array> {
  return (await graphRequest(config, 'GET', url, {
    auth,
    read: 'bytes',
    window,
  })) as Uint8Array
}

export async function* graphStream(
  config: MsGraphConfigResolved,
  url: string,
  auth = true,
): AsyncIterable<Uint8Array> {
  // A chunked generator cannot ride apiRequest: the body outlives the call,
  // so the response must stay open while the caller consumes it.
  let attempt = 0
  let refreshed = false
  let response: Response
  for (;;) {
    const headers = auth ? await graphHeaders(config) : {}
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, config.timeout * 1000)
    try {
      response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (RETRY_STATUSES.has(response.status) && attempt < config.maxRetries) {
      await sleep(headerDelay(response, attempt, policy(config)) * 1000)
      attempt += 1
      continue
    }
    if (response.status === 401 && auth && !refreshed && typeof config.accessToken === 'function') {
      refreshed = true
      continue
    }
    if (!response.ok) throw graphErrorOf('GET', url, response, await response.text())
    break
  }
  if (response.body === null) return
  const reader = response.body.getReader()
  for (;;) {
    const result = await reader.read()
    if (result.done) return
    yield result.value
  }
}

export async function graphPost(
  config: MsGraphConfigResolved,
  url: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await graphRequest(config, 'POST', url, { json: body })) as Record<string, unknown>
}

/**
 * The answers to several GETs from one JSON batch (`$batch`), each as its
 * status, its body and the seconds its `Retry-After` asks to be waited, in the
 * order of `urls`.
 *
 * Graph runs at most `BATCH_LIMIT` requests in a batch. Each URL is a full one
 * under the mount's service root, and goes in relative to it, as a batch names
 * its requests. A request the reply leaves out answers status 0, a body that
 * is not an object answers empty, and a wait is at most `MAX_BACKOFF`, 0 when
 * the answer names none. Mirrors Python's `graph_batch`.
 */
export async function graphBatch(
  config: MsGraphConfigResolved,
  urls: readonly string[],
): Promise<[number, Record<string, unknown>, number][]> {
  const root = graphApi(config)
  const requests = urls.map((url, i) => ({
    id: String(i),
    method: 'GET',
    url: url.startsWith(root) ? url.slice(root.length) : url,
  }))
  const data = await graphPost(config, `${root}/$batch`, { requests })
  const answers = new Map<string, [number, Record<string, unknown>, number]>()
  for (const reply of Array.isArray(data.responses) ? data.responses : []) {
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) continue
    const { id, status, body, headers } = reply as Record<string, unknown>
    const page = body !== null && typeof body === 'object' && !Array.isArray(body)
    const named = headers !== null && typeof headers === 'object' && !Array.isArray(headers)
    answers.set(String(id), [
      typeof status === 'number' ? status : 0,
      page ? (body as Record<string, unknown>) : {},
      retryAfter(named ? (headers as Record<string, unknown>) : {}),
    ])
  }
  return urls.map((_, i) => answers.get(String(i)) ?? [0, {}, 0])
}

/**
 * The seconds a batched answer's `Retry-After` asks to be waited, at most
 * `MAX_BACKOFF`; 0 for none, or for one that is not a count of seconds.
 * Mirrors Python's `_retry_after`.
 */
export function retryAfter(headers: Record<string, unknown>): number {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') {
      const text = String(value).trim()
      return /^[0-9]+$/.test(text) ? Math.min(Number(text), MAX_BACKOFF) : 0
    }
  }
  return 0
}

export async function graphPostMonitor(
  config: MsGraphConfigResolved,
  url: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const location = await graphRequest(config, 'POST', url, { json: body, read: 'location' })
  if (typeof location !== 'string' || location === '') {
    throw new GraphError(502, 'missingMonitor', `POST ${url} did not return a Location header`)
  }
  return location
}

export async function graphPatch(
  config: MsGraphConfigResolved,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await graphRequest(config, 'PATCH', url, { json: body })) as Record<string, unknown>
}

export async function graphDelete(config: MsGraphConfigResolved, url: string): Promise<void> {
  await graphRequest(config, 'DELETE', url, { read: 'none' })
}

export async function graphPutBytes(
  config: MsGraphConfigResolved,
  url: string,
  data: Uint8Array,
): Promise<Record<string, unknown>> {
  return (await graphRequest(config, 'PUT', url, {
    data,
    headers: { 'Content-Type': 'application/octet-stream' },
  })) as Record<string, unknown>
}

export async function pollMonitor(
  url: string,
  timeout: number,
  interval = 1,
): Promise<Record<string, unknown>> {
  let waited = 0
  for (;;) {
    const raw = await apiRequest('GET', url, {
      errorOf: (response) => new GraphError(response.status, 'monitorError', `GET ${url}`),
    })
    const payload = (raw ?? {}) as Record<string, unknown>
    if (typeof payload.status !== 'string' || payload.status === '') {
      throw new GraphError(502, 'invalidMonitorResponse', `GET ${url} did not return a status`)
    }
    if (payload.status === 'completed' || payload.status === 'failed' || waited >= timeout) {
      return payload
    }
    await sleep(interval * 1000)
    waited += interval
  }
}

export async function uploadChunk(
  config: MsGraphConfigResolved,
  uploadUrl: string,
  data: Uint8Array,
  start: number,
  total: number,
): Promise<Record<string, unknown>> {
  const end = start + data.length - 1
  return (await graphRequest(config, 'PUT', uploadUrl, {
    auth: false,
    data,
    headers: { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(total)}` },
  })) as Record<string, unknown>
}

export async function cancelUpload(
  config: MsGraphConfigResolved,
  uploadUrl: string,
): Promise<void> {
  await graphRequest(config, 'DELETE', uploadUrl, { auth: false, read: 'none' })
}

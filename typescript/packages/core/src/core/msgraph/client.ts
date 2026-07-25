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

import type { MsGraphConfigResolved } from './config.ts'

export const GRAPH_API = 'https://graph.microsoft.com/v1.0'
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503, 504])
export const MAX_BACKOFF = 30

export class GraphError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(`Graph API error ${String(status)} (${code}): ${message}`)
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  params?: Record<string, string | number | boolean>
  json?: Record<string, unknown>
  data?: Uint8Array
  headers?: Record<string, string>
  auth?: boolean
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

async function tokenOf(config: MsGraphConfigResolved): Promise<string> {
  return typeof config.accessToken === 'function' ? await config.accessToken() : config.accessToken
}

export async function graphHeaders(config: MsGraphConfigResolved): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokenOf(config)}`,
    'Content-Type': 'application/json',
  }
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get('Retry-After')
  if (value !== null) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Math.min(2 ** attempt, MAX_BACKOFF)
}

async function graphError(response: Response, method: string, url: string): Promise<GraphError> {
  let code = 'unknownError'
  let message = `${method} ${url}`
  try {
    const payload = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
    if (typeof payload.error?.code === 'string') code = payload.error.code
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    message = `${method} ${url}`
  }
  return new GraphError(response.status, code, message)
}

async function request(
  config: MsGraphConfigResolved,
  method: string,
  rawUrl: string,
  options: RequestOptions = {},
): Promise<Response> {
  const url = new URL(rawUrl)
  for (const [name, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(name, String(value))
  }
  let attempt = 0
  let refreshed = false
  for (;;) {
    const headers = options.auth === false ? {} : await graphHeaders(config)
    Object.assign(headers, options.headers)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, config.timeout * 1000)
    let response: Response
    try {
      const init: RequestInit = { method, headers, signal: controller.signal }
      if (options.data !== undefined) init.body = options.data as BodyInit
      if (options.json !== undefined) init.body = JSON.stringify(options.json)
      response = await fetch(url, init)
    } finally {
      clearTimeout(timer)
    }
    if (RETRY_STATUSES.has(response.status) && attempt < config.maxRetries) {
      await sleep(retryDelay(response, attempt))
      attempt += 1
      continue
    }
    if (
      response.status === 401 &&
      options.auth !== false &&
      !refreshed &&
      typeof config.accessToken === 'function'
    ) {
      refreshed = true
      continue
    }
    if (!response.ok) throw await graphError(response, method, url.toString())
    return response
  }
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 204) return {}
  const text = await response.text()
  if (text === '') return {}
  const value: unknown = JSON.parse(text)
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function graphGet(
  config: MsGraphConfigResolved,
  url: string,
  params?: Record<string, string | number | boolean>,
): Promise<Record<string, unknown>> {
  return jsonObject(await request(config, 'GET', url, params === undefined ? {} : { params }))
}

export async function graphList(
  config: MsGraphConfigResolved,
  url: string,
  params?: Record<string, string | number | boolean>,
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
    next = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null
    nextParams = undefined
  }
  return items
}

export async function graphGetBytes(
  config: MsGraphConfigResolved,
  url: string,
  range?: string,
  auth = true,
): Promise<Uint8Array> {
  const headers = range === undefined ? undefined : { Range: range }
  const response = await request(config, 'GET', url, { auth, ...(headers ? { headers } : {}) })
  return new Uint8Array(await response.arrayBuffer())
}

export async function* graphStream(
  config: MsGraphConfigResolved,
  url: string,
  auth = true,
): AsyncIterable<Uint8Array> {
  const response = await request(config, 'GET', url, { auth })
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
  return jsonObject(await request(config, 'POST', url, { json: body }))
}

export async function graphPostMonitor(
  config: MsGraphConfigResolved,
  url: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(config, 'POST', url, { json: body })
  const location = response.headers.get('Location')
  if (location === null || location === '') {
    throw new GraphError(502, 'missingMonitor', `POST ${url} did not return a Location header`)
  }
  return location
}

export async function graphPatch(
  config: MsGraphConfigResolved,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return jsonObject(await request(config, 'PATCH', url, { json: body }))
}

export async function graphDelete(config: MsGraphConfigResolved, url: string): Promise<void> {
  await request(config, 'DELETE', url)
}

export async function graphPutBytes(
  config: MsGraphConfigResolved,
  url: string,
  data: Uint8Array,
): Promise<Record<string, unknown>> {
  const response = await request(config, 'PUT', url, {
    data,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  return jsonObject(response)
}

export async function pollMonitor(
  url: string,
  timeout: number,
  interval = 1,
): Promise<Record<string, unknown>> {
  let waited = 0
  for (;;) {
    const response = await fetch(url)
    if (!response.ok) throw new GraphError(response.status, 'monitorError', `GET ${url}`)
    const payload = (await response.json()) as Record<string, unknown>
    if (typeof payload.status !== 'string' || payload.status === '') {
      throw new GraphError(502, 'invalidMonitorResponse', `GET ${url} did not return a status`)
    }
    if (payload.status === 'completed' || payload.status === 'failed' || waited >= timeout) {
      return payload
    }
    await sleep(interval)
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
  const response = await request(config, 'PUT', uploadUrl, {
    auth: false,
    data,
    headers: { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(total)}` },
  })
  return jsonObject(response)
}

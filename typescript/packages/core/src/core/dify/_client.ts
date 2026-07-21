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

import type { DifyAccessor, DifyRequestOptions } from '../../accessor/dify.ts'

class DifyHttpError extends Error {
  readonly status: number
  readonly retryAfter: string | null

  constructor(status: number, retryAfter: string | null) {
    super(`Dify request failed with status ${String(status)}`)
    this.status = status
    this.retryAfter = retryAfter
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: unknown): boolean {
  if (error instanceof DifyHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600)
  }
  return true
}

function retryDelayMs(error: unknown, attempt: number, maxDelay: number): number {
  if (error instanceof DifyHttpError && error.retryAfter !== null) {
    const parsed = Number.parseFloat(error.retryAfter)
    if (!Number.isNaN(parsed)) {
      return Math.min(maxDelay, Math.max(0, parsed)) * 1000
    }
  }
  return Math.min(maxDelay, 2 ** (attempt - 1)) * 1000
}

async function requestOnce(
  accessor: DifyAccessor,
  method: string,
  endpoint: string,
  options: DifyRequestOptions,
): Promise<Record<string, unknown>> {
  const response = await accessor.request(method, endpoint, options)
  if (!response.ok) {
    throw new DifyHttpError(response.status, response.headers.get('Retry-After'))
  }
  const payload: unknown = await response.json()
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Dify response must be a JSON object')
  }
  return payload as Record<string, unknown>
}

async function difyRequest(
  accessor: DifyAccessor,
  method: string,
  endpoint: string,
  options: DifyRequestOptions = {},
): Promise<Record<string, unknown>> {
  const attempts = accessor.config.retryAttempts
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce(accessor, method, endpoint, options)
    } catch (err) {
      lastError = err
      if (attempt >= attempts || !isRetryable(err)) throw err
      await sleep(retryDelayMs(err, attempt, accessor.config.retryMaxDelay))
    }
  }
  throw lastError
}

function difyGet(
  accessor: DifyAccessor,
  endpoint: string,
  params?: Record<string, string | number | boolean>,
): Promise<Record<string, unknown>> {
  return difyRequest(accessor, 'GET', endpoint, params !== undefined ? { params } : {})
}

export function difyPost(
  accessor: DifyAccessor,
  endpoint: string,
  json: unknown,
): Promise<Record<string, unknown>> {
  return difyRequest(accessor, 'POST', endpoint, { json })
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const out: Record<string, unknown>[] = []
  for (const item of value) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>)
    }
  }
  return out
}

function isVisibleDocument(document: Record<string, unknown>): boolean {
  return (
    document.enabled === true &&
    document.indexing_status === 'completed' &&
    document.archived === false
  )
}

export async function listAllDocuments(accessor: DifyAccessor): Promise<Record<string, unknown>[]> {
  const documents: Record<string, unknown>[] = []
  let page = 1
  for (;;) {
    const payload = await difyGet(accessor, `/datasets/${accessor.config.datasetId}/documents`, {
      page,
      limit: 100,
    })
    for (const document of asRecordList(payload.data)) {
      if (isVisibleDocument(document)) documents.push(document)
    }
    if (payload.has_more !== true) return documents
    page += 1
  }
}

export async function* iterSegmentPages(
  accessor: DifyAccessor,
  documentId: string,
): AsyncIterable<Record<string, unknown>[]> {
  let page = 1
  for (;;) {
    const payload = await difyGet(
      accessor,
      `/datasets/${accessor.config.datasetId}/documents/${documentId}/segments`,
      { page, limit: 100, status: 'completed', enabled: 'true' },
    )
    yield asRecordList(payload.data)
    if (payload.has_more !== true) return
    page += 1
  }
}

export async function getDocumentSegments(
  accessor: DifyAccessor,
  documentId: string,
): Promise<Record<string, unknown>[]> {
  const segments: Record<string, unknown>[] = []
  for await (const pageSegments of iterSegmentPages(accessor, documentId)) {
    segments.push(...pageSegments)
  }
  return segments
}

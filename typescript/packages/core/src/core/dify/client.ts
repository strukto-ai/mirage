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
import { records } from '../../utils/records.ts'
import type { DifyAccessor, DifyRequestOptions } from '../../accessor/dify.ts'
import { ApiError } from '../api/errors.ts'

class DifyHttpError extends ApiError {
  declare readonly status: number
  readonly retryAfter: string | null

  constructor(status: number, retryAfter: string | null) {
    super(`Dify request failed with status ${String(status)}`, status)
    this.retryAfter = retryAfter
  }
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
      const response = await accessor.request(method, endpoint, options)
      if (!response.ok) {
        throw new DifyHttpError(response.status, response.headers.get('Retry-After'))
      }
      const payload: unknown = await response.json()
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Dify response must be a JSON object')
      }
      return payload as Record<string, unknown>
    } catch (err) {
      lastError = err
      const http = err instanceof DifyHttpError ? err : null
      const retryable =
        http === null || http.status === 429 || (http.status >= 500 && http.status < 600)
      if (attempt >= attempts || !retryable) throw err
      const maxDelay = accessor.config.retryMaxDelay
      const retryAfter = http?.retryAfter ?? null
      const asked = retryAfter === null ? Number.NaN : Number.parseFloat(retryAfter)
      const delay = Number.isNaN(asked) ? 2 ** (attempt - 1) : Math.max(0, asked)
      await sleep(Math.min(maxDelay, delay) * 1000)
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
    for (const document of records(payload.data)) {
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
    yield records(payload.data)
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
    for (const item of pageSegments) segments.push(item)
  }
  return segments
}

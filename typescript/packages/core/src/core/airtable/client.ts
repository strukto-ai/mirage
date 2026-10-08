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

import type { AirtableAccessor } from '../../accessor/airtable.ts'
import { apiRequest, type RetryPolicy, type ErrorOf } from '../api/client.ts'
import { cursorItems, offsetCursor, type PageShape } from '../api/paginate.ts'
import { MAX_BATCH, META_KEY, PAGE_SIZE } from './constants.ts'
import { AirtableApiError, errorParts } from './errors.ts'
import { asRow, asRows, type Row } from './normalize.ts'

export const BASES: PageShape = { itemsKey: 'bases', nextCursor: offsetCursor }
export const RECORDS: PageShape = { itemsKey: 'records', nextCursor: offsetCursor }
export const COMMENTS: PageShape = { itemsKey: 'comments', nextCursor: offsetCursor }

function errorOf(call: string): ErrorOf {
  return (response: Response, text: string): Error => {
    const [kind, message] = errorParts(text)
    const detail = [kind, message].filter((part): part is string => part !== null && part !== '')
    const suffix = detail.length > 0 ? `: ${detail.join(': ')}` : ''
    return new AirtableApiError(
      `Airtable API error (${call}): HTTP ${String(response.status)}${suffix}`,
      response.status,
      kind,
    )
  }
}

// A 429 means either "slow down" (RATE_LIMIT_REACHED) or "this workspace
// spent its monthly calls"; waiting only helps the first.
function retryable(_status: number, text: string): boolean {
  return errorParts(text)[0] !== 'PUBLIC_API_BILLING_LIMIT_EXCEEDED'
}

// After a 429 Airtable refuses every request to the base for 30 seconds, so
// a retry sooner than that is spent inside the penalty; 502 and 503 are
// documented as safe to retry with backoff.
export const RETRY: RetryPolicy = {
  statuses: new Set([429, 502, 503]),
  maxRetries: 2,
  maxBackoff: 30,
  delaySource: 'header',
  retryable,
  minDelays: { 429: 30 },
}

// A write retries only the 429, which Airtable answers before it applies
// anything. A 502 or 503 may come back after the records landed, and a
// retried create would make them twice.
export const WRITE_RETRY: RetryPolicy = { ...RETRY, statuses: new Set([429]) }

interface RequestOptions {
  params?: Record<string, string | number> | undefined
  query?: string
  json?: unknown
  retry?: RetryPolicy
}

async function request(
  accessor: AirtableAccessor,
  method: string,
  path: string,
  paceKey: string,
  options: RequestOptions = {},
): Promise<unknown> {
  await accessor.limiter.acquire(paceKey)
  const url = `${accessor.baseUrl}${path}`
  const query = options.query ?? ''
  const headers: Record<string, string> = { Authorization: `Bearer ${accessor.config.token}` }
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  return apiRequest(method, query === '' ? url : `${url}?${query}`, {
    errorOf: errorOf(`${method} ${path}`),
    headers,
    params: options.params,
    json: options.json,
    retry: options.retry ?? RETRY,
    fetchFn: accessor.fetchFn,
  })
}

function get(
  accessor: AirtableAccessor,
  path: string,
  params: Record<string, string | number> | undefined,
  paceKey: string,
): Promise<unknown> {
  return request(accessor, 'GET', path, paceKey, { params })
}

const segment = encodeURIComponent

function tablePath(baseId: string, table: string): string {
  return `/${segment(baseId)}/${segment(table)}`
}

function recordPath(baseId: string, table: string, recordId: string): string {
  return `${tablePath(baseId, table)}/${segment(recordId)}`
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += MAX_BATCH) {
    out.push(items.slice(start, start + MAX_BATCH))
  }
  return out
}

async function page(
  accessor: AirtableAccessor,
  paceKey: string,
  path: string,
  params: Record<string, string | number>,
  cursor: string | null,
): Promise<Row> {
  return asRow(
    await get(accessor, path, cursor !== null ? { ...params, offset: cursor } : params, paceKey),
  )
}

/** Every base the token reaches, narrowed to the configured `baseIds`. */
export async function listBases(accessor: AirtableAccessor): Promise<Row[]> {
  const bases = await cursorItems(
    (cursor) => page(accessor, META_KEY, '/meta/bases', {}, cursor),
    undefined,
    BASES,
  )
  const wanted = accessor.baseIds
  return asRows(bases).filter((base) => wanted === null || wanted.includes(String(base.id)))
}

/** A base's schema: its tables with their fields and views. */
export async function listTables(accessor: AirtableAccessor, baseId: string): Promise<Row[]> {
  const data = await get(accessor, `/meta/bases/${segment(baseId)}/tables`, undefined, baseId)
  return asRows(asRow(data).tables)
}

/**
 * A table's records in the API's order, or a view's. Without a view
 * Airtable calls the order arbitrary; it is the order the table hands out,
 * stable between calls, and the only one a `maxRecords` prefix agrees with.
 * The table and the view are named by id or by name; `formula` is
 * `filterByFormula`, listing only the records it is true for; `maxRecords`
 * stops after that many records, both on the wire and in the collector.
 */
export async function listRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  options: { view?: string; formula?: string; maxRecords?: number } = {},
): Promise<Row[]> {
  const params: Record<string, string | number> = { pageSize: PAGE_SIZE }
  if (options.view !== undefined) params.view = options.view
  if (options.formula !== undefined) params.filterByFormula = options.formula
  if (options.maxRecords !== undefined) params.maxRecords = options.maxRecords
  const path = tablePath(baseId, tableId)
  const found = await cursorItems(
    (cursor) => page(accessor, baseId, path, params, cursor),
    options.maxRecords,
    RECORDS,
  )
  return asRows(found)
}

/** One record by id; the table is named by id or by name. */
export async function getRecord(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<Row> {
  return asRow(await get(accessor, recordPath(baseId, tableId, recordId), undefined, baseId))
}

async function* write(
  accessor: AirtableAccessor,
  method: string,
  baseId: string,
  tableId: string,
  rows: readonly Row[],
  typecast: boolean | undefined,
): AsyncGenerator<Row[]> {
  const path = tablePath(baseId, tableId)
  for (const batch of batches(rows)) {
    const body: Row = { records: batch }
    if (typecast === true) body.typecast = true
    const data = await request(accessor, method, path, baseId, { json: body, retry: WRITE_RETRY })
    yield asRows(asRow(data).records)
  }
}

/**
 * Create records ten to a request, yielding each request's records. Each
 * entry is a new record's cell map, keyed by field name; `typecast` lets
 * Airtable convert string values to the field types. A request that fails
 * throws after every earlier one landed, so the caller holds exactly what
 * was written.
 */
export function createRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  cells: readonly Row[],
  options: { typecast?: boolean } = {},
): AsyncGenerator<Row[]> {
  const rows = cells.map((fields) => ({ fields }))
  return write(accessor, 'POST', baseId, tableId, rows, options.typecast)
}

/**
 * Patch records ten to a request, yielding each request's records. A
 * PATCH, never a PUT: a cell the update leaves out keeps its value. Each
 * entry is a record id and the cells to change, keyed by field name.
 */
export function updateRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  updates: readonly (readonly [string, Row])[],
  options: { typecast?: boolean } = {},
): AsyncGenerator<Row[]> {
  const rows = updates.map(([id, fields]) => ({ id, fields }))
  return write(accessor, 'PATCH', baseId, tableId, rows, options.typecast)
}

/**
 * Delete records ten to a request, yielding each request's answer. The ids
 * ride the query string as `records[]`, which is the only place the
 * endpoint reads them from.
 */
export async function* deleteRecords(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordIds: readonly string[],
): AsyncGenerator<Row[]> {
  const path = tablePath(baseId, tableId)
  for (const batch of batches(recordIds)) {
    const query = new URLSearchParams(batch.map((id) => ['records[]', id])).toString()
    const data = await request(accessor, 'DELETE', path, baseId, { query, retry: WRITE_RETRY })
    yield asRows(asRow(data).records)
  }
}

/** A record's comments in the API's order, newest first. */
export async function listComments(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
): Promise<Row[]> {
  const path = `${recordPath(baseId, tableId, recordId)}/comments`
  const found = await cursorItems(
    (cursor) => page(accessor, baseId, path, { pageSize: PAGE_SIZE }, cursor),
    undefined,
    COMMENTS,
  )
  return asRows(found)
}

/** Comment on a record as the token's user. */
export async function createComment(
  accessor: AirtableAccessor,
  baseId: string,
  tableId: string,
  recordId: string,
  text: string,
): Promise<Row> {
  return asRow(
    await request(accessor, 'POST', `${recordPath(baseId, tableId, recordId)}/comments`, baseId, {
      json: { text },
      retry: WRITE_RETRY,
    }),
  )
}

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

import { AirtableAccessor } from '../../../src/accessor/airtable.ts'
import type { AirtableConfig } from '../../../src/core/airtable/config.ts'

export const API = 'https://api.airtable.com/v0'
export const TOKEN = 'patTest0000000001.secret'
export const ROADMAP = 'appRoadmapBase001'
export const OPS = 'appOpsFinance0001'
export const FEATURES = 'tblFeatures000001'
export const BUDGET = 'tblBudget00000001'
export const GRID = 'viwGrid0000000001'
export const DONE = 'viwDone0000000001'
export const DONE_FORMULA = "{Status}='Done'"
const MAX_BATCH = 10
export const MODEL_NOT_FOUND =
  'Invalid permissions, or the requested model was not found. Check that both your user and ' +
  'your token have the required permissions, and that the model names and/or ids are correct.'
const VIEW_ID = /^viw[A-Za-z0-9]{14}$/
const ADA = { id: 'usrAda0000000001', email: 'ada@example.com', name: 'Ada' }
const BEN = { id: 'usrBen0000000002', email: 'ben@example.com', name: 'Ben' }
const WRITE_KINDS = new Set(['create', 'update', 'delete', 'comment'])
const BATCH_MESSAGES: Record<string, string> = {
  create:
    'You must provide an array of up to 10 record objects, each with a "fields" object for cell values.',
  update:
    'You must provide an array of up to 10 record objects, each with an "id" ID field and a "fields" object for cell values.',
  delete: 'You must provide an array of up to 10 record IDs.',
}

type Row = Record<string, unknown>

function record(n: number, fields: Row): Row {
  return {
    id: `rec${String(n).padStart(14, '0')}`,
    createdTime: `2026-01-${String(n).padStart(2, '0')}T09:00:00.000Z`,
    fields,
  }
}

function comment(n: number, text: string, author: Row): Row {
  return {
    id: `com${String(n).padStart(14, '0')}`,
    author,
    text,
    createdTime: `2026-01-${String(n).padStart(2, '0')}T10:00:00.000Z`,
    lastUpdatedTime: null,
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function features(): Row[] {
  const rows: Row[] = []
  for (let n = 1; n < 8; n++) {
    const cells: Row = { Name: `Feature ${String(n)}`, Priority: n }
    if (n % 2 === 1) cells.Status = 'Done'
    rows.push(record(n, cells))
  }
  return rows
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function airtableError(status: number, type: string, message?: string): Response {
  return json({ error: message === undefined ? { type } : { type, message } }, status)
}

function modelNotFound(): Response {
  return airtableError(403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', MODEL_NOT_FOUND)
}

/**
 * An in-process Airtable API behind a `fetch` seam, paged like the real one:
 * the TypeScript twin of python's tests/fixtures/airtable_api.py, holding
 * the same bases, tables, views and records. `pageCap` keeps pages short so
 * a handful of records still spans several `offset` round trips.
 */
export class FakeAirtable {
  bases: Row[] = [
    { id: ROADMAP, name: 'Product Roadmap', permissionLevel: 'create' },
    { id: OPS, name: 'Ops / Finance ✓', permissionLevel: 'read' },
  ]
  tables: Record<string, Row[]> = {
    [ROADMAP]: [
      {
        id: FEATURES,
        name: 'Features',
        primaryFieldId: 'fldName000000001',
        fields: [
          { id: 'fldName000000001', name: 'Name', type: 'singleLineText' },
          {
            id: 'fldStatus0000001',
            name: 'Status',
            type: 'singleSelect',
            options: { choices: [{ id: 'selDone000000001', name: 'Done' }] },
          },
          {
            id: 'fldPriority00001',
            name: 'Priority',
            type: 'number',
            options: { precision: 0 },
          },
        ],
        views: [
          { id: GRID, name: 'Grid view', type: 'grid' },
          { id: DONE, name: 'Done / shipped', type: 'grid' },
        ],
      },
    ],
    [OPS]: [
      {
        id: BUDGET,
        name: 'Q3 / Budget',
        primaryFieldId: 'fldLine000000001',
        fields: [{ id: 'fldLine000000001', name: 'Line', type: 'singleLineText' }],
        views: [],
      },
    ],
  }
  records: Record<string, Row[]> = {
    [FEATURES]: features(),
    [BUDGET]: [record(1, { Line: 'Rent' })],
  }
  views: Record<string, (row: Row) => boolean> = {
    [GRID]: () => true,
    [DONE]: (row) => (row.fields as Row).Status === 'Done',
  }
  formulas: Record<string, (row: Row) => boolean> = {
    [DONE_FORMULA]: (row) => (row.fields as Row).Status === 'Done',
  }
  comments: Record<string, Row[]> = {
    rec00000000000001: [comment(2, 'Shipped it.', ADA), comment(1, 'Looks good.', BEN)],
  }
  /** The write request, counted from 1, that answers this status and type. */
  faults: Record<number, readonly [number, string]> = {}
  pageCap = 3
  writes = 0
  minted = 0
  readonly calls: { kind: string; params: Record<string, string>; body?: unknown }[] = []

  constructor(options: { faults?: Record<number, readonly [number, string]> } = {}) {
    this.faults = options.faults ?? {}
  }

  /** The query of every records request, in order. */
  recordCalls(): Record<string, string>[] {
    return this.calls.filter((c) => c.kind === 'records').map((c) => c.params)
  }

  /** Every write request, in order, with what it carried. */
  writeCalls(): { kind: string; params: Record<string, string>; body?: unknown }[] {
    return this.calls.filter((c) => WRITE_KINDS.has(c.kind))
  }

  private table(baseId: string, ref: string): Row | undefined {
    const tables = this.tables[baseId] ?? []
    return tables.find((t) => t.id === ref) ?? tables.find((t) => t.name === ref)
  }

  private fault(): Response | null {
    this.writes += 1
    const fault = this.faults[this.writes]
    return fault === undefined ? null : airtableError(fault[0], fault[1])
  }

  private paged(pool: Row[], key: string, params: Record<string, string>, trailing: boolean) {
    const size = Math.min(Number(params.pageSize ?? '100'), this.pageCap)
    const start = params.offset !== undefined ? Number(params.offset.split('/')[1]) : 0
    const body: Row = { [key]: pool.slice(start, start + size) }
    if (start + size < pool.length) body.offset = `itrFakeIterator01/${String(start + size)}`
    else if (trailing) body.offset = null
    return json(body)
  }

  private find(baseId: string, ref: string, recordId: string): Row | Response {
    const table = this.table(baseId, ref)
    if (table === undefined) return modelNotFound()
    const found = (this.records[String(table.id)] ?? []).find((r) => r.id === recordId)
    return found ?? modelNotFound()
  }

  private cells(table: Row, before: Row, given: unknown): Row | Response | null {
    if (!isRow(given)) return null
    const names = new Set((table.fields as Row[]).map((f) => f.name))
    const out = new Map(Object.entries(before))
    for (const [name, value] of Object.entries(given)) {
      if (!names.has(name)) {
        return airtableError(422, 'UNKNOWN_FIELD_NAME', `Unknown field name: "${name}"`)
      }
      if (value === null) out.delete(name)
      else out.set(name, value)
    }
    return Object.fromEntries(out)
  }

  private batch(
    kind: string,
    keys: readonly string[],
    baseId: string,
    ref: string,
    body: unknown,
  ): [Row, Row[]] | Response {
    this.calls.push({ kind, params: { table: ref }, body })
    const fault = this.fault()
    if (fault !== null) return fault
    const table = this.table(baseId, ref)
    if (table === undefined) return modelNotFound()
    if (
      !isRow(body) ||
      Object.keys(body).some((k) => k !== 'records' && k !== 'typecast') ||
      (body.typecast !== undefined && typeof body.typecast !== 'boolean')
    ) {
      return airtableError(
        422,
        'INVALID_REQUEST_UNKNOWN',
        'Invalid request: parameter validation failed.',
      )
    }
    const rows = body.records
    const shaped = (r: unknown): boolean =>
      isRow(r) && Object.keys(r).length === keys.length && keys.every((k) => k in r)
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH || !rows.every(shaped)) {
      return airtableError(422, 'INVALID_RECORDS', BATCH_MESSAGES[kind])
    }
    return [table, rows as Row[]]
  }

  private create(baseId: string, ref: string, body: unknown): Response {
    const batch = this.batch('create', ['fields'], baseId, ref, body)
    if (batch instanceof Response) return batch
    const [table, rows] = batch
    const made: Row[] = []
    for (const row of rows) {
      const cells = this.cells(table, {}, row.fields)
      if (cells instanceof Response) return cells
      if (cells === null) return airtableError(422, 'INVALID_RECORDS', BATCH_MESSAGES.create)
      this.minted += 1
      made.push({
        id: `recNew${String(this.minted).padStart(11, '0')}`,
        createdTime: `2026-02-01T00:00:${String(this.minted).padStart(2, '0')}.000Z`,
        fields: cells,
      })
    }
    this.records[String(table.id)]?.push(...made)
    return json({ records: made })
  }

  private update(baseId: string, ref: string, body: unknown): Response {
    const batch = this.batch('update', ['id', 'fields'], baseId, ref, body)
    if (batch instanceof Response) return batch
    const [table, rows] = batch
    const pool = this.records[String(table.id)] ?? []
    const planned: [Row, Row][] = []
    for (const row of rows) {
      const record = pool.find((r) => r.id === row.id)
      if (record === undefined) {
        return airtableError(
          422,
          'ROW_DOES_NOT_EXIST',
          `Record ID ${String(row.id)} does not exist in this table`,
        )
      }
      const cells = this.cells(table, record.fields as Row, row.fields)
      if (cells instanceof Response) return cells
      if (cells === null) return airtableError(422, 'INVALID_RECORDS', BATCH_MESSAGES.update)
      planned.push([record, cells])
    }
    for (const [record, cells] of planned) record.fields = cells
    return json({ records: planned.map(([record]) => record) })
  }

  private remove(baseId: string, ref: string, url: URL): Response {
    const ids = url.searchParams.getAll('records[]')
    this.calls.push({ kind: 'delete', params: { table: ref, records: ids.join(',') } })
    const fault = this.fault()
    if (fault !== null) return fault
    const table = this.table(baseId, ref)
    if (table === undefined) return modelNotFound()
    if (ids.length < 1 || ids.length > MAX_BATCH) {
      return airtableError(422, 'INVALID_RECORDS', BATCH_MESSAGES.delete)
    }
    const pool = this.records[String(table.id)] ?? []
    const missing = ids.find((id) => !pool.some((r) => r.id === id))
    if (missing !== undefined) {
      return airtableError(404, 'NOT_FOUND', `Could not find a record with ID "${missing}".`)
    }
    this.records[String(table.id)] = pool.filter((r) => !ids.includes(String(r.id)))
    return json({ records: ids.map((id) => ({ id, deleted: true })) })
  }

  private addComment(baseId: string, ref: string, recordId: string, body: unknown): Response {
    this.calls.push({ kind: 'comment', params: { record: recordId }, body })
    const fault = this.fault()
    if (fault !== null) return fault
    const found = this.find(baseId, ref, recordId)
    if (found instanceof Response) return found
    if (
      !isRow(body) ||
      Object.keys(body).join() !== 'text' ||
      typeof body.text !== 'string' ||
      body.text === ''
    ) {
      return airtableError(
        422,
        'INVALID_REQUEST_UNKNOWN',
        'Invalid request: parameter validation failed.',
      )
    }
    this.minted += 1
    const made: Row = {
      id: `comNew${String(this.minted).padStart(11, '0')}`,
      author: ADA,
      text: body.text,
      createdTime: `2026-02-02T00:00:${String(this.minted).padStart(2, '0')}.000Z`,
      lastUpdatedTime: null,
    }
    this.comments[recordId] = [made, ...(this.comments[recordId] ?? [])]
    return json(made)
  }

  private list(baseId: string, ref: string, params: Record<string, string>): Response {
    this.calls.push({ kind: 'records', params: { ...params, table: ref } })
    const table = this.table(baseId, ref)
    if (table === undefined) return modelNotFound()
    let pool = this.records[String(table.id)] ?? []
    if (params.view !== undefined) {
      const keep = this.views[params.view]
      if (keep === undefined) {
        const type = VIEW_ID.test(params.view) ? 'VIEW_ID_NOT_FOUND' : 'VIEW_NAME_NOT_FOUND'
        return airtableError(422, type, `View ${params.view} not found`)
      }
      pool = pool.filter(keep)
    }
    if (params.filterByFormula !== undefined) {
      const test = this.formulas[params.filterByFormula]
      if (test === undefined) {
        return airtableError(
          422,
          'INVALID_FILTER_BY_FORMULA',
          'The formula for filtering records is invalid',
        )
      }
      pool = pool.filter(test)
    }
    if (params.maxRecords !== undefined) pool = pool.slice(0, Number(params.maxRecords))
    return this.paged(pool, 'records', params, false)
  }

  private route(url: URL, method: string, body: unknown): Response {
    const params = Object.fromEntries(url.searchParams.entries())
    const [baseId = '', ref = '', recordId, leaf] = url.pathname
      .replace(/^\/v0\//, '')
      .split('/')
      .map((part) => decodeURIComponent(part))
    if (recordId === undefined) {
      if (method === 'POST') return this.create(baseId, ref, body)
      if (method === 'PATCH') return this.update(baseId, ref, body)
      if (method === 'DELETE') return this.remove(baseId, ref, url)
      return this.list(baseId, ref, params)
    }
    if (leaf === 'comments') {
      if (method === 'POST') return this.addComment(baseId, ref, recordId, body)
      this.calls.push({ kind: 'comments', params: { ...params, record: recordId } })
      const found = this.find(baseId, ref, recordId)
      if (found instanceof Response) return found
      return this.paged(this.comments[recordId] ?? [], 'comments', params, true)
    }
    this.calls.push({ kind: 'record', params: { table: ref, record: recordId } })
    const found = this.find(baseId, ref, recordId)
    return found instanceof Response ? found : json(found)
  }

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const params = Object.fromEntries(url.searchParams.entries())
    const auth = new Headers(init?.headers).get('Authorization')
    const tail = url.pathname.replace(/^\/v0\//, '')
    if (tail === 'meta/bases') {
      this.calls.push({ kind: 'bases', params })
      if (auth !== `Bearer ${TOKEN}`) {
        return Promise.resolve(
          airtableError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required'),
        )
      }
      return Promise.resolve(json({ bases: this.bases }))
    }
    const tables = /^meta\/bases\/([^/]+)\/tables$/.exec(tail)
    if (tables !== null) {
      const baseId = tables[1] ?? ''
      this.calls.push({ kind: 'tables', params: { base: baseId } })
      const schema = this.tables[baseId]
      if (schema === undefined) {
        return Promise.resolve(modelNotFound())
      }
      return Promise.resolve(json({ tables: schema }))
    }
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const type = new Headers(init?.headers).get('Content-Type') ?? ''
    if (raw !== undefined && !/application\/json/i.test(type)) {
      return Promise.resolve(
        airtableError(422, 'INVALID_REQUEST_BODY', 'Could not parse request body'),
      )
    }
    const body = raw === undefined ? undefined : (JSON.parse(raw) as unknown)
    return Promise.resolve(this.route(url, init?.method ?? 'GET', body))
  }
}

/** An accessor against the fake, pacing disabled for speed. */
export function makeAccessor(
  fake: FakeAirtable,
  overrides: Partial<AirtableConfig> = {},
): AirtableAccessor {
  return new AirtableAccessor(
    { token: TOKEN, requestsPerSecond: 10_000, ...overrides },
    { fetchFn: fake.fetch },
  )
}

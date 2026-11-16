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

import { all } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { authenticate, baseFor, onlyQuery, requireIds, tableOf } from './access.ts'
import { cellValue, compileIn, formulaInput, isEmpty, renderRecord, scalar } from './cells.ts'
import { MAX_PAGE_SIZE } from './config.ts'
import type { C } from './config.ts'
import { FormulaSyntaxError, UnknownFieldsError, evaluate, truthy } from './formula.ts'
import type { Compiled, FValue } from './formula.ts'
import { fieldByRef, recordIn } from './store.ts'
import type { FieldRow, RecordRow, SortSpec, TableRow, World } from './store.ts'
import {
  INVALID_FORMULA,
  badFormula,
  badOffset,
  bodyBool,
  bodyOf,
  boolParam,
  failedStateCheck,
  guard,
  intParam,
  invalidRequest,
  isListKey,
  isObject,
  listParam,
  modelNotFound,
  offsetToken,
  ok,
  onlyKeys,
  parseOffset,
  refuse,
  resumeAt,
  unknownField,
  viewNotFound,
} from './wire.ts'
import type { JsonObject } from './wire.ts'

export interface ListParams {
  pageSize: number | undefined
  maxRecords: number | undefined
  offset: string | undefined
  view: string | undefined
  fields: string[] | undefined
  sort: SortSpec[] | undefined
  filterByFormula: string | undefined
  byId: boolean
  commentCount: boolean
}

const SCALAR_PARAMS = new Set([
  'pageSize',
  'maxRecords',
  'offset',
  'view',
  'filterByFormula',
  'cellFormat',
  'timeZone',
  'userLocale',
  'returnFieldsByFieldId',
  'includeDateDependencyMetadata',
])

const SORT_KEY_RE = /^sort\[(\d+)\]\[(field|direction)\]$/

// Only `json` is served. `string` needs a time zone and locale to render
// every field type as the UI would, which this fake does not model.
function checkCellFormat(raw: JsonValue | undefined): void {
  if (raw !== undefined && raw !== null && raw !== 'json') refuse(invalidRequest())
}

function checkMetadata(values: readonly JsonValue[]): boolean {
  for (const v of values) if (v !== 'commentCount') refuse(invalidRequest())
  return values.length > 0
}

function direction(raw: JsonValue | undefined): 'asc' | 'desc' {
  if (raw === undefined || raw === null || raw === 'asc') return 'asc'
  if (raw === 'desc') return 'desc'
  return refuse(invalidRequest())
}

function sortFromQuery(query: URLSearchParams): SortSpec[] | undefined {
  const slots = new Map<number, { field?: string; direction?: string }>()
  for (const [key, value] of query) {
    const m = SORT_KEY_RE.exec(key)
    if (m === null) continue
    const index = Number(m[1])
    const slot = slots.get(index) ?? {}
    if (m[2] === 'field') slot.field = value
    else slot.direction = value
    slots.set(index, slot)
  }
  if (slots.size === 0) return undefined
  return [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => {
      if (slot.field === undefined) return refuse(invalidRequest())
      return { field: slot.field, direction: direction(slot.direction) }
    })
}

export function queryParams(ctx: Ctx<C>): ListParams {
  const q = ctx.query
  onlyQuery(
    ctx,
    (key) =>
      SCALAR_PARAMS.has(key) ||
      isListKey(key, 'fields') ||
      isListKey(key, 'recordMetadata') ||
      SORT_KEY_RE.test(key),
  )
  checkCellFormat(q.get('cellFormat') ?? undefined)
  boolParam(q.get('includeDateDependencyMetadata'))
  return {
    pageSize: intParam(q.get('pageSize'), 1, MAX_PAGE_SIZE),
    maxRecords: intParam(q.get('maxRecords'), 1, Number.MAX_SAFE_INTEGER),
    offset: q.get('offset') ?? undefined,
    view: q.get('view') ?? undefined,
    fields: listParam(q, 'fields'),
    sort: sortFromQuery(q),
    filterByFormula: q.get('filterByFormula') ?? undefined,
    byId: boolParam(q.get('returnFieldsByFieldId')) ?? false,
    commentCount: checkMetadata(listParam(q, 'recordMetadata') ?? []),
  }
}

function optInt(value: JsonValue | undefined, lo: number, hi: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    return refuse(invalidRequest())
  }
  return value
}

function optStr(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : refuse(invalidRequest())
}

function optStrings(value: JsonValue | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return refuse(invalidRequest())
  }
  return value as string[]
}

// POST .../listRecords: the same parameters, in a JSON body, for a formula or
// field list too long for a URL.
export function bodyParams(ctx: Ctx<C>): ListParams {
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, [...SCALAR_PARAMS, 'fields', 'sort', 'recordMetadata'], invalidRequest)
  checkCellFormat(body.cellFormat)
  optStr(body.timeZone)
  optStr(body.userLocale)
  bodyBool(body.includeDateDependencyMetadata)
  let sort: SortSpec[] | undefined
  if (body.sort !== undefined && body.sort !== null) {
    if (!Array.isArray(body.sort)) return refuse(invalidRequest())
    sort = body.sort.map((item) => {
      if (!isObject(item) || typeof item.field !== 'string') return refuse(invalidRequest())
      return { field: item.field, direction: direction(item.direction) }
    })
  }
  return {
    pageSize: optInt(body.pageSize, 1, MAX_PAGE_SIZE),
    maxRecords: optInt(body.maxRecords, 1, Number.MAX_SAFE_INTEGER),
    offset: optStr(body.offset),
    view: optStr(body.view),
    fields: optStrings(body.fields),
    sort,
    filterByFormula: optStr(body.filterByFormula),
    byId: bodyBool(body.returnFieldsByFieldId),
    commentCount: checkMetadata(optStrings(body.recordMetadata) ?? []),
  }
}

export function compileFilter(table: TableRow, src: string): Compiled {
  try {
    return compileIn(table, src)
  } catch (err: unknown) {
    if (err instanceof UnknownFieldsError) {
      return refuse(badFormula(`Unknown field names: ${err.names.join(', ')}`))
    }
    if (err instanceof FormulaSyntaxError) return refuse(badFormula(INVALID_FORMULA))
    throw err
  }
}

export function passes(world: World, table: TableRow, rec: RecordRow, formula: Compiled): boolean {
  return truthy(
    evaluate(formula, {
      recordId: rec.id,
      value: (id) => formulaInput(world, table, rec, id, 1),
    }),
  )
}

function choiceIndex(field: FieldRow, name: JsonValue): number {
  const choices = field.options?.choices
  if (!Array.isArray(choices)) return -1
  return choices.findIndex((c) => isObject(c) && c.name === name)
}

function compareScalar(a: FValue, b: FValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const ta = String(a ?? '')
  const tb = String(b ?? '')
  const la = ta.toLowerCase()
  const lb = tb.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return ta < tb ? -1 : ta > tb ? 1 : 0
}

// Ascending puts empty cells first, as the Airtable UI does, so descending
// puts them last. A select sorts by its options' order, not alphabetically.
function compareCells(
  world: World,
  field: FieldRow,
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): number {
  const ea = isEmpty(a)
  const eb = isEmpty(b)
  if (ea || eb) return ea === eb ? 0 : ea ? -1 : 1
  if (field.type === 'singleSelect' && a !== undefined && b !== undefined) {
    return choiceIndex(field, a) - choiceIndex(field, b)
  }
  if (field.type === 'multipleSelects' && Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const d = choiceIndex(field, a[i] ?? null) - choiceIndex(field, b[i] ?? null)
      if (d !== 0) return d
    }
    return a.length - b.length
  }
  return compareScalar(scalar(world, field, a, 1), scalar(world, field, b, 1))
}

export function sortRecords(
  world: World,
  table: TableRow,
  rows: readonly RecordRow[],
  keys: ReadonlyArray<{ field: FieldRow; desc: boolean }>,
): RecordRow[] {
  const decorated = rows.map((rec) => ({
    rec,
    values: keys.map((k) => cellValue(world, table, rec, k.field)),
  }))
  decorated.sort((a, b) => {
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      if (key === undefined) continue
      const d = compareCells(world, key.field, a.values[i], b.values[i])
      if (d !== 0) return key.desc ? -d : d
    }
    return a.rec.seq - b.rec.seq
  })
  return decorated.map((d) => d.rec)
}

async function commentCounts(ctx: Ctx<C>, ids: string[]): Promise<Map<string, number>> {
  const rows = all<{ recordId: string }>(
    ctx.sql,
    'SELECT recordId FROM AirtableComment WHERE tenant = ? AND ' +
      'recordId IN (SELECT value FROM json_each(?))',
    ctx.tenant,
    JSON.stringify(ids),
  )
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.recordId, (out.get(row.recordId) ?? 0) + 1)
  return out
}

// One page of a table (or of a view), in this order:
//   through a view, the table's own row order: the fixture's, with creates
//     appended; with no view, record-id order, which live Airtable answers
//     where its Grid view's order differs (MCP-Atlas's recorded list and
//     search calls, replayed by integ/airtable_atlas.ts, and five live tables
//     read on 2026-09-25 -- every one created in a single batch, so none of
//     them tells id order from creation order)
//   minus what the view's filter drops, then what filterByFormula drops
//   sorted by `sort`, else by the view's sort, else left in that order
// A page holds min(pageSize, 100, the fixture's pageCap) records, and never
// runs past maxRecords, after which no offset is handed out.
async function listPage(ctx: Ctx<C>, world: World, table: TableRow, p: ListParams): Promise<Reply> {
  const view =
    p.view === undefined
      ? undefined
      : (table.views.find((v) => v.id === p.view) ??
        table.views.find((v) => v.name === p.view) ??
        refuse(
          world.tables.some((t) => t.views.some((v) => v.id === p.view))
            ? failedStateCheck()
            : viewNotFound(p.view),
        ))
  const only =
    p.fields === undefined
      ? null
      : new Set(p.fields.map((ref) => (fieldByRef(table, ref) ?? refuse(unknownField(ref))).id))
  const sort = p.sort !== undefined && p.sort.length > 0 ? p.sort : (view?.sort ?? [])
  const keys = sort.map((s) => ({
    field: fieldByRef(table, s.field) ?? refuse(unknownField(s.field)),
    desc: s.direction === 'desc',
  }))
  const formula =
    p.filterByFormula === undefined || p.filterByFormula.trim() === ''
      ? null
      : compileFilter(table, p.filterByFormula)
  const viewFilter = view?.filter ? compileIn(table, view.filter) : null
  let rows: RecordRow[] =
    view === undefined
      ? [...table.records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : table.records
  if (viewFilter !== null) rows = rows.filter((r) => passes(world, table, r, viewFilter))
  if (formula !== null) rows = rows.filter((r) => passes(world, table, r, formula))
  if (keys.length > 0) rows = sortRecords(world, table, rows, keys)
  let start = 0
  if (p.offset !== undefined) {
    const at = parseOffset(p.offset, 'rec') ?? refuse(badOffset(p.offset))
    start = resumeAt(rows, at)
  }
  const end = Math.min(rows.length, p.maxRecords ?? Number.POSITIVE_INFINITY)
  const size = Math.min(p.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE, world.pageCap)
  const stop = Math.min(start + size, end)
  const page = start < end ? rows.slice(start, stop) : []
  const counts = p.commentCount
    ? await commentCounts(
        ctx,
        page.map((r) => r.id),
      )
    : null
  const records: JsonValue[] = page.map((rec) => {
    const out = renderRecord(world, table, rec, p.byId, only)
    const n = counts?.get(rec.id) ?? 0
    if (n > 0) out.commentCount = n
    return out
  })
  const body: JsonObject = { records }
  const next = rows[stop]
  if (stop < end && next !== undefined) body.offset = offsetToken(stop, next.id)
  return ok(body)
}

export const listRecordsGet = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  const params = queryParams(ctx)
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  return listPage(ctx, world, tableOf(world, ctx.params.table ?? ''), params)
})

export const listRecordsPost = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  const params = bodyParams(ctx)
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  return listPage(ctx, world, tableOf(world, ctx.params.table ?? ''), params)
})

// A record id the named table does not hold is looked for across the whole
// base before it is refused, and answered with its own table's fields: the
// vendor documents that fallback for this one endpoint.
export const getRecord = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [
    ['base', 'app'],
    ['record', 'rec'],
  ])
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) =>
    [
      'cellFormat',
      'returnFieldsByFieldId',
      'timeZone',
      'userLocale',
      'includeDateDependencyMetadata',
    ].includes(key),
  )
  checkCellFormat(ctx.query.get('cellFormat') ?? undefined)
  const byId = boolParam(ctx.query.get('returnFieldsByFieldId')) ?? false
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const table = tableOf(world, ctx.params.table ?? '')
  const id = ctx.params.record ?? ''
  const home =
    recordIn(table, id) === undefined
      ? world.tables.find((t) => recordIn(t, id) !== undefined)
      : table
  const rec = home === undefined ? undefined : recordIn(home, id)
  if (home === undefined || rec === undefined) return refuse(modelNotFound())
  return ok(renderRecord(world, home, rec, byId))
})

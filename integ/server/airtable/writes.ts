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

import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { authenticate, baseFor, onlyQuery, requireIds, requireWrite, tableOf } from './access.ts'
import type { Principal } from './access.ts'
import { COMPUTED, coerce, renderRecord } from './cells.ts'
import type { WriteCtx } from './cells.ts'
import { MAX_BATCH } from './config.ts'
import type { C } from './config.ts'
import { notePayloads } from './payloads.ts'
import type { TableChanges } from './payloads.ts'
import { fieldById, fieldByRef, optString, recordIn, saveWorld, tableById } from './store.ts'
import type { FieldRow, RecordRow, TableRow, World } from './store.ts'
import {
  apiError,
  badRecords,
  bodyBool,
  bodyOf,
  deleteNotFound,
  guard,
  invalidRequest,
  isId,
  isListKey,
  isObject,
  listParam,
  modelNotFound,
  ok,
  onlyKeys,
  refuse,
  rowDoesNotExist,
  unknownField,
} from './wire.ts'
import type { JsonObject } from './wire.ts'

// Ids a write creates: the kind, `New`, and the run's counter for that kind,
// so the first record a run creates is recNew00000000001 on either host.
export function mintId(ctx: Ctx<C>, kind: string): string {
  return `${kind}New${String(ctx.minter.next(kind)).padStart(11, '0')}`
}

// The field types a performUpsert may merge on, which is the vendor's list:
// number, text, long text, single select, multiple select and date (text
// taken to include its email, url and phone spellings).
const MERGEABLE = new Set([
  'singleLineText',
  'multilineText',
  'email',
  'url',
  'phoneNumber',
  'number',
  'currency',
  'percent',
  'singleSelect',
  'multipleSelects',
  'date',
])

interface Batch {
  ctx: Ctx<C>
  world: World
  table: TableRow
  w: WriteCtx
}

// Save a batch, then hand each webhook on the base the records it made,
// changed and destroyed, table by table, as one payload stamped with the
// write's own time, so a write reads the clock once whether or not a webhook
// is listening.
async function persist(b: Batch, stamp: string): Promise<void> {
  await saveWorld(b.ctx.db, b.world)
  const changes: TableChanges = {}
  for (const table of b.world.tables) {
    const created: JsonObject = {}
    const changed: JsonObject = {}
    for (const rec of table.records) {
      if (rec.state === 'new') {
        created[rec.id] = { createdTime: rec.createdTime, cellValuesByFieldId: rec.cells }
      } else if (rec.state === 'dirty') {
        changed[rec.id] = { current: { cellValuesByFieldId: rec.cells } }
      }
    }
    const destroyed = b.world.removed.filter((r) => r.tableId === table.id).map((r) => r.id)
    const entry: JsonObject = {}
    if (Object.keys(created).length > 0) entry.createdRecordsById = created
    if (Object.keys(changed).length > 0) entry.changedRecordsById = changed
    if (destroyed.length > 0) entry.destroyedRecordIds = destroyed
    if (Object.keys(entry).length > 0) changes[table.id] = entry
  }
  await notePayloads(b.ctx.db, b.world.tenant, b.world.base.id, stamp, changes)
}

async function openBatch(ctx: Ctx<C>, who: Principal, typecast: boolean): Promise<Batch> {
  const world = await baseFor(ctx, who, ctx.params.base ?? '')
  const table = tableOf(world, ctx.params.table ?? '')
  requireWrite(world)
  return {
    ctx,
    world,
    table,
    w: { world, typecast, mint: (kind) => mintId(ctx, kind), seeding: false },
  }
}

function linkIds(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function touch(rec: RecordRow, now: string): void {
  rec.modifiedTime = now
  if (rec.state === 'clean') rec.state = 'dirty'
}

function canon(v: JsonValue | undefined): string {
  return JSON.stringify(v ?? null)
}

function sameCells(a: JsonObject, b: JsonObject): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (canon(a[key]) !== canon(b[key])) return false
  return true
}

// A link is two cells, one on each side, and a write to either keeps the
// other true: linking A to B appends A to B's inverse cell, unlinking removes
// it, and B's lastModifiedTime moves with it.
function syncInverse(
  b: Batch,
  rec: RecordRow,
  field: FieldRow,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  now: string,
): void {
  const linked = tableById(b.world, optString(field, 'linkedTableId') ?? '')
  const inverse =
    linked === undefined
      ? undefined
      : fieldById(linked, optString(field, 'inverseLinkFieldId') ?? '')
  if (linked === undefined || inverse === undefined) return
  const was = linkIds(before)
  const is = linkIds(after)
  for (const id of is) {
    if (was.includes(id)) continue
    const other = recordIn(linked, id)
    const cur = other === undefined ? [] : linkIds(other.cells[inverse.id])
    if (other === undefined || cur.includes(rec.id)) continue
    other.cells[inverse.id] = [...cur, rec.id]
    touch(other, now)
  }
  for (const id of was) {
    if (is.includes(id)) continue
    const other = recordIn(linked, id)
    const cur = other === undefined ? [] : linkIds(other.cells[inverse.id])
    if (other === undefined || !cur.includes(rec.id)) continue
    const kept = cur.filter((x) => x !== rec.id)
    if (kept.length > 0) other.cells[inverse.id] = kept
    else delete other.cells[inverse.id]
    touch(other, now)
  }
}

// The cells a record will hold after this write, validated but not applied.
// PATCH starts from what the record holds; PUT starts from nothing but the
// computed cells, so every writable field the request leaves out is cleared.
function prepare(
  b: Batch,
  before: JsonObject,
  fields: JsonObject,
  destructive: boolean,
): JsonObject {
  const next: JsonObject = {}
  for (const [key, value] of Object.entries(before)) {
    const field = fieldById(b.table, key)
    if (!destructive || (field !== undefined && COMPUTED.has(field.type))) next[key] = value
  }
  for (const [key, value] of Object.entries(fields)) {
    const field = fieldByRef(b.table, key) ?? refuse(unknownField(key))
    const stored = coerce(b.w, field, value, before[field.id])
    if (stored === undefined) delete next[field.id]
    else next[field.id] = stored
  }
  return next
}

function commit(b: Batch, rec: RecordRow, next: JsonObject, now: string): void {
  const before = rec.cells
  rec.cells = next
  for (const field of b.table.fields) {
    if (field.type === 'multipleRecordLinks') {
      syncInverse(b, rec, field, before[field.id], next[field.id], now)
    }
  }
  if (!sameCells(before, next)) touch(rec, now)
}

function newRecord(b: Batch, now: string): RecordRow {
  const seq = b.table.records.reduce((m, r) => Math.max(m, r.seq), -1) + 1
  const rec: RecordRow = {
    id: mintId(b.ctx, 'rec'),
    tableId: b.table.id,
    createdTime: now,
    modifiedTime: now,
    autoNumber: b.table.autoNumberNext,
    cells: {},
    seq,
    state: 'new',
  }
  b.table.autoNumberNext += 1
  b.table.dirty = true
  b.table.records.push(rec)
  return rec
}

function render(b: Batch, recs: RecordRow[], byId: boolean): JsonValue[] {
  return recs.map((rec) => renderRecord(b.world, b.table, rec, byId))
}

function fieldsOf(value: JsonValue | undefined, kind: 'create' | 'update'): JsonObject {
  return isObject(value) ? value : refuse(badRecords(kind))
}

export const createRecords = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, ['records', 'fields', 'typecast', 'returnFieldsByFieldId'], invalidRequest)
  const typecast = bodyBool(body.typecast)
  const byId = bodyBool(body.returnFieldsByFieldId)
  let single = false
  let specs: JsonObject[]
  if (body.records !== undefined && body.records !== null) {
    const list = body.records
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_BATCH ||
      body.fields !== undefined
    ) {
      return refuse(badRecords('create'))
    }
    specs = list.map((item) => {
      if (!isObject(item) || Object.keys(item).some((k) => k !== 'fields')) {
        return refuse(badRecords('create'))
      }
      return fieldsOf(item.fields, 'create')
    })
  } else if (body.fields !== undefined) {
    single = true
    specs = [fieldsOf(body.fields, 'create')]
  } else {
    return refuse(badRecords('create'))
  }
  const b = await openBatch(ctx, who, typecast)
  const prepared = specs.map((fields) => prepare(b, {}, fields, false))
  const now = ctx.clock.nowIso()
  const created = prepared.map((next) => {
    const rec = newRecord(b, now)
    commit(b, rec, next, now)
    return rec
  })
  await persist(b, now)
  const out = render(b, created, byId)
  return ok(single ? (out[0] ?? null) : { records: out })
})

interface UpdateSpec {
  id: string | undefined
  fields: JsonObject
}

function mergeFields(b: Batch, refs: string[]): FieldRow[] {
  return refs.map((ref) => {
    const field = fieldByRef(b.table, ref) ?? refuse(unknownField(ref))
    if (COMPUTED.has(field.type) || !MERGEABLE.has(field.type)) return refuse(invalidRequest())
    return field
  })
}

// The existing records an upsert's incoming record is the same record as:
// every merge field's value, normalized the way the write would store it,
// equal to the record's cell.
function matchesOf(b: Batch, merge: FieldRow[], fields: JsonObject): RecordRow[] {
  const wanted = merge.map((field) => {
    const entry = Object.entries(fields).find(([key]) => fieldByRef(b.table, key)?.id === field.id)
    return entry === undefined ? undefined : coerce(b.w, field, entry[1], undefined)
  })
  return b.table.records.filter((rec) =>
    merge.every((field, i) => canon(rec.cells[field.id]) === canon(wanted[i])),
  )
}

async function updateMany(ctx: Ctx<C>, destructive: boolean): Promise<Reply> {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, ['records', 'typecast', 'returnFieldsByFieldId', 'performUpsert'], invalidRequest)
  const typecast = bodyBool(body.typecast)
  const byId = bodyBool(body.returnFieldsByFieldId)
  let mergeOn: string[] | null = null
  if (body.performUpsert !== undefined && body.performUpsert !== null) {
    const upsert = body.performUpsert
    if (!isObject(upsert)) return refuse(invalidRequest())
    onlyKeys(upsert, ['fieldsToMergeOn'], invalidRequest)
    const refs = upsert.fieldsToMergeOn
    if (
      !Array.isArray(refs) ||
      refs.length < 1 ||
      refs.length > 3 ||
      !refs.every((r) => typeof r === 'string')
    ) {
      return refuse(invalidRequest())
    }
    mergeOn = refs as string[]
  }
  const list = body.records
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
    return refuse(badRecords('update'))
  }
  const specs: UpdateSpec[] = list.map((item) => {
    if (!isObject(item) || Object.keys(item).some((k) => k !== 'id' && k !== 'fields')) {
      return refuse(badRecords('update'))
    }
    const fields = fieldsOf(item.fields, 'update')
    if (item.id === undefined && mergeOn !== null) return { id: undefined, fields }
    if (typeof item.id !== 'string' || !isId('rec', item.id)) return refuse(badRecords('update'))
    return { id: item.id, fields }
  })
  const b = await openBatch(ctx, who, typecast)
  const merge = mergeOn === null ? [] : mergeFields(b, mergeOn)
  // Every target is decided and every cell validated before anything is
  // applied, so a refusal part way through leaves the world as it was. A
  // record named twice sees its first update when its second is prepared.
  const planned = new Map<string, JsonObject>()
  const steps: Array<{ rec: RecordRow | null; next: JsonObject }> = specs.map((spec) => {
    let rec: RecordRow | null
    if (spec.id !== undefined) {
      rec = recordIn(b.table, spec.id) ?? refuse(rowDoesNotExist(spec.id))
    } else {
      const found = matchesOf(b, merge, spec.fields)
      if (found.length > 1) {
        return refuse(
          apiError(
            422,
            'INVALID_RECORDS',
            'More than one existing record matches the fieldsToMergeOn values of a record in the request',
          ),
        )
      }
      rec = found[0] ?? null
    }
    const before = rec === null ? {} : (planned.get(rec.id) ?? rec.cells)
    const next = prepare(b, before, spec.fields, destructive && rec !== null)
    if (rec !== null) planned.set(rec.id, next)
    return { rec, next }
  })
  const now = ctx.clock.nowIso()
  const created: string[] = []
  const updated: string[] = []
  const touched = steps.map((step) => {
    const rec = step.rec ?? newRecord(b, now)
    commit(b, rec, step.next, now)
    if (step.rec === null) created.push(rec.id)
    else updated.push(rec.id)
    return rec
  })
  await persist(b, now)
  const out: JsonObject = { records: render(b, touched, byId) }
  if (mergeOn !== null) {
    out.createdRecords = created
    out.updatedRecords = updated
  }
  return ok(out)
}

export const patchRecords = guard((ctx: Ctx<C>) => updateMany(ctx, false))
export const putRecords = guard((ctx: Ctx<C>) => updateMany(ctx, true))

async function updateOne(ctx: Ctx<C>, destructive: boolean): Promise<Reply> {
  requireIds(ctx, [
    ['base', 'app'],
    ['record', 'rec'],
  ])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const body = bodyOf(ctx)
  onlyKeys(body, ['fields', 'typecast', 'returnFieldsByFieldId'], invalidRequest)
  const typecast = bodyBool(body.typecast)
  const byId = bodyBool(body.returnFieldsByFieldId)
  const fields = isObject(body.fields) ? body.fields : refuse(invalidRequest())
  const b = await openBatch(ctx, who, typecast)
  const rec = recordIn(b.table, ctx.params.record ?? '') ?? refuse(modelNotFound())
  const next = prepare(b, rec.cells, fields, destructive)
  const now = ctx.clock.nowIso()
  commit(b, rec, next, now)
  await persist(b, now)
  return ok(renderRecord(b.world, b.table, rec, byId))
}

export const patchRecord = guard((ctx: Ctx<C>) => updateOne(ctx, false))
export const putRecord = guard((ctx: Ctx<C>) => updateOne(ctx, true))

// A deleted record leaves every link cell that pointed at it, on any table of
// the base, as the vendor's own cascade does.
function remove(b: Batch, recs: RecordRow[], now: string): void {
  const gone = new Set(recs.map((r) => r.id))
  b.table.records = b.table.records.filter((r) => !gone.has(r.id))
  b.world.removed.push(...recs)
  for (const table of b.world.tables) {
    for (const field of table.fields) {
      if (field.type !== 'multipleRecordLinks') continue
      if (optString(field, 'linkedTableId') !== b.table.id) continue
      for (const rec of table.records) {
        const cur = linkIds(rec.cells[field.id])
        if (!cur.some((id) => gone.has(id))) continue
        const kept = cur.filter((id) => !gone.has(id))
        if (kept.length > 0) rec.cells[field.id] = kept
        else delete rec.cells[field.id]
        touch(rec, now)
      }
    }
  }
}

export const deleteRecords = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [['base', 'app']])
  const who = await authenticate(ctx)
  onlyQuery(ctx, (key) => isListKey(key, 'records'))
  const ids = [...new Set(listParam(ctx.query, 'records') ?? [])]
  if (ids.length === 0 || ids.length > MAX_BATCH || !ids.every((id) => isId('rec', id))) {
    return refuse(badRecords('delete'))
  }
  const b = await openBatch(ctx, who, false)
  const recs = ids.map((id) => recordIn(b.table, id) ?? refuse(deleteNotFound(id)))
  const now = ctx.clock.nowIso()
  remove(b, recs, now)
  await persist(b, now)
  return ok({ records: ids.map((id) => ({ id, deleted: true })) })
})

export const deleteRecord = guard(async (ctx: Ctx<C>): Promise<Reply> => {
  requireIds(ctx, [
    ['base', 'app'],
    ['record', 'rec'],
  ])
  const who = await authenticate(ctx)
  onlyQuery(ctx, () => false)
  const b = await openBatch(ctx, who, false)
  const rec = recordIn(b.table, ctx.params.record ?? '') ?? refuse(modelNotFound())
  const now = ctx.clock.nowIso()
  remove(b, [rec], now)
  await persist(b, now)
  return ok({ id: rec.id, deleted: true })
})

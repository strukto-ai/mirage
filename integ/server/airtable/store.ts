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

import type { DatabaseSync } from 'node:sqlite'
import type {
  AirtableBase,
  AirtableField,
  AirtableRecord,
  AirtableTable,
  AirtableView,
} from '../../generated/airtable/index.js'
import { all, exec, one } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { DEFAULT_PAGE_CAP } from './config.ts'
import { isObject } from './wire.ts'
import type { JsonObject } from './wire.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/airtable.prisma declares; rows keep Prisma's generated shapes.
export type Db = DatabaseSync

// Throws when nothing matched, as Prisma's update and delete did.
export function changeOne(db: Db, sql: string, ...params: (string | number | null)[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('airtable fake: no row matched')
}

// One base, loaded whole. A request reads or writes a single base, and every
// computed field reaches at most across that base (a lookup follows a link
// into a sibling table), so the base is the unit a handler works on: load it,
// answer from memory, and for a write persist what changed. The base is a
// handful of tables of tens of records; nothing here is sized for more.

export interface UserRow {
  id: string
  email: string
  name: string
}

export interface FieldRow {
  id: string
  tableId: string
  name: string
  type: string
  description: string | null
  options: JsonObject | null
  seq: number
  dirty: boolean
}

export interface SortSpec {
  field: string
  direction: 'asc' | 'desc'
}

export interface ViewRow {
  id: string
  name: string
  type: string
  filter: string | null
  sort: SortSpec[]
  visibleFieldIds: string[] | null
}

export interface RecordRow {
  id: string
  tableId: string
  createdTime: string
  modifiedTime: string
  autoNumber: number
  cells: JsonObject
  seq: number
  state: 'clean' | 'dirty' | 'new'
}

export interface TableRow {
  id: string
  baseId: string
  name: string
  description: string | null
  primaryFieldId: string
  autoNumberNext: number
  seq: number
  fields: FieldRow[]
  views: ViewRow[]
  records: RecordRow[]
  dirty: boolean
}

export interface BaseRow {
  id: string
  name: string
  permissionLevel: string
}

export interface World {
  tenant: string
  base: BaseRow
  tables: TableRow[]
  users: Map<string, UserRow>
  pageCap: number
  // Records deleted by this request, kept apart so the live `records` lists
  // never hold one and the save still knows what to remove.
  removed: RecordRow[]
}

export function parseJson(raw: string | null): JsonValue | null {
  if (raw === null || raw === '') return null
  return JSON.parse(raw) as JsonValue
}

function parseSort(raw: string | null): SortSpec[] {
  const value = parseJson(raw)
  if (!Array.isArray(value)) return []
  const out: SortSpec[] = []
  for (const item of value) {
    if (!isObject(item) || typeof item.field !== 'string') continue
    out.push({ field: item.field, direction: item.direction === 'desc' ? 'desc' : 'asc' })
  }
  return out
}

function stringList(raw: string | null): string[] | null {
  const value = parseJson(raw)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null
}

export async function pageCapOf(db: Db, tenant: string): Promise<number> {
  const meta = one<{ pageCap: number }>(
    db,
    'SELECT pageCap FROM AirtableMeta WHERE tenant = ?',
    tenant,
  )
  return meta === null ? DEFAULT_PAGE_CAP : meta.pageCap
}

export async function usersOf(db: Db, tenant: string): Promise<Map<string, UserRow>> {
  const rows = all<UserRow>(
    db,
    'SELECT id, email, name FROM AirtableUser WHERE tenant = ? ORDER BY seq',
    tenant,
  )
  return new Map(rows.map((u) => [u.id, { id: u.id, email: u.email, name: u.name }]))
}

// The rows of one of a base's child tables, by table, in seq order.
function inTables<T>(db: Db, sql: string, tenant: string, tableIds: string[]): T[] {
  return all<T>(
    db,
    `${sql} WHERE tenant = ? AND tableId IN (SELECT value FROM json_each(?)) ORDER BY seq`,
    tenant,
    JSON.stringify(tableIds),
  )
}

export async function loadWorld(db: Db, tenant: string, baseId: string): Promise<World | null> {
  const base = one<AirtableBase>(
    db,
    'SELECT tenant, id, name, permissionLevel, seq FROM AirtableBase WHERE tenant = ? AND id = ?',
    tenant,
    baseId,
  )
  if (base === null) return null
  const tables = all<AirtableTable>(
    db,
    'SELECT tenant, id, baseId, name, description, primaryFieldId, autoNumberNext, seq ' +
      'FROM AirtableTable WHERE tenant = ? AND baseId = ? ORDER BY seq',
    tenant,
    baseId,
  )
  const tableIds = tables.map((t) => t.id)
  const fields = inTables<AirtableField>(
    db,
    'SELECT tenant, id, tableId, name, type, description, options, seq FROM AirtableField',
    tenant,
    tableIds,
  )
  const views = inTables<AirtableView>(
    db,
    'SELECT tenant, id, tableId, name, type, "filter", sort, visibleFieldIds, seq FROM AirtableView',
    tenant,
    tableIds,
  )
  const records = inTables<AirtableRecord>(
    db,
    'SELECT tenant, id, tableId, createdTime, modifiedTime, autoNumber, fields, seq ' +
      'FROM AirtableRecord',
    tenant,
    tableIds,
  )
  const rows: TableRow[] = tables.map((t) => ({
    id: t.id,
    baseId: t.baseId,
    name: t.name,
    description: t.description,
    primaryFieldId: t.primaryFieldId,
    autoNumberNext: t.autoNumberNext,
    seq: t.seq,
    dirty: false,
    fields: fields
      .filter((f) => f.tableId === t.id)
      .map((f) => {
        const options = parseJson(f.options)
        return {
          id: f.id,
          tableId: f.tableId,
          name: f.name,
          type: f.type,
          description: f.description,
          options: isObject(options) ? options : null,
          seq: f.seq,
          dirty: false,
        }
      }),
    views: views
      .filter((v) => v.tableId === t.id)
      .map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        filter: v.filter,
        sort: parseSort(v.sort),
        visibleFieldIds: stringList(v.visibleFieldIds),
      })),
    records: records
      .filter((r) => r.tableId === t.id)
      .map((r) => {
        const cells = parseJson(r.fields)
        return {
          id: r.id,
          tableId: r.tableId,
          createdTime: r.createdTime,
          modifiedTime: r.modifiedTime ?? r.createdTime,
          autoNumber: r.autoNumber ?? r.seq + 1,
          cells: isObject(cells) ? cells : {},
          seq: r.seq,
          state: 'clean' as const,
        }
      }),
  }))
  return {
    tenant,
    base: { id: base.id, name: base.name, permissionLevel: base.permissionLevel },
    tables: rows,
    users: await usersOf(db, tenant),
    pageCap: await pageCapOf(db, tenant),
    removed: [],
  }
}

export function recordIn(table: TableRow, id: string): RecordRow | undefined {
  return table.records.find((r) => r.id === id)
}

export function tableById(world: World, id: string): TableRow | undefined {
  return world.tables.find((t) => t.id === id)
}

export function fieldById(table: TableRow, id: string): FieldRow | undefined {
  return table.fields.find((f) => f.id === id)
}

// Ids first, names second: a field may be NAMED like another field's id, and
// the vendor resolves the id.
export function fieldByRef(table: TableRow, ref: string): FieldRow | undefined {
  return table.fields.find((f) => f.id === ref) ?? table.fields.find((f) => f.name === ref)
}

export function optString(field: FieldRow, key: string): string | undefined {
  const v = field.options?.[key]
  return typeof v === 'string' ? v : undefined
}

// Everything a write request changed, in one pass per kind. Comments go with
// their record, because relationMode="prisma" refuses to delete a record that
// a comment still requires.
export async function saveWorld(db: Db, world: World): Promise<void> {
  const tenant = world.tenant
  for (const gone of world.removed) {
    exec(db, 'DELETE FROM AirtableComment WHERE tenant = ? AND recordId = ?', tenant, gone.id)
    changeOne(db, 'DELETE FROM AirtableRecord WHERE tenant = ? AND id = ?', tenant, gone.id)
  }
  for (const table of world.tables) {
    if (table.dirty) {
      changeOne(
        db,
        'UPDATE AirtableTable SET autoNumberNext = ? WHERE tenant = ? AND id = ?',
        table.autoNumberNext,
        tenant,
        table.id,
      )
    }
    for (const field of table.fields) {
      if (!field.dirty) continue
      changeOne(
        db,
        'UPDATE AirtableField SET options = ? WHERE tenant = ? AND id = ?',
        field.options === null ? null : JSON.stringify(field.options),
        tenant,
        field.id,
      )
    }
    for (const rec of table.records) {
      if (rec.state === 'new') {
        exec(
          db,
          'INSERT INTO AirtableRecord (tenant, id, tableId, createdTime, modifiedTime, ' +
            'autoNumber, fields, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          tenant,
          rec.id,
          table.id,
          rec.createdTime,
          rec.modifiedTime,
          rec.autoNumber,
          JSON.stringify(rec.cells),
          rec.seq,
        )
      } else if (rec.state === 'dirty') {
        changeOne(
          db,
          'UPDATE AirtableRecord SET fields = ?, modifiedTime = ?, autoNumber = ? ' +
            'WHERE tenant = ? AND id = ?',
          JSON.stringify(rec.cells),
          rec.modifiedTime,
          rec.autoNumber,
          tenant,
          rec.id,
        )
      }
    }
  }
}

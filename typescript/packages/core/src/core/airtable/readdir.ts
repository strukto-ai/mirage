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
import { enoent } from '../../errors/fs.ts'
import type { FileStat } from '../../types.ts'
import { ContentType, DirListing, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat } from '../hierarchy/stat.ts'
import { listBases, listTables } from './client.ts'
import { asRows, normalizeBase, normalizeTable, toJsonBytes } from './normalize.ts'
import { baseDirname, tableDirname, viewFilename } from './pathing.ts'
import { detectScope } from './scope.ts'

export const BASE = entryStat('base_id', FileType.DIRECTORY)
export const BASE_JSON = entryStat('base_id', ContentType.JSON)
export const TABLE = entryStat('table_id', FileType.DIRECTORY)
export const TABLE_JSON = entryStat('table_id', ContentType.JSON)
export const RECORDS = entryStat('table_id', ContentType.TEXT)
export const VIEWS = entryStat('table_id', FileType.DIRECTORY)
export const VIEW = entryStat('view_id', ContentType.TEXT)

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

// The base listing row base.json renders, rebuilt from the directory's row
// that listing wrote, so its size needs no second call.
function baseRow(entry: FileStat): Record<string, unknown> {
  return {
    id: entry.extra.base_id ?? null,
    name: entry.extra.base_name ?? null,
    permissionLevel: entry.extra.permission_level ?? null,
  }
}

/**
 * A table directory's contents, all known from the base schema.
 * records.jsonl stays size-unknown: its bytes are the table's records,
 * which only a paged read produces.
 */
export function tableChildren(table: Record<string, unknown>, baseId: string): FileStat[] {
  const tableId = text(table, 'id')
  return [
    TABLE_JSON('table.json', tableId, {
      size: toJsonBytes(normalizeTable(table, baseId)).byteLength,
    }),
    RECORDS('records.jsonl', tableId),
    VIEWS('views', tableId),
  ]
}

/** A table's saved views, one size-unknown .jsonl file each. */
export function viewChildren(table: Record<string, unknown>): FileStat[] {
  return asRows(table.views).map((view) => VIEW(viewFilename(view), text(view, 'id')))
}

async function listBasesDir(accessor: AirtableAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  return (await listBases(accessor)).map((base) =>
    BASE(baseDirname(base), text(base, 'id'), {
      extra: {
        base_name: text(base, 'name') || text(base, 'id'),
        permission_level: base.permissionLevel ?? null,
      },
    }),
  )
}

// One schema call answers the base AND every table directory and views
// directory under it, so they are seeded rather than refetched.
async function listBase(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  entry: FileStat,
): Promise<DirListing> {
  const baseId = match.slots.base_id ?? ''
  const tables = await listTables(accessor, baseId)
  const baseJson = toJsonBytes(normalizeBase(baseRow(entry), tables))
  const rows = [BASE_JSON('base.json', baseId, { size: baseJson.byteLength })]
  const seeds = new Map<string, FileStat[]>()
  for (const table of tables) {
    const dirname = tableDirname(table)
    rows.push(TABLE(dirname, text(table, 'id')))
    seeds.set(dirname, tableChildren(table, baseId))
    seeds.set(`${dirname}/views`, viewChildren(table))
  }
  return new DirListing({ entries: rows, seeds })
}

/** The schema of the table a path names, from its base's schema. */
export async function schemaTable(
  accessor: AirtableAccessor,
  match: ScopeMatch,
): Promise<Record<string, unknown>> {
  const tableId = match.slots.table_id ?? ''
  for (const table of await listTables(accessor, match.slots.base_id ?? '')) {
    if (table.id === tableId) return table
  }
  throw enoent(match.vfsPath)
}

async function listTable(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  return tableChildren(await schemaTable(accessor, match), match.slots.base_id ?? '')
}

async function listViews(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  return viewChildren(await schemaTable(accessor, match))
}

export const readdir = makeReaddir<AirtableAccessor>(detectScope, {
  listers: {
    bases: listBasesDir,
  },
  entryListers: {
    base: listBase,
    table: listTable,
    views: listViews,
  },
  staticRoot: ['bases'],
})

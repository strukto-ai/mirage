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
import { IndexEntry } from '../../cache/index/config.ts'
import { enoent } from '../../errors/fs.ts'
import { makeReaddir, type DirListing } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { listBases, listTables } from './client.ts'
import { asRows, normalizeBase, normalizeTable, toJsonBytes } from './normalize.ts'
import { baseDirname, tableDirname, viewFilename } from './pathing.ts'
import { detectScope } from './scope.ts'

type Listing = [string, IndexEntry][]

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

// The base listing row base.json renders, rebuilt from the directory entry
// that listing wrote, so its size needs no second call.
function baseRow(entry: IndexEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    permissionLevel: entry.extra.permission_level ?? null,
  }
}

/**
 * A table directory's contents, all known from the base schema.
 * records.jsonl stays size-unknown: its bytes are the table's records,
 * which only a paged read produces.
 */
export function tableChildren(table: Record<string, unknown>, baseId: string): Listing {
  const tableId = text(table, 'id')
  return [
    [
      'table.json',
      new IndexEntry({
        id: tableId,
        name: 'table.json',
        resourceType: 'airtable/table_json',
        vfsName: 'table.json',
        size: toJsonBytes(normalizeTable(table, baseId)).byteLength,
      }),
    ],
    [
      'records.jsonl',
      new IndexEntry({
        id: tableId,
        name: 'records.jsonl',
        resourceType: 'airtable/records',
        vfsName: 'records.jsonl',
      }),
    ],
    [
      'views',
      new IndexEntry({
        id: tableId,
        name: 'views',
        resourceType: 'airtable/views_dir',
        vfsName: 'views',
      }),
    ],
  ]
}

/** A table's saved views, one size-unknown .jsonl file each. */
export function viewChildren(table: Record<string, unknown>): Listing {
  return asRows(table.views).map((view) => {
    const filename = viewFilename(view)
    return [
      filename,
      new IndexEntry({
        id: text(view, 'id'),
        name: text(view, 'name') || text(view, 'id'),
        resourceType: 'airtable/view',
        vfsName: filename,
      }),
    ]
  })
}

async function listBasesDir(accessor: AirtableAccessor, _match: ScopeMatch): Promise<Listing> {
  return (await listBases(accessor)).map((base) => {
    const dirname = baseDirname(base)
    return [
      dirname,
      new IndexEntry({
        id: text(base, 'id'),
        name: text(base, 'name') || text(base, 'id'),
        resourceType: 'airtable/base',
        vfsName: dirname,
        extra: { permission_level: base.permissionLevel ?? null },
      }),
    ]
  })
}

// One schema call answers the base AND every table directory and views
// directory under it, so they are seeded rather than refetched.
async function listBase(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  entry: IndexEntry,
): Promise<DirListing> {
  const baseId = match.slots.base_id ?? ''
  const tables = await listTables(accessor, baseId)
  const baseJson = toJsonBytes(normalizeBase(baseRow(entry), tables))
  const entries: Listing = [
    [
      'base.json',
      new IndexEntry({
        id: baseId,
        name: 'base.json',
        resourceType: 'airtable/base_json',
        vfsName: 'base.json',
        size: baseJson.byteLength,
      }),
    ],
  ]
  const seeds: Record<string, Listing> = {}
  for (const table of tables) {
    const dirname = tableDirname(table)
    entries.push([
      dirname,
      new IndexEntry({
        id: text(table, 'id'),
        name: text(table, 'name') || text(table, 'id'),
        resourceType: 'airtable/table',
        vfsName: dirname,
      }),
    ])
    seeds[dirname] = tableChildren(table, baseId)
    seeds[`${dirname}/views`] = viewChildren(table)
  }
  return { entries, seeds }
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
  _entry: IndexEntry,
): Promise<Listing> {
  return tableChildren(await schemaTable(accessor, match), match.slots.base_id ?? '')
}

async function listViews(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  _entry: IndexEntry,
): Promise<Listing> {
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

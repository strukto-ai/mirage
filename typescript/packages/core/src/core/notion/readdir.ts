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

import type { NotionAccessor } from '../../accessor/notion.ts'
import { DirListing, FileStat, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat } from '../hierarchy/stat.ts'
import {
  dataSourceSegmentName,
  databaseSegmentName,
  normalizeDataSource,
  normalizeDatabase,
  pageSegmentName,
  toJsonBytes,
} from './normalize.ts'
import {
  getChildPages,
  getDataSource,
  getDatabase,
  searchDataSources,
  searchPages,
} from './pages.ts'
import { formatSegment } from './pathing.ts'
import { detectScope } from './scope.ts'
import { guardRow } from './resolve.ts'

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export const PAGE = entryStat('page_id', FileType.DIRECTORY)
export const DATABASE = entryStat('database_id', FileType.DIRECTORY)
export const DATA_SOURCE = entryStat('data_source_id', FileType.DIRECTORY)

async function listPagesRoot(accessor: NotionAccessor, _match: ScopeMatch): Promise<FileStat[]> {
  const pages = await searchPages(accessor.transport)
  return pages
    .filter((page) => asRecord(page.parent).type === 'workspace')
    .map((page) =>
      PAGE(pageSegmentName(page), pickString(page, 'id'), {
        modified: pickString(page, 'last_edited_time'),
      }),
    )
}

async function listDatabasesRoot(
  accessor: NotionAccessor,
  _match: ScopeMatch,
): Promise<FileStat[]> {
  // Search answers with data sources since 2025-09-03, so the set of
  // databases is their distinct parents. Each one still costs a retrieve,
  // because only the database object carries the title and url this
  // directory is named and rendered from.
  const owners: string[] = []
  for (const dataSource of await searchDataSources(accessor.transport)) {
    const owner = pickString(asRecord(dataSource.parent), 'database_id')
    if (owner !== '' && !owners.includes(owner)) owners.push(owner)
  }
  const rows: FileStat[] = []
  for (const databaseId of owners) {
    const database = await getDatabase(accessor.transport, databaseId)
    rows.push(
      DATABASE(databaseSegmentName(database), databaseId, {
        modified: pickString(database, 'last_edited_time'),
      }),
    )
  }
  return rows
}

async function listPage(
  accessor: NotionAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const pageId = match.slots.page_id ?? match.slots.row_id ?? ''
  const refs = await getChildPages(accessor.transport, pageId)
  // page.json renders from getPage plus the *recursive* block tree while
  // this listing only holds one level of children, so sizing it here would
  // cost an extra call pair per page. It stays size-unknown until a read
  // hydrates it.
  const rows = [new FileStat({ name: 'page.json', type: FileType.FILE })]
  for (const ref of refs) {
    rows.push(
      PAGE(formatSegment({ id: ref.id, title: ref.title }), ref.id, {
        modified: ref.lastEditedTime,
      }),
    )
  }
  return rows
}

async function listDatabase(
  accessor: NotionAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<FileStat[]> {
  const databaseId = match.slots.database_id ?? ''
  const database = await getDatabase(accessor.transport, databaseId)
  // database.json renders the database object this listing already
  // fetched, so its exact size is free here.
  const rows = [
    new FileStat({
      name: 'database.json',
      type: FileType.FILE,
      size: toJsonBytes(normalizeDatabase(database)).byteLength,
      extra: { database_id: databaseId },
    }),
  ]
  for (const stub of asArray(database.data_sources)) {
    const record = asRecord(stub)
    rows.push(
      DATA_SOURCE(dataSourceSegmentName(record), pickString(record, 'id'), {
        modified: pickString(database, 'last_edited_time'),
      }),
    )
  }
  return rows
}

async function listDataSource(
  accessor: NotionAccessor,
  match: ScopeMatch,
  _entry: FileStat,
): Promise<DirListing> {
  const dataSourceId = match.slots.data_source_id ?? ''
  const dataSource = await getDataSource(accessor.transport, dataSourceId)
  // The rows are one file, not one directory each: a query answers a hundred
  // rows' cells a call, while a row directory costs calls of its own to
  // enter, so a walk over a table stays a walk over its pages of query
  // results. rows.jsonl stays size-unknown until a read renders it. A row is
  // still a directory its path reaches, which this listing does not name, so
  // the listing proves nothing absent.
  const extra = { data_source_id: dataSourceId }
  return new DirListing({
    entries: [
      new FileStat({
        name: 'data_source.json',
        type: FileType.FILE,
        size: toJsonBytes(normalizeDataSource(dataSource)).byteLength,
        extra,
      }),
      new FileStat({ name: 'rows.jsonl', type: FileType.FILE, extra }),
    ],
    window: true,
  })
}

export const readdir = makeReaddir<NotionAccessor>(detectScope, {
  listers: {
    pages: listPagesRoot,
    databases: listDatabasesRoot,
  },
  parentEntryListers: { row: listPage },
  entryListers: {
    page: listPage,
    database: listDatabase,
    data_source: listDataSource,
  },
  staticRoot: ['pages', 'databases'],
  guards: { row: guardRow, page: guardRow },
})

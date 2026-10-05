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
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
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

async function listPagesRoot(
  accessor: NotionAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const pages = await searchPages(accessor.transport)
  const topLevel = pages.filter((page) => asRecord(page.parent).type === 'workspace')
  return topLevel.map((page): [string, IndexEntry] => {
    const dirname = pageSegmentName(page)
    return [
      dirname,
      new IndexEntry({
        id: pickString(page, 'id'),
        name: dirname,
        resourceType: 'notion/page',
        remoteTime: pickString(page, 'last_edited_time'),
        vfsName: dirname,
      }),
    ]
  })
}

async function listDatabasesRoot(
  accessor: NotionAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  // Search answers with data sources since 2025-09-03, so the set of
  // databases is their distinct parents. Each one still costs a retrieve,
  // because only the database object carries the title and url this
  // directory is named and rendered from.
  const owners: string[] = []
  for (const dataSource of await searchDataSources(accessor.transport)) {
    const owner = pickString(asRecord(dataSource.parent), 'database_id')
    if (owner !== '' && !owners.includes(owner)) owners.push(owner)
  }
  const entries: [string, IndexEntry][] = []
  for (const databaseId of owners) {
    const database = await getDatabase(accessor.transport, databaseId)
    const name = databaseSegmentName(database)
    entries.push([
      name,
      new IndexEntry({
        id: databaseId,
        name,
        resourceType: 'notion/database',
        remoteTime: pickString(database, 'last_edited_time'),
        vfsName: name,
      }),
    ])
  }
  return entries
}

async function listPage(
  accessor: NotionAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const pageId = match.slots.page_id ?? match.slots.row_id ?? ''
  const refs = await getChildPages(accessor.transport, pageId)
  // page.json renders from getPage plus the *recursive* block tree while
  // this listing only holds one level of children, so sizing it here would
  // cost an extra call pair per page. It stays size-unknown until a read
  // hydrates it.
  const entries: [string, IndexEntry][] = [
    [
      'page.json',
      new IndexEntry({
        id: `${pageId}:page`,
        name: 'page.json',
        resourceType: 'file',
        vfsName: 'page.json',
      }),
    ],
  ]
  for (const ref of refs) {
    const dirname = formatSegment({ id: ref.id, title: ref.title })
    entries.push([
      dirname,
      new IndexEntry({
        id: ref.id,
        name: dirname,
        resourceType: 'notion/page',
        remoteTime: ref.lastEditedTime,
        vfsName: dirname,
      }),
    ])
  }
  return entries
}

async function listDatabase(
  accessor: NotionAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const databaseId = match.slots.database_id ?? ''
  const database = await getDatabase(accessor.transport, databaseId)
  // database.json renders the database object this listing already
  // fetched, so its exact size is free here.
  const entries: [string, IndexEntry][] = [
    [
      'database.json',
      new IndexEntry({
        id: `${databaseId}:database`,
        name: 'database.json',
        resourceType: 'file',
        vfsName: 'database.json',
        size: toJsonBytes(normalizeDatabase(database)).byteLength,
      }),
    ],
  ]
  for (const stub of asArray(database.data_sources)) {
    const record = asRecord(stub)
    const segment = dataSourceSegmentName(record)
    entries.push([
      segment,
      new IndexEntry({
        id: pickString(record, 'id'),
        name: segment,
        resourceType: 'notion/data_source',
        remoteTime: pickString(database, 'last_edited_time'),
        vfsName: segment,
      }),
    ])
  }
  return entries
}

async function listDataSource(
  accessor: NotionAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const dataSourceId = match.slots.data_source_id ?? ''
  const dataSource = await getDataSource(accessor.transport, dataSourceId)
  // The rows are one file, not one directory each: a query answers a hundred
  // rows' cells a call, while a row directory costs calls of its own to
  // enter, so a walk over a table stays a walk over its pages of query
  // results. rows.jsonl stays size-unknown until a read renders it.
  return [
    [
      'data_source.json',
      new IndexEntry({
        id: `${dataSourceId}:data_source`,
        name: 'data_source.json',
        resourceType: 'file',
        vfsName: 'data_source.json',
        size: toJsonBytes(normalizeDataSource(dataSource)).byteLength,
      }),
    ],
    [
      'rows.jsonl',
      new IndexEntry({
        id: `${dataSourceId}:rows`,
        name: 'rows.jsonl',
        resourceType: 'file',
        vfsName: 'rows.jsonl',
      }),
    ],
  ]
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

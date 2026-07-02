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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { databaseSegmentName, pageSegmentName } from './normalize.ts'
import { getChildPages, queryDatabase, searchDatabases, searchTopLevelPages } from './pages.ts'
import { parseSegment, sanitizeName } from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export interface NotionReaddirAccessor {
  readonly transport: NotionTransport
}

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

export async function readdir(
  accessor: NotionReaddirAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  const idxKey = key !== '' ? `/${key}` : '/'

  if (key === '') {
    return [`${prefix}/pages`, `${prefix}/databases`]
  }

  if (key === 'pages') {
    if (index !== undefined) {
      const listing = await index.listDir(idxKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries.map((entry) => `${prefix}${entry}`)
      }
    }
    const pages = await searchTopLevelPages(accessor.transport)
    const entries: [string, IndexEntry][] = []
    for (const page of pages) {
      const dirname = pageSegmentName(page)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(page, 'id'),
          name: dirname,
          resourceType: 'notion/page',
          remoteTime: pickString(page, 'last_edited_time'),
          vfsName: dirname,
        }),
      ])
    }
    if (index !== undefined) await index.setDir(idxKey, entries)
    return entries.map(([name]) => `${prefix}/pages/${name}`)
  }

  if (key === 'databases') {
    if (index !== undefined) {
      const listing = await index.listDir(idxKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries.map((entry) => `${prefix}${entry}`)
      }
    }
    const databases = await searchDatabases(accessor.transport)
    const entries: [string, IndexEntry][] = []
    for (const database of databases) {
      const name = databaseSegmentName(database)
      entries.push([
        name,
        new IndexEntry({
          id: pickString(database, 'id'),
          name,
          resourceType: 'notion/database',
          remoteTime: pickString(database, 'last_edited_time'),
          vfsName: name,
        }),
      ])
    }
    if (index !== undefined) await index.setDir(idxKey, entries)
    return entries.map(([name]) => `${prefix}/databases/${name}`)
  }

  const parts = key.split('/')
  const lastSegment = parts[parts.length - 1] ?? ''

  if (parts[0] === 'databases' && parts.length === 2) {
    let parsedDatabase: { id: string; title: string }
    try {
      parsedDatabase = parseSegment(lastSegment)
    } catch {
      throw enoent(p)
    }
    if (index !== undefined) {
      const listing = await index.listDir(idxKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries.map((entry) => `${prefix}${entry}`)
      }
    }
    const rows = await queryDatabase(accessor.transport, parsedDatabase.id)
    const entries: [string, IndexEntry][] = [
      [
        'database.json',
        new IndexEntry({
          id: `${parsedDatabase.id}:database`,
          name: 'database.json',
          resourceType: 'file',
          vfsName: 'database.json',
        }),
      ],
    ]
    for (const row of rows) {
      if (row.object !== 'page') continue
      const segment = pageSegmentName(row)
      entries.push([
        segment,
        new IndexEntry({
          id: pickString(row, 'id'),
          name: segment,
          resourceType: 'notion/page',
          remoteTime: pickString(row, 'last_edited_time'),
          vfsName: segment,
        }),
      ])
    }
    if (index !== undefined) await index.setDir(idxKey, entries)
    return entries.map(([name]) => `${prefix}/${key}/${name}`)
  }

  if (
    (parts[0] === 'pages' && parts.length >= 2) ||
    (parts[0] === 'databases' && parts.length >= 3)
  ) {
    let parsed: { id: string; title: string }
    try {
      parsed = parseSegment(lastSegment)
    } catch {
      throw enoent(p)
    }
    if (index !== undefined) {
      const listing = await index.listDir(idxKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries.map((entry) => `${prefix}${entry}`)
      }
    }
    const refs = await getChildPages(accessor.transport, parsed.id)
    const entries: [string, IndexEntry][] = [
      [
        'page.json',
        new IndexEntry({
          id: `${parsed.id}:page`,
          name: 'page.json',
          resourceType: 'file',
          vfsName: 'page.json',
        }),
      ],
    ]
    for (const ref of refs) {
      const dirname = `${sanitizeName(ref.title)}__${ref.id}`
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
    if (index !== undefined) await index.setDir(idxKey, entries)
    return entries.map(([name]) => `${prefix}/${key}/${name}`)
  }

  return []
}

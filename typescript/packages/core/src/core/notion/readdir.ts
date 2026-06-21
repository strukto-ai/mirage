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

import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { pageSegmentName } from './normalize.ts'
import { getChildPages, searchTopLevelPages } from './pages.ts'
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
  const prefix = path.prefix
  let p = path.pattern !== null ? path.directory : path.original
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  const idxKey = key !== '' ? `/${key}` : '/'

  if (key === '') {
    return [`${prefix}/pages`]
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

  const parts = key.split('/')
  if (parts.length >= 2 && parts[0] === 'pages') {
    const lastSegment = parts[parts.length - 1] ?? ''
    let parsed: { id: string; title: string }
    try {
      parsed = parseSegment(lastSegment)
    } catch {
      throw enoent(path)
    }
    const pageIdxKey = `/${parts.join('/')}`

    if (index !== undefined) {
      const listing = await index.listDir(pageIdxKey)
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
    if (index !== undefined) await index.setDir(pageIdxKey, entries)

    const base = `${prefix}/${key}`
    return entries.map(([name]) => `${base}/${name}`)
  }

  return []
}

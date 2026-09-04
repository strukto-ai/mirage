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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import type { QdrantRow } from './client.ts'
import { PathSpec } from '../../types.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import type { ReaddirFn } from '../hierarchy/probe.ts'
import { makeReaddir, type DirListing, type Listed, type Lister } from '../hierarchy/readdir.ts'
import { ROOT, type ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes, renderJson, renderText } from './render.ts'
import { detectFor, filtersOf, tableOf } from './scope.ts'
import { globPrefix, globStemPrefix, hasGlobPrefix } from '../../utils/glob_walk.ts'
import { fieldValue, groupName, rowStem } from './fields.ts'

const GROUP_TYPE = 'qdrant/group'

function dirEntry(name: string): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType: GROUP_TYPE, vfsName: name })
}

function blobSize(value: unknown): number | null {
  // A payload whose blob column holds something undecodable must not take
  // the whole listing down with it: leave the size unknown and let read()
  // throw the same error it always did.
  try {
    return blobBytes(value).byteLength
  } catch {
    return null
  }
}

function rowEntries(rows: QdrantRow[], config: QdrantConfigResolved): [string, IndexEntry][] {
  // The scroll already carries every payload, so each file's exact rendered
  // size is free here; stat serves it from the index instead of refetching
  // one row per file.
  const entries: [string, IndexEntry][] = []
  for (const row of rows) {
    const id = String(row[config.idField])
    const stem = rowStem(row, config)
    entries.push([
      `${stem}.json`,
      new IndexEntry({
        id,
        name: `${stem}.json`,
        resourceType: 'qdrant/row_json',
        vfsName: `${stem}.json`,
        size: renderJson(row, config).byteLength,
      }),
    ])
    if (
      config.textField !== null &&
      fieldValue(row, config.textField) !== null &&
      fieldValue(row, config.textField) !== undefined
    ) {
      entries.push([
        `${stem}.txt`,
        new IndexEntry({
          id,
          name: `${stem}.txt`,
          resourceType: 'qdrant/row_text',
          vfsName: `${stem}.txt`,
          size: renderText(row, config).byteLength,
        }),
      ])
    }
    if (
      config.blobField !== null &&
      fieldValue(row, config.blobField) !== null &&
      fieldValue(row, config.blobField) !== undefined
    ) {
      const blobName = `${stem}.${config.blobExt}`
      entries.push([
        blobName,
        new IndexEntry({
          id,
          name: blobName,
          resourceType: 'qdrant/row_blob',
          vfsName: blobName,
          size: blobSize(fieldValue(row, config.blobField)),
        }),
      ])
    }
  }
  return entries
}

/**
 * The point-id prefix a leaf glob narrows the scroll to.
 *
 * A leaf is named `<pointId>` plus whichever suffix the renderer gave it, and
 * only the id half is a prefix the scroll can test.
 */
function rowPrefix(pattern: string | null, config: QdrantConfigResolved): string {
  const suffixes = ['.json']
  if (config.textField !== null && config.textField !== '') suffixes.push('.txt')
  if (config.blobField !== null && config.blobField !== '') suffixes.push(`.${config.blobExt}`)
  return globStemPrefix(pattern, suffixes)
}

async function resolvedFilters(
  accessor: QdrantAccessor,
  table: string,
  filters: Record<string, string>,
): Promise<Record<string, string> | null> {
  const resolved: Record<string, string> = {}
  for (const [column, value] of Object.entries(filters)) {
    if (!accessor.config.basenameFields.includes(column)) {
      resolved[column] = value
      continue
    }
    const values = await accessor.distinct(
      table,
      column,
      resolved,
      accessor.config.maxRows,
      value,
      true,
    )
    const matches = values.filter((raw) => groupName(raw, true) === value)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new Error(
        `qdrant: basename collision for ${JSON.stringify(column)}: ${JSON.stringify(value)}`,
      )
    }
    resolved[column] = matches[0] ?? ''
  }
  return resolved
}

async function children(accessor: QdrantAccessor, match: ScopeMatch): Promise<Listed | null> {
  const config = accessor.config
  const table = tableOf(config, match)
  const pattern = match.pattern
  if (!(await accessor.tableExists(table))) return null
  const filters = await resolvedFilters(accessor, table, filtersOf(config, match))
  if (filters === null) return null
  const depth = Object.keys(filters).length
  if (depth < config.groupBy.length) {
    const displayPrefix = globPrefix(pattern)
    const basename = config.basenameFields.includes(config.groupBy[depth] ?? '')
    const names = await accessor.distinct(
      table,
      config.groupBy[depth] ?? '',
      filters,
      config.maxRows,
      displayPrefix,
      basename,
    )
    const listing: DirListing = {
      entries: names
        .map((name) => groupName(name, basename))
        .filter((name) => name.startsWith(displayPrefix))
        .map((rendered): [string, IndexEntry] => {
          return [rendered, dirEntry(rendered)]
        }),
      seeds: {},
      partial: displayPrefix !== '',
    }
    if (new Set(listing.entries.map(([name]) => name)).size !== listing.entries.length) {
      throw new Error('qdrant: basenameFields produced a path collision')
    }
    return listing
  }
  const prefix = rowPrefix(pattern, config)
  const rows = await accessor.rowsMatching(table, filters, [config.idField], config.maxRows, prefix)
  const listing: DirListing = {
    entries: rowEntries(rows, config),
    seeds: {},
    partial: prefix !== '',
  }
  return listing
}

async function listRoot(accessor: QdrantAccessor, match: ScopeMatch): Promise<Listed | null> {
  const config = accessor.config
  if (config.collection === null) {
    // Collection names come from the catalog, not from a capped scroll, so a
    // glob here has nothing to narrow.
    const tables = await accessor.listTables()
    return tables.map((name): [string, IndexEntry] => [name, dirEntry(name)])
  }
  return children(accessor, match)
}

async function listGroup(accessor: QdrantAccessor, match: ScopeMatch): Promise<Listed | null> {
  return children(accessor, match)
}

const LISTERS: Record<string, Lister<QdrantAccessor>> = {
  [ROOT]: listRoot,
  group: listGroup,
}

const PATTERN_KINDS = { [ROOT]: hasGlobPrefix, group: hasGlobPrefix }

function buildReaddir(accessor: QdrantAccessor): ReaddirFn<QdrantAccessor> {
  return makeReaddir(detectFor(accessor), { listers: LISTERS, patternKinds: PATTERN_KINDS })
}

export const readdirFor = perAccessor(buildReaddir)

export async function readdir(
  accessor: QdrantAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return readdirFor(accessor)(accessor, spec, index)
}

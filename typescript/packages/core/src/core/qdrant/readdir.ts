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
import { DirListing, FileStat, FileType } from '../../types.ts'
import type { QdrantConfigResolved } from '../../vfs/qdrant/config.ts'
import { globPrefix, globStemPrefix } from '../../utils/glob_walk.ts'
import { keptText } from '../../utils/record_search.ts'
import type { Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { blobBytes } from '../vector/read.ts'
import { filtersOf, tableOf } from '../vector/scope.ts'
import { groupName, rowStem } from './naming.ts'
import { fieldValue } from './payload.ts'
import { distinctValues, resolveGroup, rowsMatching, tableExists } from './query.ts'
import { renderJson, renderText } from './render.ts'
import type { QdrantRow } from './types.ts'

function blobSize(value: unknown): number | null {
  // A payload whose blob column holds something undecodable must not take
  // the whole listing down with it: leave the size unknown and let read()
  // throw the same error it always did.
  try {
    return blobBytes(value).byteLength
  } catch (err) {
    console.warn(`qdrant: unsizeable blob value (${String(err)}); size stays unknown`)
    return null
  }
}

function rowFiles(rows: QdrantRow[], config: QdrantConfigResolved): FileStat[] {
  // The scroll already carries every payload, so each file's exact rendered
  // size and text are free here; the mount serves the size from the listing
  // instead of refetching one row per file, and grep checks the text instead
  // of reading it.
  const listed: FileStat[] = []
  for (const row of rows) {
    const stem = rowStem(row, config)
    const rendered = renderJson(row, config)
    listed.push(
      new FileStat({
        name: `${stem}.json`,
        type: FileType.FILE,
        size: rendered.byteLength,
        extra: keptText(rendered),
      }),
    )
    if (
      config.textField !== null &&
      fieldValue(row, config.textField) !== null &&
      fieldValue(row, config.textField) !== undefined
    ) {
      const text = renderText(row, config)
      listed.push(
        new FileStat({
          name: `${stem}.txt`,
          type: FileType.FILE,
          size: text.byteLength,
          extra: keptText(text),
        }),
      )
    }
    if (
      config.blobField !== null &&
      fieldValue(row, config.blobField) !== null &&
      fieldValue(row, config.blobField) !== undefined
    ) {
      listed.push(
        new FileStat({
          name: `${stem}.${config.blobExt}`,
          type: FileType.FILE,
          size: blobSize(fieldValue(row, config.blobField)),
        }),
      )
    }
  }
  return listed
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
    const sources = await resolveGroup(accessor, table, column, resolved, value, true)
    if (sources.length === 0) return null
    if (sources.length > 1) {
      throw new Error(
        `qdrant: basename collision for ${JSON.stringify(column)}: ${JSON.stringify(value)}`,
      )
    }
    resolved[column] = sources[0] ?? ''
  }
  return resolved
}

/** The entries under a collection or a group. */
export async function children(
  accessor: QdrantAccessor,
  match: ScopeMatch,
): Promise<Listed | null> {
  const config = accessor.config
  const table = tableOf(config.collection, match)
  const pattern = match.pattern
  if (!(await tableExists(accessor, table))) return null
  const filters = await resolvedFilters(accessor, table, filtersOf(config.groupBy, match))
  if (filters === null) return null
  const depth = Object.keys(filters).length
  if (depth < config.groupBy.length) {
    const displayPrefix = globPrefix(pattern)
    const basename = config.basenameFields.includes(config.groupBy[depth] ?? '')
    const names = await distinctValues(
      accessor,
      table,
      config.groupBy[depth] ?? '',
      filters,
      config.maxRows,
      displayPrefix,
      basename,
    )
    const rendered = names
      .map((name) => groupName(name, basename))
      .filter((name) => name.startsWith(displayPrefix))
    if (new Set(rendered).size !== rendered.length) {
      throw new Error('qdrant: basenameFields produced a path collision')
    }
    return new DirListing({
      entries: rendered.map((name) => new FileStat({ name, type: FileType.DIRECTORY })),
      partial: displayPrefix !== '',
      window: true,
    })
  }
  const prefix = rowPrefix(pattern, config)
  const rows = await rowsMatching(accessor, table, filters, config.maxRows, prefix)
  return new DirListing({ entries: rowFiles(rows, config), partial: prefix !== '', window: true })
}

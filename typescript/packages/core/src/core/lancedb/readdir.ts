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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { LanceDBConfigResolved } from '../../vfs/lancedb/config.ts'
import { globPrefix, globStemPrefix } from '../../utils/glob_walk.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { PATH_SAFE } from '../hierarchy/codec.ts'
import type { DirListing, Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { dirEntry } from '../vector/readdir.ts'
import { filtersOf, tableOf } from '../vector/scope.ts'
import { tableExists } from './query.ts'
import type { LanceRow, ValueTest } from './types.ts'
import { cellText, renderCard } from './render.ts'

function rowEntries(rows: LanceRow[], config: LanceDBConfigResolved): [string, IndexEntry][] {
  // The widened select carries every rendered column, so each card's exact
  // size is free here; blob values are deliberately not fetched at listing
  // time, so blob entries stay size-unknown and stat renders them itself.
  const entries: [string, IndexEntry][] = []
  for (const row of rows) {
    const id = cellText(row[config.idColumn])
    entries.push([
      `${id}.md`,
      new IndexEntry({
        id,
        name: `${id}.md`,
        resourceType: 'lancedb/row_card',
        vfsName: `${id}.md`,
        size: renderCard(row, config).byteLength,
      }),
    ])
    if (config.blobColumn !== null) {
      const blobName = `${id}.${config.blobExt}`
      entries.push([
        blobName,
        new IndexEntry({
          id,
          name: blobName,
          resourceType: 'lancedb/row_blob',
          vfsName: blobName,
        }),
      ])
    }
  }
  return entries
}

/** Keep values whose rendered name starts with a glob's literal head. */
function renderedPrefixTest(prefix: string): ValueTest {
  return (value) => PATH_SAFE.encode(value).startsWith(prefix)
}

/**
 * The row-id prefix a leaf glob narrows the row query to.
 *
 * A leaf is named `<rowId>` plus whichever suffix the renderer gave it, and
 * only the id half is a prefix the query can test.
 */
function rowPrefix(pattern: string | null, config: LanceDBConfigResolved): string {
  const suffixes = ['.md']
  if (config.blobColumn !== null && config.blobColumn !== '') suffixes.push(`.${config.blobExt}`)
  return globStemPrefix(pattern, suffixes)
}

/** The entries under a table or a group. */
export async function children(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
): Promise<Listed | null> {
  const config = accessor.config
  const table = tableOf(config.table, match)
  const filters = filtersOf(config.groupBy, match)
  const pattern = match.pattern
  if (!(await tableExists(accessor, table))) return null
  const depth = Object.keys(filters).length
  if (depth < config.groupBy.length) {
    const displayPrefix = globPrefix(pattern)
    // Values render path-safe, so a glob's head is spelled in rendered names:
    // the query takes the value prefix the head stands for, which loses
    // nothing, and the cap counts the renderings that really start with the
    // head, so a head no value prefix spells (the escape lead alone) still
    // reaches past the rows at the head of the table.
    const values = await accessor.driver.distinct(
      table,
      config.groupBy[depth] ?? '',
      filters,
      config.maxRows,
      PATH_SAFE.prefixValue(displayPrefix),
      displayPrefix === '' ? undefined : renderedPrefixTest(displayPrefix),
    )
    const names = values.map((value) => PATH_SAFE.encode(value)).sort(compareCodePoints)
    const listing: DirListing = {
      entries: names.map((name): [string, IndexEntry] => [name, dirEntry('lancedb', name)]),
      seeds: {},
      partial: displayPrefix !== '',
      window: true,
    }
    return listing
  }
  // Select every column except the vector and blob ones (schema order, so
  // the projected rows render byte-identically to the full rows read()
  // fetches). Still one data query; the schema lookup is local metadata on
  // the already-opened table.
  const columns = (await accessor.driver.tableColumns(table)).filter(
    (c) => c !== config.vectorColumn && c !== config.blobColumn,
  )
  const prefix = rowPrefix(pattern, config)
  const rows = await accessor.driver.rowsMatching(
    table,
    filters,
    columns,
    config.maxRows,
    config.idColumn,
    prefix,
  )
  const listing: DirListing = {
    entries: rowEntries(rows, config),
    seeds: {},
    partial: prefix !== '',
    window: true,
  }
  return listing
}

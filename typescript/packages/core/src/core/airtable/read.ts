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
import type { FileStat, PathSpec } from '../../types.ts'
import { efbig, enoent, isEnoent } from '../../errors/fs.ts'
import { makeRead, perKind, type ReadWindow } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { listBases, listRecords, listTables, recordPages } from './client.ts'
import { AirtableApiError } from './errors.ts'
import { normalizeBase, normalizeTable, recordsJsonl, toJsonBytes } from './normalize.ts'
import { schemaTable } from './readdir.ts'
import { detectScope } from './scope.ts'

/**
 * Refuse a file its parent listing does not hold. `makeRead` proves every
 * file's parent by the row the mount hands. A view file is named by its view
 * id, so under a real `views` directory a wrong name, or another table's view
 * id, is still the reader's to prove: without this `jq` would read it while
 * `stat` and `cat` call it absent, and a foreign id would reach the API as a
 * raw 422.
 */
function ensureListed(path: PathSpec, entry: FileStat | null): void {
  if (entry === null) throw enoent(path)
}

async function readBaseJson(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const baseId = match.slots.base_id ?? ''
  for (const base of await listBases(accessor)) {
    if (base.id === baseId) {
      return toJsonBytes(normalizeBase(base, await listTables(accessor, baseId)))
    }
  }
  throw enoent(path)
}

async function readTableJson(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  let table: Record<string, unknown>
  try {
    table = await schemaTable(accessor, match)
  } catch (err) {
    if (isEnoent(err)) throw enoent(path)
    throw err
  }
  return toJsonBytes(normalizeTable(table, match.slots.base_id ?? ''))
}

async function renderRecords(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  view: string | undefined,
  window: ReadWindow,
): Promise<Uint8Array> {
  const cap = accessor.maxReadRecords
  const skip = window.offset ?? 0
  const limit = window.limit ?? null
  // A window is a record count pushed into maxRecords. One record past the
  // cap proves the full answer would exceed it, without paging through the
  // rest of a large table first.
  const wanted = limit === null ? cap + 1 : Math.min(skip + limit, cap + 1)
  let found: Record<string, unknown>[]
  try {
    found = await listRecords(accessor, match.slots.base_id ?? '', match.slots.table_id ?? '', {
      ...(view !== undefined ? { view } : {}),
      maxRecords: wanted,
    })
  } catch (err) {
    if (err instanceof AirtableApiError && err.notFound) throw enoent(path)
    throw err
  }
  // EFBIG, reported per operand as `<cmd>: <path>: File too large`: the
  // whole file would render more than this mount allows.
  if (found.length > cap) throw efbig(path)
  return recordsJsonl(found.slice(skip))
}

function readRecords(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _entry: FileStat | null,
  _parent: FileStat | null,
  window: ReadWindow,
): Promise<Uint8Array> {
  return renderRecords(accessor, match, path, undefined, window)
}

async function readView(
  accessor: AirtableAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  _parent: FileStat | null,
  window: ReadWindow,
): Promise<Uint8Array> {
  ensureListed(path, entry)
  return renderRecords(accessor, match, path, match.slots.view_id ?? '', window)
}

export const read = makeRead<AirtableAccessor>(
  detectScope,
  {
    base_json: readBaseJson,
    table_json: readTableJson,
  },
  {
    windowed: {
      records: readRecords,
      view: readView,
    },
    parented: true,
  },
)

/**
 * Stream a records or view file a page of records at a time, the next page
 * fetched only when the caller pulls it; any other file comes whole, as
 * `read` gives it. A table or view past `maxReadRecords` throws EFBIG once
 * that many records are out, rather than refusing them whole: a stream cannot
 * know a table's size before it has paged through it, and a reader that stops
 * first (`head -c`, `grep -l`) never reaches it. Mirrors Python's
 * `read_stream`.
 */
export async function* readStream(
  accessor: AirtableAccessor,
  path: PathSpec,
  entry: FileStat | null = null,
  parent: FileStat | null = null,
): AsyncGenerator<Uint8Array, void> {
  const match = detectScope(path)
  if (match.kind !== 'records' && match.kind !== 'view') {
    yield await read(accessor, path, entry, parent)
    return
  }
  if (parent === null) throw enoent(path)
  let view: string | undefined
  if (match.kind === 'view') {
    ensureListed(path, entry)
    view = match.slots.view_id ?? ''
  }
  const cap = accessor.maxReadRecords
  let sent = 0
  try {
    for await (const page of recordPages(
      accessor,
      match.slots.base_id ?? '',
      match.slots.table_id ?? '',
      { ...(view !== undefined ? { view } : {}), maxRecords: cap + 1 },
    )) {
      const kept = page.slice(0, cap - sent)
      sent += kept.length
      if (kept.length > 0) yield recordsJsonl(kept)
      if (kept.length < page.length) throw efbig(path)
    }
  } catch (err) {
    if (err instanceof AirtableApiError && err.notFound) throw enoent(path)
    throw err
  }
}

/**
 * The first `n` records of a records or view file, by `maxRecords`, each on
 * its own line. A count past `maxReadRecords` that the table fills throws
 * EFBIG, as a whole read of that table does. Mirrors `_first_records` in
 * `mirage/core/airtable/read.py`.
 */
function firstRecords(
  accessor: AirtableAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  n: number,
  entry: FileStat | null = null,
  parent: FileStat | null = null,
): Promise<Uint8Array> {
  return read(accessor, path, entry, parent, { limit: n })
}

export const firstLines = perKind(detectScope, { records: firstRecords, view: firstRecords })

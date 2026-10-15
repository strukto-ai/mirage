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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { encodeBase64 } from '../../utils/base64.ts'
import { efbig } from '../../errors/fs.ts'
import { jsonBytes } from '../render/json.ts'
import type { PostgresAccessor } from '../../accessor/postgres.ts'
import {
  makeRead,
  perKind,
  type Reader,
  type ReadWindow,
  type WindowedReader,
} from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import {
  countRows,
  estimateSize,
  fetchBoundedRows,
  fetchColumns,
  fetchLastRows,
  fetchRowKey,
  fetchRows,
  fetchRowsAfter,
} from './client.ts'
import { abortable, sleep } from '../../utils/abort.ts'
import { entityGuard } from './readdir.ts'
import { buildDatabaseJson, buildEntitySchemaJson } from './_schema_json.ts'
import { buildEntitySemanticJson } from './semantic.ts'
import { detectScope } from './scope.ts'
import { stat } from './stat.ts'

export interface ReadOptions {
  limit?: number | null
  offset?: number | null
}

/**
 * Stream a keyed table's rows.jsonl a page of rows at a time, in key order,
 * the next page fetched only when the caller pulls it; any other file, a
 * window, and a relation with no row key (`fetchRowKey`) comes whole, as
 * `read` gives it. A table past `maxReadRows` rows or `maxReadBytes` bytes
 * throws EFBIG once that much is out, rather than refusing it whole: a stream
 * cannot know a table's size before it has paged through it, and a reader that
 * stops first (`head -c`, `grep -l`) never reaches it. Each page asks for one
 * row past what the row cap leaves and is sent only when it fits what the byte
 * cap leaves, so no page holds more than the caps allow; a page that does not
 * fit is asked again at half its rows, down to one row past the cap, so the
 * rows that fit still come out before the refusal. Mirrors Python's
 * `read_stream`.
 */
export async function* readStream(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
  options: ReadOptions = {},
): AsyncIterable<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const match = detectScope(spec)
  const schema = match.slots.schema ?? ''
  const entity = match.slots.entity ?? ''
  let pk: string[] = []
  let columns: ReadonlySet<string> = new Set()
  if (match.kind === 'entity_rows' && options.limit == null && options.offset == null) {
    await entityGuard(accessor, match, spec.virtual)
    pk = await fetchRowKey(accessor, schema, entity)
    columns = await columnNames(accessor, schema, entity)
  }
  if (pk.length === 0) {
    yield await read(accessor, path, index, options)
    return
  }
  const cfg = accessor.config
  const encoder = new TextEncoder()
  let rowsOut = 0
  let bytesOut = 0
  let size = cfg.defaultRowLimit
  let after: readonly unknown[] | null = null
  for (;;) {
    const limit = Math.min(size, cfg.maxReadRows - rowsOut + 1)
    const [rows, last] = await fetchRowsAfter(
      accessor,
      schema,
      entity,
      pk,
      after,
      limit,
      columns,
      cfg.maxReadBytes - bytesOut,
    )
    if (rows === null) {
      if (limit === 1) throw efbig(spec)
      size = Math.floor(limit / 2)
      continue
    }
    after = last
    const page: string[] = []
    for (const row of rows) {
      const line = rowLine(row) + '\n'
      rowsOut += 1
      bytesOut += encoder.encode(line).byteLength
      if (rowsOut > cfg.maxReadRows || bytesOut > cfg.maxReadBytes) {
        if (page.length > 0) yield encoder.encode(page.join(''))
        throw efbig(spec)
      }
      page.push(line)
    }
    if (page.length > 0) yield encoder.encode(page.join(''))
    if (rows.length < limit) return
  }
}

/**
 * A relation's column names, which a byte-bounded page keeps its size marker
 * clear of. Mirrors Python's `_column_names`.
 */
async function columnNames(
  accessor: PostgresAccessor,
  schema: string,
  entity: string,
): Promise<ReadonlySet<string>> {
  return new Set((await fetchColumns(accessor, schema, entity)).map((column) => column.name))
}

function entityKind(match: ScopeMatch): 'table' | 'view' {
  return (match.slots.kind ?? '') === 'tables' ? 'table' : 'view'
}

const readDatabaseJson: Reader<PostgresAccessor> = async (accessor) =>
  jsonBytes(await buildDatabaseJson(accessor))

const readEntitySchema: Reader<PostgresAccessor> = async (accessor, match) =>
  jsonBytes(
    await buildEntitySchemaJson(
      accessor,
      match.slots.schema ?? '',
      match.slots.entity ?? '',
      entityKind(match),
    ),
  )

const readEntitySemantic: Reader<PostgresAccessor> = async (accessor, match) =>
  jsonBytes(
    await buildEntitySemanticJson(
      accessor,
      match.slots.schema ?? '',
      match.slots.entity ?? '',
      entityKind(match),
    ),
  )

const readEntityRows: WindowedReader<PostgresAccessor> = (accessor, match, path, _index, window) =>
  readRows(accessor, match.slots.schema ?? '', match.slots.entity ?? '', path, window)

const kitRead = makeRead<PostgresAccessor>(
  detectScope,
  {
    database_json: readDatabaseJson,
    entity_schema: readEntitySchema,
    entity_semantic: readEntitySemantic,
  },
  { windowed: { entity_rows: readEntityRows }, stat },
)

export async function read(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return kitRead(accessor, spec, index, options)
}

/**
 * Render a relation's rows.jsonl, or the window `options` picks. The whole file
 * when neither limit nor offset is given, under the size guard: past
 * `maxReadRows` rows or `maxReadBytes` bytes it throws EFBIG, which a command
 * reports as `<cmd>: <path>: File too large` before moving on to its next
 * operand, as for an Airtable table past its cap. `path` is the rows.jsonl the
 * refusal names. Mirrors `read_rows` in `mirage/core/postgres/read.py`.
 */
export async function readRows(
  accessor: PostgresAccessor,
  schema: string,
  entity: string,
  path: string | PathSpec,
  options: ReadWindow = {},
): Promise<Uint8Array> {
  const cfg = accessor.config
  const limit = options.limit ?? null
  const offset = options.offset ?? null
  let effectiveLimit: number
  let effectiveOffset: number

  const whole = limit === null && offset === null
  if (whole) {
    const [rows, width] = await estimateSize(accessor, schema, entity)
    const widthEffective = Math.max(width, 1)
    if (rows > cfg.maxReadRows || rows * widthEffective > cfg.maxReadBytes) throw efbig(path)
    // The estimate only refuses; it never limits. It is planner statistics,
    // which lag the table (a bulk load before the next ANALYZE), so taking it
    // as the LIMIT returned fewer rows than exist, with nothing to say so. One
    // row past the ceiling keeps the read bounded and refuses a table the
    // estimate undercounted on the rows it really has.
    effectiveLimit = cfg.maxReadRows + 1
    effectiveOffset = 0
  } else {
    effectiveLimit = limit ?? cfg.defaultRowLimit
    effectiveOffset = offset ?? 0
  }

  const data = whole
    ? await fetchBoundedRows(accessor, schema, entity, {
        limit: effectiveLimit,
        maxBytes: cfg.maxReadBytes,
      })
    : await fetchRows(accessor, schema, entity, {
        limit: effectiveLimit,
        offset: effectiveOffset,
      })
  if (data === null || (whole && data.length > cfg.maxReadRows)) throw efbig(path)
  if (data.length === 0) return new Uint8Array()
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  for (const row of data) {
    const line = encoder.encode(rowLine(row) + '\n')
    size += line.byteLength
    if (whole && size > cfg.maxReadBytes) throw efbig(path)
    chunks.push(line)
  }
  const body = new Uint8Array(size)
  let position = 0
  for (const chunk of chunks) {
    body.set(chunk, position)
    position += chunk.byteLength
  }
  return body
}

/**
 * The first `n` rows of a relation's rows.jsonl, by a `LIMIT`. `maxReadRows`
 * is the most rows one read may return, so a count past it fetches one row
 * more than the ceiling and throws EFBIG when that row exists, as a whole read
 * of a relation that long does; a relation shorter than the ceiling comes back
 * whole. Mirrors `_first_rows` in `mirage/core/postgres/read.py`.
 */
async function firstRows(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  path: PathSpec,
  n: number,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const cap = accessor.config.maxReadRows
  const data = await readRows(accessor, match.slots.schema ?? '', match.slots.entity ?? '', path, {
    limit: Math.min(n, cap + 1),
  })
  let lines = 0
  for (const byte of data) if (byte === 0x0a) lines += 1
  if (lines > cap) throw efbig(path)
  return data
}

/**
 * The last `n` rows of a relation's rows.jsonl, by a `COUNT(*)` and an
 * `OFFSET`. A suffix longer than `maxReadRows` throws EFBIG, as a whole read
 * of a relation that long does. Mirrors `_last_rows` in
 * `mirage/core/postgres/read.py`.
 */
async function lastRows(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  path: PathSpec,
  n: number,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const schema = match.slots.schema ?? ''
  const entity = match.slots.entity ?? ''
  const cap = accessor.config.maxReadRows
  const pk = await fetchRowKey(accessor, schema, entity)
  if (pk.length > 0) {
    const [rows] = await fetchLastRows(
      accessor,
      schema,
      entity,
      pk,
      Math.min(n, cap + 1),
      await columnNames(accessor, schema, entity),
    )
    if (rows.length > cap) throw efbig(path)
    return lines(rows)
  }
  const total = await countRows(accessor, schema, entity)
  const limit = Math.min(n, total)
  if (limit > accessor.config.maxReadRows) throw efbig(path)
  if (limit === 0) return new Uint8Array()
  return readRows(accessor, schema, entity, path, { limit, offset: total - limit })
}

/**
 * How many rows a relation holds, one line each in its rows.jsonl, by a
 * `COUNT(*)`. Mirrors `_row_count` in `mirage/core/postgres/read.py`.
 */
function rowCount(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  _path: PathSpec,
  _index?: IndexCacheStore,
): Promise<number> {
  return countRows(accessor, match.slots.schema ?? '', match.slots.entity ?? '')
}

/** Rows as their rows.jsonl lines. Mirrors Python's `_lines`. */
function lines(rows: readonly Record<string, unknown>[]): Uint8Array {
  return new TextEncoder().encode(rows.map((row) => rowLine(row) + '\n').join(''))
}

/**
 * A keyed table's last `n` rows, then each row whose key sorts past them,
 * asked for every `interval` seconds; null for a relation with no primary
 * key, whose rows have no end a new one lands at. The file lists rows in key
 * order, so a row lands at its end exactly when its key sorts past the last
 * one: each ask starts at the last key seen, and none is printed twice. A row
 * whose key sorts before it lands in the middle of the file, where `tail -f`
 * never looks. Mirrors Python's `_follow_rows`.
 */
async function followRows(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  path: PathSpec,
  n: number,
  interval: number,
  _index?: IndexCacheStore,
): Promise<AsyncIterableIterator<Uint8Array> | null> {
  const schema = match.slots.schema ?? ''
  const entity = match.slots.entity ?? ''
  const cap = accessor.config.maxReadRows
  const pk = await fetchRowKey(accessor, schema, entity)
  if (pk.length === 0) return null
  const columns = await columnNames(accessor, schema, entity)
  const [rows, after] = await fetchLastRows(
    accessor,
    schema,
    entity,
    pk,
    Math.max(Math.min(n, cap + 1), 1),
    columns,
  )
  if (rows.length > cap) throw efbig(path)
  return followedRows(accessor, path, pk, columns, after, n > 0 ? rows.slice(-n) : [], interval)
}

/**
 * `rows`, then each row past `after` every `interval` seconds, as rows.jsonl
 * lines. One ask whose rows pass `maxReadBytes` throws EFBIG before any of
 * them is sent. An iterator rather than a generator, so closing ends a pull
 * waiting out its interval, as `followedDay` does. Mirrors Python's
 * `_followed_rows`.
 */
function followedRows(
  accessor: PostgresAccessor,
  path: PathSpec,
  pk: readonly string[],
  columns: ReadonlySet<string>,
  after: readonly unknown[] | null,
  rows: readonly Record<string, unknown>[],
  interval: number,
): AsyncIterableIterator<Uint8Array> {
  const match = detectScope(path)
  const schema = match.slots.schema ?? ''
  const entity = match.slots.entity ?? ''
  const cfg = accessor.config
  let pending: Uint8Array | null = rows.length > 0 ? lines(rows) : null
  let last = after
  const stop = new AbortController()
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (pending !== null) {
        const value = pending
        pending = null
        return { value, done: false }
      }
      try {
        for (;;) {
          await sleep(interval * 1000, stop.signal)
          const [added, next] = await abortable(
            fetchRowsAfter(
              accessor,
              schema,
              entity,
              pk,
              last,
              cfg.defaultRowLimit,
              columns,
              cfg.maxReadBytes,
            ),
            stop.signal,
          )
          if (added === null) throw efbig(path)
          last = next
          if (added.length > 0) return { value: lines(added), done: false }
        }
      } catch (err) {
        if (stop.signal.aborted) return done
        throw err
      }
    },
    return(): Promise<IteratorResult<Uint8Array>> {
      stop.abort()
      pending = null
      return Promise.resolve(done)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

export const firstLines = perKind(detectScope, { entity_rows: firstRows }, { guard: entityGuard })
export const lastLines = perKind(detectScope, { entity_rows: lastRows }, { guard: entityGuard })
export const lineCount = perKind(detectScope, { entity_rows: rowCount }, { guard: entityGuard })
export const follow = perKind(detectScope, { entity_rows: followRows }, { guard: entityGuard })

/** One row as rows.jsonl spells it. Mirrors `row_line` in `core/postgres/read.py`. */
export function rowLine(row: Record<string, unknown>): string {
  return JSON.stringify(row, jsonReplacer)
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return encodeBase64(value)
  return value
}

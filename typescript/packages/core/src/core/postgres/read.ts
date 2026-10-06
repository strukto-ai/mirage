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
import { makeRead, type Reader, type ReadWindow, type WindowedReader } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { estimateSize, fetchBoundedRows, fetchRows } from './client.ts'
import { buildDatabaseJson, buildEntitySchemaJson } from './_schema_json.ts'
import { buildEntitySemanticJson } from './semantic.ts'
import { detectScope } from './scope.ts'
import { stat } from './stat.ts'

export interface ReadOptions {
  limit?: number | null
  offset?: number | null
}

export async function* readStream(
  accessor: PostgresAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
  options: ReadOptions = {},
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index, options)
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

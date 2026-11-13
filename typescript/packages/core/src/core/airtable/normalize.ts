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

import type { JsonObject } from '../../types.ts'
import { isRecord } from '../../utils/records.ts'
import { jsonlBytes } from '../render/json.ts'

/** A decoded JSON object, or an empty one for anything else. */
export function asRow(value: unknown): JsonObject {
  return isRecord(value) ? value : {}
}

/** The objects of a decoded JSON array; anything else holds none. */
export function asRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** One base as the listing names it: id, name and permission level. */
export function normalizeBaseSummary(base: JsonObject): JsonObject {
  return {
    base_id: base.id ?? null,
    base_name: base.name ?? null,
    permission_level: base.permissionLevel ?? null,
  }
}

/** base.json: the base and the tables it holds. */
export function normalizeBase(base: JsonObject, tables: readonly JsonObject[]): JsonObject {
  return {
    ...normalizeBaseSummary(base),
    tables: tables.map((table) => ({
      table_id: table.id ?? null,
      table_name: table.name ?? null,
      primary_field_id: table.primaryFieldId ?? null,
    })),
  }
}

/** One column: its id, name, type and the type's options. */
export function normalizeField(column: JsonObject): JsonObject {
  return {
    field_id: column.id ?? null,
    field_name: column.name ?? null,
    type: column.type ?? null,
    description: column.description ?? null,
    options: column.options ?? null,
  }
}

/** One saved view: its id, name and kind (grid, kanban, ...). */
export function normalizeView(view: JsonObject): JsonObject {
  return {
    view_id: view.id ?? null,
    view_name: view.name ?? null,
    type: view.type ?? null,
  }
}

/** table.json: the column schema and the saved views. */
export function normalizeTable(table: JsonObject, baseId: string): JsonObject {
  return {
    table_id: table.id ?? null,
    table_name: table.name ?? null,
    base_id: baseId,
    description: table.description ?? null,
    primary_field_id: table.primaryFieldId ?? null,
    fields: asRows(table.fields).map(normalizeField),
    views: asRows(table.views).map(normalizeView),
  }
}

/**
 * One records.jsonl row. `fields` is Airtable's cell map, keyed by field
 * name and passed through untouched: an empty cell is absent (Airtable never
 * sends one), a link is a list of record ids, and an attachment's url is the
 * API's own, which expires two hours after it was fetched.
 */
export function normalizeRecord(record: JsonObject): JsonObject {
  return {
    record_id: record.id ?? null,
    created_time: record.createdTime ?? null,
    fields: asRow(record.fields),
  }
}

/** One comment on a record, with its author flattened. */
export function normalizeComment(comment: JsonObject): JsonObject {
  const who = asRow(comment.author)
  return {
    comment_id: comment.id ?? null,
    author_id: who.id ?? null,
    author_email: who.email ?? null,
    author_name: who.name ?? null,
    text: comment.text ?? null,
    created_time: comment.createdTime ?? null,
    last_updated_time: comment.lastUpdatedTime ?? null,
  }
}

/** One deleted record, as the delete answer names it. */
export function normalizeDeletion(row: JsonObject): JsonObject {
  return { record_id: row.id ?? null, deleted: row.deleted ?? null }
}

/** Render records one per line, in the order they were listed. */
export function recordsJsonl(listed: readonly JsonObject[]): Uint8Array {
  return jsonlBytes(listed.map(normalizeRecord))
}

/** Render deleted records one per line, in the order they were deleted. */
export function deletionsJsonl(rows: readonly JsonObject[]): Uint8Array {
  return jsonlBytes(rows.map(normalizeDeletion))
}

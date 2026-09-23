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

import type { C } from './config.ts'
import { plainTextOf } from './text.ts'
import { normalizeRichText } from './text.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import type { DatabaseRow, Json, MetaRow } from './types.ts'
import { asObject } from './wire.ts'

export function titleProp(title: string, column = 'title'): Json {
  return {
    [column]: {
      id: 'title',
      type: 'title',
      title: [{ type: 'text', plain_text: title, text: { content: title } }],
    },
  }
}

export function schemaOf(database: DatabaseRow | null): Json {
  if (database === null) return {}
  return asObject(JSON.parse(database.propertiesJson))
}

// Normalizing a write can add a select option to its column, and the option id
// the answer carries is only usable if that lands, so the schema goes back to
// the row whenever normalization changed it.
export async function persistSchema(
  db: C,
  tenant: string,
  owner: DatabaseRow | null,
  schema: Json,
  before: string,
): Promise<void> {
  const next = JSON.stringify(schema)
  if (owner === null || next === before) return
  await db.notionDatabase.update({
    where: { tenant_id: { tenant, id: owner.id } },
    data: { propertiesJson: next },
  })
}

export function titleColumnOf(schema: Json): string {
  for (const [name, spec] of Object.entries(schema)) {
    if (asObject(spec).type === 'title') return name
  }
  return 'title'
}

// Notion spells a parent as {type, [type]: value}; workspace is the one that

export function titleOfProperties(properties: Json): string {
  for (const value of Object.values(properties)) {
    if (Array.isArray(value)) return plainTextOf(value)
    const prop = value as Json
    if (prop.type === 'title' || Array.isArray(prop.title)) return plainTextOf(prop.title)
  }
  return ''
}

// A write body may omit plain_text and send only text.content, but every
// reader takes plain_text (mirage's markdown renderer reads nothing else), so
// what a create returns has to be filled in the way real Notion fills it in.

function propertyKind(prop: Json, columnType: string | undefined): string | undefined {
  if (typeof prop.type === 'string') return prop.type
  const keys = Object.keys(prop).filter((key) => key !== 'id' && key !== 'type')
  return keys.length === 1 ? keys[0] : columnType
}

// A writer names a select option; Notion answers with the whole option off the
// schema. A name the schema has never seen is minted rather than dropped,
// which is what the real API does with a new select/multi_select value, and it
// is added to the column's options right here, because the id in the answer is
// only usable if a later write naming it alone resolves back to the same
// option. Its id is the name, so the fake stays reproducible across runs.
// Deliberate divergence: a status option is minted the same way, where the
// real API refuses one it does not already have.
function selectOption(column: Json, kind: string, value: Json): Json {
  const name = typeof value.name === 'string' ? value.name : ''
  const id = typeof value.id === 'string' ? value.id : ''
  const config = asObject(column[kind])
  const options = config.options
  if (Array.isArray(options)) {
    for (const one of options) {
      const option = asObject(one)
      if ((id !== '' && option.id === id) || (name !== '' && option.name === name)) {
        return { id: option.id ?? null, name: option.name ?? null, color: option.color ?? null }
      }
    }
  }
  const minted: Json = { id: id !== '' ? id : name, name, color: 'default' }
  if (Array.isArray(options)) options.push({ ...minted })
  return minted
}

function normalizeValue(column: Json, kind: string, value: JsonValue): JsonValue {
  if (kind === 'title' || kind === 'rich_text') return normalizeRichText(value)
  if (kind === 'select' || kind === 'status') {
    return value === null || value === undefined
      ? null
      : selectOption(column, kind, asObject(value))
  }
  if (kind === 'multi_select') {
    if (!Array.isArray(value)) return []
    return value.map((one) => selectOption(column, kind, asObject(one)))
  }
  // Notion answers a date with all three fields whatever the writer sent.
  if (kind === 'date') {
    if (value === null || value === undefined) return null
    const date = asObject(value)
    return { start: date.start ?? null, end: date.end ?? null, time_zone: date.time_zone ?? null }
  }
  return value ?? null
}

// Notion answers with the property value its schema decides, never the one the
// writer sent: the column's id and type ride on every value, and a select
// carries the whole option rather than the bare name a client may write. The
// fake used to echo the request back, so a PATCH that left `type` out (the API
// treats it as optional and the official SDK's own examples omit it) stored an
// untyped object, which every reader renders blank because the type is what
// says which key holds the value. Key order matches the fixture's, so a
// written row and a seeded one look alike.
export function normalizeProperties(properties: Json, schema: Json): Json {
  const out: Json = {}
  for (const [key, value] of Object.entries(properties)) {
    const column = asObject(schema[key])
    const columnType = typeof column.type === 'string' ? column.type : undefined
    // A bare array under the column name is a shorthand the fake accepts; it
    // is only ever the title column or a rich text one.
    const prop = Array.isArray(value)
      ? { [columnType === 'rich_text' ? 'rich_text' : 'title']: value }
      : asObject(value)
    const kind = propertyKind(prop, columnType)
    if (kind === undefined) {
      out[key] = prop
      continue
    }
    const copy: Json = {}
    if (typeof column.id === 'string') copy.id = column.id
    else if (kind === 'title') copy.id = 'title'
    copy.type = kind
    copy[kind] = normalizeValue(column, kind, prop[kind] ?? null)
    out[key] = copy
  }
  return out
}

// The value an unset column answers with. A computed column (formula, rollup,
// unique_id, ...) and status have none here: their value is Notion's to derive,
// and the fake leaves them out rather than invent one.
function emptyValue(type: string, meta: MetaRow): JsonValue | undefined {
  if (['title', 'rich_text', 'multi_select', 'people', 'files'].includes(type)) return []
  if (['number', 'select', 'date', 'url', 'email', 'phone_number'].includes(type)) return null
  if (type === 'checkbox') return false
  if (type === 'created_time') return meta.createdTime
  if (type === 'last_edited_time') return meta.lastEditedTime
  if (type === 'created_by') return { object: 'user', id: meta.createdBy }
  if (type === 'last_edited_by') return { object: 'user', id: meta.lastEditedBy }
  return undefined
}

// A database row carries every column of its schema, an unset one empty, in
// the schema's order: that is what live Notion answers a create with (API
// reference), and it is what every row in the MCP-Atlas recordings carries. A
// written property the schema does not name is kept, after the columns.
export function fillSchema(properties: Json, schema: Json, meta: MetaRow): Json {
  const out: Json = {}
  for (const [name, spec] of Object.entries(schema)) {
    const written = properties[name]
    if (written !== undefined) {
      out[name] = written
      continue
    }
    const column = asObject(spec)
    const type = typeof column.type === 'string' ? column.type : ''
    const value = emptyValue(type, meta)
    if (value === undefined) continue
    out[name] = { id: column.id ?? null, type, [type]: value }
  }
  for (const [name, value] of Object.entries(properties)) {
    if (!(name in out)) out[name] = value
  }
  return out
}

export function normalizeBlockPayload(payload: Json): Json {
  const out: Json = { ...payload }
  if (Array.isArray(payload.rich_text)) out.rich_text = normalizeRichText(payload.rich_text)
  if (Array.isArray(payload.caption)) out.caption = normalizeRichText(payload.caption)
  return out
}

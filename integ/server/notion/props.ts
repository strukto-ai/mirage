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

import { validation } from './blocks.ts'
import type { C } from './config.ts'
import { plainTextOf } from './text.ts'
import { normalizeRichText } from './text.ts'
import type { JsonValue, Minter, Reply } from '../kit/typescript/index.ts'
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

// A page outside a database has one property, its title, under `title`: "If
// the new page is a child of another page, title is the only valid property"
// (API reference, create a page).
export function schemaOf(database: DatabaseRow | null): Json {
  if (database === null) return { title: { id: 'title', name: 'title', type: 'title', title: {} } }
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
// written row and a seeded one look alike. A key names a column by its name or
// its id, either spelling of the id as `propByRef` takes it, and the value
// lands under the column's name. A key that names no column is refused with
// live's words, and the caller writes nothing: "property names or IDs must
// match the parent data source's schema" (API reference, create a page). Two
// keys naming one column (its name and its id) are refused in the fake's
// words, rather than one value silently winning.
export function normalizeProperties(properties: Json, schema: Json): Array<[string, Json]> | Reply {
  const out: Array<[string, Json]> = []
  const named = new Map<string, string>()
  for (const [ref, value] of Object.entries(properties)) {
    const key = columnNameOf(schema, ref)
    if (key === undefined) return validation(`${ref} is not a property that exists.`)
    const first = named.get(key)
    if (first !== undefined) return validation(`${first} and ${ref} both name the property ${key}.`)
    named.set(key, ref)
    const column = asObject(schema[key])
    const columnType = typeof column.type === 'string' ? column.type : undefined
    // A bare array under the column name is a shorthand the fake accepts; it
    // is only ever the title column or a rich text one.
    const prop = Array.isArray(value)
      ? { [columnType === 'rich_text' ? 'rich_text' : 'title']: value }
      : asObject(value)
    const kind = propertyKind(prop, columnType)
    if (kind === undefined) {
      out.push([key, prop])
      continue
    }
    const copy: Json = {}
    if (typeof column.id === 'string') copy.id = column.id
    else if (kind === 'title') copy.id = 'title'
    copy.type = kind
    copy[kind] = normalizeValue(column, kind, prop[kind] ?? null)
    out.push([key, copy])
  }
  return out
}

function columnNameOf(schema: Json, ref: string): string | undefined {
  if (Object.hasOwn(schema, ref)) return ref
  const encoded = encodeURIComponent(ref)
  for (const [name, spec] of Object.entries(schema)) {
    const id = asObject(spec).id
    if (id === ref || id === encoded) return name
  }
  return undefined
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
// property the schema does not name, which only a seeded row can hold, is kept
// after the columns.
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

// A column spec names its type the way a property value does, by the one key
// that is not bookkeeping: `{"number": {"format": "percent"}}` says number.
function columnKind(spec: Json): string | undefined {
  if (typeof spec.type === 'string') return spec.type
  return Object.keys(spec).find((key) => !['id', 'name', 'type', 'description'].includes(key))
}

// A column as the schema stores it, in the fixture's key order: id, name, type,
// then the type's settings. A number with no format is a plain number, and an
// option named without an id or a color gets the name and `default`, the way
// `selectOption` mints one on a row write.
function columnOf(id: string, name: string, kind: string, settings: JsonValue | undefined): Json {
  const config: Json = { ...asObject(settings) }
  if (kind === 'number' && config.format === undefined) config.format = 'number'
  if (Array.isArray(config.options)) {
    config.options = config.options.map((one) => {
      const option = asObject(one)
      return {
        id: option.id ?? option.name ?? null,
        name: option.name ?? null,
        color: option.color ?? 'default',
      }
    })
  }
  return { id, name, type: kind, [kind]: config }
}

// A schema write, keyed by a column's name or id: null removes the column, a
// `name` renames it and keeps its id (which is what lets every row follow), a
// type's settings replace the column's, and a key the schema does not hold
// adds one. The title column can be renamed but not removed, retyped or joined
// by a second (API reference, update property schema object). Creating a
// database is this write on an empty schema. A key resolves by name before
// id, the order `propByRef` resolves every other reference in, so one key
// names one column whatever order the schema holds them in. An added column's
// id is minted short and percent-encoded, the way live Notion's read (`%3A7`),
// from the tenant's minter and never from the column's name: an id spelled like
// a name let a later name shadow it, and a non-title column named `title` took
// the title column's id. The minter never repeats a number, so an id a removed
// column held never comes back to name another. The title column's id is
// always `title`, as on live Notion. The wording of each refusal is the fake's,
// except the unknown column, which is live's for a filter.
export function patchSchema(
  schema: Json,
  patch: Json,
  minter: Minter,
): Array<[string, Json]> | Reply {
  const columns = Object.entries(schema).map(([name, spec]): [string, Json] => [
    name,
    asObject(spec),
  ])
  for (const [ref, value] of Object.entries(patch)) {
    const named = columns.findIndex(([name]) => name === ref)
    const at =
      named !== -1
        ? named
        : columns.findIndex(([, spec]) => spec.id === ref || spec.id === encodeURIComponent(ref))
    const current = columns[at]?.[1]
    if (value === null) {
      if (current === undefined)
        return validation(`Could not find property with name or id: ${ref}`)
      if (current.type === 'title') return validation('The title property cannot be removed.')
      columns.splice(at, 1)
      continue
    }
    const spec = asObject(value)
    const kind = columnKind(spec)
    const name =
      typeof spec.name === 'string' && spec.name !== '' ? spec.name : (columns[at]?.[0] ?? ref)
    let next: Json
    if (kind === undefined) {
      if (current === undefined)
        return validation(`Could not find property with name or id: ${ref}`)
      next = { ...current, name }
    } else {
      if (current?.type === 'title' && kind !== 'title') {
        return validation('The title property cannot change type.')
      }
      if (
        kind === 'title' &&
        current?.type !== 'title' &&
        columns.some(([, other]) => other.type === 'title')
      ) {
        return validation('A database has exactly one title property.')
      }
      let id = typeof current?.id === 'string' ? current.id : 'title'
      if (current === undefined && kind !== 'title') id = `%3A${String(minter.next('property'))}`
      next = columnOf(id, name, kind, spec[kind])
    }
    if (columns.some(([other], i) => other === name && i !== at)) {
      return validation(`A property named ${name} already exists.`)
    }
    if (at === -1) columns.push([name, next])
    else columns[at] = [name, next]
  }
  return columns
}

// Each row keeps its values under the names their columns now have, found by
// the column id every value carries. A removed column's value goes, and one
// whose column changed type starts empty, where live converts what it can. A
// value no schema ever named stays, as `fillSchema` keeps it.
export function migrateRow(properties: Json, before: Json, schema: Json, meta: MetaRow): Json {
  const names = new Map(Object.entries(schema).map(([name, spec]) => [asObject(spec).id, name]))
  const moved: Json = {}
  for (const [name, value] of Object.entries(properties)) {
    const prop = asObject(value)
    const target = names.get(prop.id)
    if (target === undefined) {
      if (!(name in before)) moved[name] = value
      continue
    }
    if (asObject(schema[target]).type === prop.type) moved[target] = value
  }
  return fillSchema(moved, schema, meta)
}

// What a page keeps when it moves: its title, under the new parent's title
// column (`title` under a page), and each value whose name and type the new
// schema shares, under that column's id. A column the page brings nothing for
// starts empty, as on a created row. Live's rule is not documented.
export function movedProperties(properties: Json, schema: Json | null, meta: MetaRow): Json {
  const title =
    Object.values(properties)
      .map(asObject)
      .find((prop) => prop.type === 'title')?.title ?? []
  if (schema === null) return { title: { id: 'title', type: 'title', title } }
  const kept: Json = {}
  for (const [name, spec] of Object.entries(schema)) {
    const column = asObject(spec)
    const value = asObject(properties[name])
    if (column.type === 'title') kept[name] = { id: column.id ?? 'title', type: 'title', title }
    else if (value.type === column.type) kept[name] = { ...value, id: column.id ?? null }
  }
  return fillSchema(kept, schema, meta)
}

export function normalizeBlockPayload(payload: Json): Json {
  const out: Json = { ...payload }
  if (Array.isArray(payload.rich_text)) out.rich_text = normalizeRichText(payload.rich_text)
  if (Array.isArray(payload.caption)) out.caption = normalizeRichText(payload.caption)
  return out
}

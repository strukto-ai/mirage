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

import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { EntryKind, Fields } from '@struktoai/mirage-core/resources/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { Field, TypeTable } from './types.ts'

const MAX_BYTES = 16 * 1024

/** An AWS region as its endpoints name it: `us-east-1`, `ap-southeast-2`. */
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/

/** The source the console declares for a team's own entries. */
export const STRUKTO = 'strukto'

/** An entry's values split as they are kept: `config` plain, `sealed` write-only. */
export interface Checked {
  config: Fields
  sealed: Fields
}

function invalid(message: string): ResourceError {
  return new ResourceError('invalid', message)
}

/** A pointer to a store's secret: `ref` addresses the secret, `key` its field. */
export interface StorePointer {
  from: string
  ref?: string
  key: string
}

/**
 * Whether a value is a `{from, ref, key}` pointer, by Mirage's rule: a mapping
 * of exactly those keys, so an ordinary field that holds a `from` is left alone.
 */
export function isPointer(v: unknown): v is StorePointer {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    Object.keys(o).every((k) => k === 'from' || k === 'ref' || k === 'key') &&
    typeof o.from === 'string' &&
    o.from !== '' &&
    typeof o.key === 'string' &&
    o.key !== '' &&
    (o.ref === undefined || o.ref === null || typeof o.ref === 'string')
  )
}

/** The stores an entry's fields point at, each once, in order. */
export function storesOf(config: Fields): string[] {
  const found: string[] = []
  for (const value of Object.values(config)) {
    if (isPointer(value) && !found.includes(value.from)) found.push(value.from)
  }
  return found
}

function fieldsOf(kind: EntryKind, type: string, types: TypeTable): Field[] {
  const fields = types[type]
  if (fields === undefined)
    throw invalid(`type must be a ${kind}: ${Object.keys(types).join(', ')}`)
  return fields
}

/** A value as an option names it: JavaScript's `String` of a scalar. */
function textOf(value: JsonValue): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * One field's value checked against its type. A string field of a VFS, CLI
 * or runtime may instead point at a store; a store's own keys come from no
 * other store.
 */
export function valueOf(kind: EntryKind, field: Field, raw: unknown, at: string): JsonValue {
  const bad = (what: string) => invalid(`${at} must be ${what}`)
  if (isPointer(raw) && kind !== 'store' && field.type === 'string') {
    if (raw.from === STRUKTO) throw bad('a value or a secret store')
    if (field.options !== undefined) throw bad(`one of ${field.options.join(', ')}`)
    const ref = raw.ref?.trim() ?? ''
    if (ref === '') throw bad('a pointer with a ref')
    const key = raw.key.trim()
    if (key === '') throw bad('a pointer with a key')
    return { from: raw.from, ref, key }
  }
  let value: JsonValue
  if (field.type === 'list') {
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && v !== '')) {
      throw bad('a list of strings')
    }
    value = raw as string[]
  } else if (typeof raw !== field.type) {
    throw bad(`a ${field.type}`)
  } else {
    value = raw as JsonValue
  }
  if (field.options !== undefined && !field.options.includes(textOf(value))) {
    throw bad(`one of ${field.options.join(', ')}`)
  }
  return value
}

/** The checks a type needs beyond its fields' types. */
function checkRules(kind: EntryKind, type: string, config: Fields): void {
  const region = config.region
  if (
    kind === 'store' &&
    type === 'aws-sm' &&
    typeof region === 'string' &&
    !AWS_REGION.test(region)
  ) {
    throw invalid('region must be an AWS region, such as us-east-1')
  }
  const url = config.url
  if (kind === 'cli' && type === 'mcp' && typeof url === 'string') {
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {
      parsed = undefined
    }
    if (parsed?.protocol !== 'https:') throw invalid("url must be the MCP server's https URL")
  }
}

/**
 * A body's fields checked against the type's, split into the plain and the
 * sealed. Empty values are left out; `kept` names the sealed fields an edit
 * keeps, which count as given. Mirrors the console's `checkValues`.
 */
export function checkValues(
  kind: EntryKind,
  type: string,
  input: unknown,
  types: TypeTable,
  kept: ReadonlySet<string> = new Set(),
): Checked {
  const fields = fieldsOf(kind, type, types)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('fields must be an object')
  }
  const config: Fields = {}
  const sealed: Fields = {}
  for (const [name, raw] of Object.entries(input)) {
    if (raw === null || raw === undefined || raw === '') continue
    const field = fields.find((f) => f.name === name)
    if (field === undefined) {
      throw invalid(
        `${type} has no field ${name}; it takes ${fields.map((f) => f.name).join(', ')}`,
      )
    }
    const value = valueOf(kind, field, raw, name)
    if (field.secret && !isPointer(value)) sealed[name] = value
    else config[name] = value
  }
  const given = new Set([...Object.keys(config), ...Object.keys(sealed), ...kept])
  for (const f of fields) {
    const used =
      f.group === undefined || fields.some((g) => g.group === f.group && given.has(g.name))
    if (f.required && used && !given.has(f.name)) throw invalid(`${f.name} is required`)
  }
  checkRules(kind, type, config)
  if (new TextEncoder().encode(JSON.stringify({ config, sealed })).length > MAX_BYTES) {
    throw invalid('fields are larger than 16 KB')
  }
  return { config, sealed }
}

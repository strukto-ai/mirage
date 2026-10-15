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
import { isEnoent } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { listRecords } from './client.ts'
import { AirtableApiError } from './errors.ts'
import { recordsJsonl } from './normalize.ts'
import { schemaTable } from './readdir.ts'
import { detectScope } from './scope.ts'

// A line's keys besides its field names, and the JSON literals.
export const LINE_KEYS: ReadonlySet<string> = new Set([
  'record_id',
  'created_time',
  'fields',
  'true',
  'false',
  'null',
])

// Cell types a line spells as the text a formula reads of them: a string, or
// strings in a list a formula joins with ", ".
export const TEXT_TYPES: ReadonlySet<string> = new Set([
  'singleLineText',
  'multilineText',
  'richText',
  'email',
  'url',
  'phoneNumber',
  'singleSelect',
  'multipleSelects',
])

// Cell types a line spells with digits, `- . : + e T Z` or `true` only, where
// no text of three letters lies outside a key.
export const WORDLESS_TYPES: ReadonlySet<string> = new Set([
  'number',
  'percent',
  'currency',
  'duration',
  'rating',
  'autoNumber',
  'count',
  'checkbox',
  'date',
  'dateTime',
  'createdTime',
  'lastModifiedTime',
])

// Cell types whose JSON holds no space outside the text a formula reads of
// them: a link's record ids, an AI text's state and error type around its
// value, an attachment's ids, urls and type around its file name. A text with
// a space is found in the formula's text or nowhere.
export const SPACELESS_TYPES: ReadonlySet<string> = new Set(['multipleRecordLinks'])
export const SPACED_TEXT_TYPES: ReadonlySet<string> = new Set(['aiText', 'multipleAttachments'])

/**
 * The lines of a table's records.jsonl or a view's file that may hold `text`,
 * in the order a plain read lists them.
 *
 * Airtable lists only the records a formula is true for, so the formula asks
 * whether the record id (`RECORD_ID()`) or a cell, as the text a formula reads
 * and lowercased, holds `text`; grep matches each line itself. Only a table
 * whose every field spells its cell as that text (a text, a select, an email,
 * a url, a phone number) or with no word in it (a number, a date, a checkbox)
 * is asked; a link, an AI text or an attachment holds no space outside the
 * text a formula reads of it, so a table with one is asked for a text with a
 * space. A collaborator, a lookup or a formula renders ids or errors a formula
 * does not read. `text` goes through `recordQueries` for the line's keys,
 * field names among them, and its escapes. null for any other file, a path
 * the listing does not hold, a table with another field type or a field name
 * a formula cannot quote, a text a key holds, a failed listing, or more than
 * `maxReadRecords` matches. Mirrors Python's `lines_containing`.
 */
export async function linesContaining(
  accessor: AirtableAccessor,
  path: PathSpec,
  text: string,
  entry: FileStat | null = null,
): Promise<Uint8Array | null> {
  const match = detectScope(path)
  if ((match.kind !== 'records' && match.kind !== 'view') || entry === null) return null
  let table: Record<string, unknown>
  try {
    table = await schemaTable(accessor, match)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
  const fields = (Array.isArray(table.fields) ? table.fields : []).filter(
    (field): field is Record<string, unknown> => typeof field === 'object' && field !== null,
  )
  const names = fields.map((field) => (typeof field.name === 'string' ? field.name : ''))
  const keys = new Set([...LINE_KEYS, ...names.map((name) => name.toLowerCase())])
  const queries = recordQueries(text, keys, false)
  if (queries === null) return null
  const asked = queries.map((query) => query.toLowerCase())
  if (asked.some((query) => [...keys].some((key) => key.includes(query)))) return null
  const spaced = asked.every((query) => query.includes(' '))
  const cells = ['LOWER(RECORD_ID())']
  for (const [i, field] of fields.entries()) {
    const name = names[i] ?? ''
    const kind = typeof field.type === 'string' ? field.type : ''
    if (name.includes('{') || name.includes('}')) return null
    if (TEXT_TYPES.has(kind) || (spaced && SPACED_TEXT_TYPES.has(kind))) {
      cells.push(`LOWER({${name}} & "")`)
    } else if (!(WORDLESS_TYPES.has(kind) || (spaced && SPACELESS_TYPES.has(kind)))) {
      return null
    }
  }
  const formula = `OR(${asked.flatMap((query) => cells.map((cell) => `SEARCH("${query}", ${cell})`)).join(', ')})`
  const cap = accessor.maxReadRecords
  let records
  try {
    records = await listRecords(accessor, match.slots.base_id ?? '', match.slots.table_id ?? '', {
      ...(match.slots.view_id !== undefined ? { view: match.slots.view_id } : {}),
      formula,
      maxRecords: cap + 1,
    })
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails
    if (!(err instanceof AirtableApiError || err instanceof TypeError)) throw err
    console.debug(`airtable search failed (${String(err)}); reading the file`)
    return null
  }
  if (records.length > cap) return null
  return recordsJsonl(records)
}

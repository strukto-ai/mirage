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

import type { Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { DATA_SOURCE_VERSION, DEFAULT_API_VERSION } from './config.ts'
import { plainTextOf } from './text.ts'
import type { DatabaseRow, Json, PageRow } from './types.ts'
import { apiError, asObject, dataSourceJson, databaseJson, pageJson } from './wire.ts'

// With no object filter a search answers pages AND databases (a 2025-09-03
// caller gets data sources, which replaced databases in search). The MCP-Atlas
// recordings of live Notion show both: `{}` opened with six databases, and a
// query naming a database's title found the database. Results come most
// recently edited first unless `sort` says otherwise, which is the documented
// default; equal times keep databases ahead of pages, each in stored order.
export async function searchResults(
  db: C,
  tenant: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const filter = asObject(args.filter)
  const kind = filter.value
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const matches = (title: string): boolean => query === '' || title.toLowerCase().includes(query)
  const found: { edited: string; item: Json }[] = []
  // 2022-06-28 spells this "database"; 2026-03-11 replaced it with
  // "data_source" and rejects the old word. The fake answers both so the
  // battery's client and the official CLI can share one server.
  const onlyDatabases = kind === 'database' || kind === 'data_source'
  if (kind === undefined || onlyDatabases) {
    const rows = (await db.notionDatabase.findMany({
      where: { tenant, inTrash: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })) as DatabaseRow[]
    const asDataSource =
      kind === 'data_source' || (kind === undefined && version >= DATA_SOURCE_VERSION)
    for (const row of rows.filter((r) => matches(r.titleText))) {
      const item = asDataSource ? dataSourceJson(row) : databaseJson(row, version)
      found.push({ edited: row.lastEditedTime, item })
    }
  }
  if (!onlyDatabases) {
    const rows = (await db.notionPage.findMany({
      where: { tenant, inTrash: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })) as PageRow[]
    for (const row of rows.filter((r) => matches(r.titleText))) {
      found.push({ edited: row.lastEditedTime, item: pageJson(row, version) })
    }
  }
  const sign = asObject(args.sort).direction === 'ascending' ? 1 : -1
  found.sort((a, b) => (a.edited === b.edited ? 0 : a.edited < b.edited ? -sign : sign))
  return found.map((one) => one.item)
}

// A filter, a sort and `filter_properties` all name a property by its name or
// its id. Notion stores an id percent-encoded (`%3BEch`) and a client may send
// it either way; the MCP-Atlas recordings send it decoded (`f:fc` for
// `f%3Afc`), so both spellings resolve.
function propByRef(page: Json, ref: string): Json | undefined {
  const props = asObject(page.properties)
  const named = props[ref]
  if (named !== undefined) return asObject(named)
  const encoded = encodeURIComponent(ref)
  for (const value of Object.values(props)) {
    const prop = asObject(value)
    if (prop.id === ref || prop.id === encoded) return prop
  }
  return undefined
}

function textOfProp(prop: Json): string {
  if (Array.isArray(prop.title)) return plainTextOf(prop.title)
  if (Array.isArray(prop.rich_text)) return plainTextOf(prop.rich_text)
  return ''
}

function numberOfProp(prop: Json): number | null {
  return typeof prop.number === 'number' ? prop.number : null
}

function dateOfProp(prop: Json): string | null {
  const start = asObject(prop.date).start
  return typeof start === 'string' ? start : null
}

function matchesText(value: string, cond: Json): boolean {
  if (typeof cond.equals === 'string') return value === cond.equals
  if (typeof cond.does_not_equal === 'string') return value !== cond.does_not_equal
  if (typeof cond.contains === 'string') return value.includes(cond.contains)
  if (typeof cond.does_not_contain === 'string') return !value.includes(cond.does_not_contain)
  if (typeof cond.starts_with === 'string') return value.startsWith(cond.starts_with)
  if (typeof cond.ends_with === 'string') return value.endsWith(cond.ends_with)
  if (cond.is_empty === true) return value === ''
  if (cond.is_not_empty === true) return value !== ''
  return true
}

function matchesNumber(value: number | null, cond: Json): boolean {
  if (cond.is_empty === true) return value === null
  if (cond.is_not_empty === true) return value !== null
  if (value === null) return false
  if (typeof cond.equals === 'number') return value === cond.equals
  if (typeof cond.does_not_equal === 'number') return value !== cond.does_not_equal
  if (typeof cond.greater_than === 'number') return value > cond.greater_than
  if (typeof cond.less_than === 'number') return value < cond.less_than
  const gte = cond.greater_than_or_equal_to
  if (typeof gte === 'number') return value >= gte
  const lte = cond.less_than_or_equal_to
  if (typeof lte === 'number') return value <= lte
  return true
}

// A condition naming two bounds is answered by ONE of them, the first in this
// list: live Notion kept `on_or_before` and dropped `on_or_after` from
// `{on_or_after: 2017-01-01, on_or_before: 2017-12-31}` (MCP-Atlas task
// 68824c643e6ff020bc339906 got 2015 rows back). The other pairs are unprobed.
const DATE_TESTS: [string, (cmp: number) => boolean][] = [
  ['equals', (cmp) => cmp === 0],
  ['before', (cmp) => cmp < 0],
  ['after', (cmp) => cmp > 0],
  ['on_or_before', (cmp) => cmp <= 0],
  ['on_or_after', (cmp) => cmp >= 0],
]

// The conditions that are relative to today. The fake has no today a fixture
// could agree with (its dates are pinned, the clock is not), so these are
// refused rather than guessed at or ignored.
const RELATIVE_DATE = [
  'past_week',
  'past_month',
  'past_year',
  'next_week',
  'next_month',
  'next_year',
  'this_week',
]

// A date compares by its start. A bound with no time compares by calendar day,
// the day as written, so `equals 2017-04-01` holds a row dated that day at any
// hour; a bound with a time compares instants. Every MCP-Atlas date is a bare
// day, and those recordings pin equals, on_or_before and on_or_after.
function matchesDate(start: string | null, cond: Json): boolean {
  if (cond.is_empty === true) return start === null
  if (cond.is_not_empty === true) return start !== null
  for (const [op, test] of DATE_TESTS) {
    const bound = cond[op]
    if (typeof bound !== 'string') continue
    if (start === null) return false
    if (bound.length === 10) {
      const day = start.slice(0, 10)
      return test(day === bound ? 0 : day < bound ? -1 : 1)
    }
    return test(Math.sign(Date.parse(start) - Date.parse(bound)))
  }
  return true
}

// Notion's filter is a recursive and/or tree over typed property conditions.
// Implemented here for the types the fixtures use (title/rich_text, number,
// checkbox, select, date); an unrecognized condition matches rather than
// silently dropping the row, so a filter this does not understand degrades to
// "no filter" instead of "no results".
function matchesFilter(page: Json, filter: Json): boolean {
  if (Array.isArray(filter.and)) return filter.and.every((f) => matchesFilter(page, asObject(f)))
  if (Array.isArray(filter.or)) return filter.or.some((f) => matchesFilter(page, asObject(f)))
  const name = typeof filter.property === 'string' ? filter.property : ''
  if (name === '') return true
  const prop = propByRef(page, name)
  if (prop === undefined) return false
  if (filter.title !== undefined || filter.rich_text !== undefined) {
    return matchesText(textOfProp(prop), asObject(filter.title ?? filter.rich_text))
  }
  if (filter.number !== undefined) {
    return matchesNumber(numberOfProp(prop), asObject(filter.number))
  }
  if (filter.checkbox !== undefined) {
    const cond = asObject(filter.checkbox)
    const value = prop.checkbox === true
    if (typeof cond.equals === 'boolean') return value === cond.equals
    if (typeof cond.does_not_equal === 'boolean') return value !== cond.does_not_equal
    return true
  }
  if (filter.select !== undefined) {
    const name2 = asObject(prop.select).name
    return matchesText(typeof name2 === 'string' ? name2 : '', asObject(filter.select))
  }
  if (filter.date !== undefined) {
    return matchesDate(dateOfProp(prop), asObject(filter.date))
  }
  return true
}

// The refusal a query answers before it reads a row, or null when the filter
// is one the fake evaluates.
export function filterRefusal(filter: unknown): Reply | null {
  const node = asObject(filter)
  for (const branch of [node.and, node.or]) {
    if (!Array.isArray(branch)) continue
    for (const child of branch) {
      const refused = filterRefusal(child)
      if (refused !== null) return refused
    }
  }
  const cond = asObject(node.date)
  const relative = RELATIVE_DATE.find((key) => cond[key] !== undefined)
  if (relative === undefined) return null
  return apiError(
    400,
    'validation_error',
    `body.filter.date.${relative} is relative to today, which the integ fake does not model.`,
  )
}

// An empty value sorts last in either direction, the way Notion places an
// undated row. A type with no key here sorts as empty, which leaves stored
// order alone.
function sortKey(page: Json, sort: Json): string | number | null {
  if (typeof sort.timestamp === 'string') {
    const key = sort.timestamp === 'created_time' ? 'created_time' : 'last_edited_time'
    return typeof page[key] === 'string' ? String(page[key]) : null
  }
  const prop = propByRef(page, typeof sort.property === 'string' ? sort.property : '')
  if (prop === undefined) return null
  if (prop.type === 'number') return numberOfProp(prop)
  if (prop.type === 'date') return dateOfProp(prop)
  const text = textOfProp(prop)
  return text === '' ? null : text
}

// Plain < / > rather than localeCompare: collation must not differ between a
// CI runner and a laptop, since the row order lands in a golden.
function applySorts(rows: Json[], sorts: unknown): Json[] {
  if (!Array.isArray(sorts) || sorts.length === 0) return rows
  const out = [...rows]
  out.sort((a, b) => {
    for (const raw of sorts) {
      const sort = asObject(raw)
      const ka = sortKey(a, sort)
      const kb = sortKey(b, sort)
      if (ka === kb) continue
      if (ka === null) return 1
      if (kb === null) return -1
      const cmp = ka < kb ? -1 : 1
      return sort.direction === 'descending' ? -cmp : cmp
    }
    return 0
  })
  return out
}

// `filter_properties` narrows what each result carries, never which results
// match or their order, so it applies last. The kept properties come in the
// order they were asked for, not the page's: the MCP-Atlas recordings of live
// Notion show it on every call where the two differ.
export function keepProperties(page: Json, refs: string[]): Json {
  if (refs.length === 0) return page
  const props = asObject(page.properties)
  const kept: Json = {}
  for (const ref of refs) {
    const prop = propByRef(page, ref)
    const name = Object.keys(props).find((key) => props[key] === prop)
    if (name !== undefined && prop !== undefined) kept[name] = prop
  }
  return { ...page, properties: kept }
}

export async function databaseRows(
  db: C,
  tenant: string,
  databaseId: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const rows = (await db.notionPage.findMany({
    where: { tenant, parentType: 'database_id', parentId: databaseId, inTrash: false },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as PageRow[]
  let out = rows.map((row) => pageJson(row, version))
  if (args.filter !== undefined) {
    out = out.filter((row) => matchesFilter(row, asObject(args.filter)))
  }
  return applySorts(out, args.sorts)
}

// A child page is one object in two tables: the NotionPage row is the record,
// the NotionBlock row of type child_page is how the parent's children listing

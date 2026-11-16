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

import { first, select } from '../kit/typescript/index.ts'
import type { NotionDatabase, NotionPage } from '../../generated/notion/index.js'
import { DMMF, type Db } from './store.ts'
import type { Reply } from '../kit/typescript/index.ts'
import { DATA_SOURCE_VERSION, DEFAULT_API_VERSION } from './config.ts'
import { plainTextOf } from './text.ts'
import type { Json, PageRow } from './types.ts'
import {
  apiError,
  asObject,
  dataSourceJson,
  databaseJson,
  pageJson,
  cursorOf,
  intOr,
  dataSourceIdOf,
} from './wire.ts'

type Key = { id: string; lastEditedTime: string; position: number }

// A piece of a WHERE and the parameters its marks take.
type Clause = [string, (string | number)[]]

// A title query is folded in JS, so rows arrive one batch at a time and the
// scan stops as soon as a page's worth matched. Each batch resumes after the
// last row it read by key, not by offset: no earlier row is read twice, and a
// row trashed mid-scan cannot shift a later match out. With no query the first
// batch is the page.
async function firstMatches<R extends Key & { titleText: string }>(
  fetch: (after: Key | null) => R[],
  take: number,
  matches: (row: R) => boolean,
): Promise<R[]> {
  const kept: R[] = []
  let after: Key | null = null
  while (kept.length < take) {
    const batch = fetch(after)
    kept.push(...batch.filter(matches))
    after = batch.at(-1) ?? null
    if (batch.length < take) break
  }
  return kept.slice(0, take)
}

// With no object filter a search answers pages AND databases (a 2025-09-03
// caller gets data sources, which replaced databases in search). The MCP-Atlas
// recordings of live Notion show both: `{}` opened with six databases, and a
// query naming a database's title found the database. Results come most
// recently edited first unless `sort` says otherwise, which is the documented
// default; equal times keep databases ahead of pages, each in stored order.
export async function searchResults(
  db: Db,
  tenant: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const kind = asObject(args.filter).value
  // SQLite LIKE folds ASCII only, so a title query is folded here: `équipe`
  // still finds `Équipe`, as it does on live Notion.
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const matches = (row: { titleText: string }): boolean =>
    query === '' || row.titleText.toLowerCase().includes(query)
  const ascending = asObject(args.sort).direction === 'ascending'
  const order =
    `ORDER BY "lastEditedTime" ${ascending ? 'ASC' : 'DESC'}, "position" ASC, "id" ASC ` + 'LIMIT ?'
  const take = Math.min(Math.max(intOr(args.page_size, 100), 1), 100) + 1
  const onlyDatabases = kind === 'database' || kind === 'data_source'
  const includeDatabases = kind === undefined || onlyDatabases
  const asDataSource =
    kind === 'data_source' || (kind === undefined && version >= DATA_SOURCE_VERSION)
  const cursor = cursorOf(args.start_cursor)
  let anchor: { row: Key; database: boolean } | null = null
  if (cursor !== null) {
    if (!onlyDatabases) {
      const row = first<NotionPage>(
        db,
        DMMF,
        'NotionPage',
        '"tenant" = ? AND "inTrash" = ? AND "id" = ?',
        tenant,
        false,
        cursor,
      )
      if (row !== null) anchor = { row, database: false }
    }
    if (anchor === null && includeDatabases) {
      // `endsWith` as Prisma ran it: LIKE with the suffix unescaped.
      const rows = asDataSource
        ? select<NotionDatabase>(
            db,
            DMMF,
            'NotionDatabase',
            '"tenant" = ? AND "inTrash" = ? AND "id" LIKE ?',
            tenant,
            false,
            `%${cursor.slice(8)}`,
          )
        : select<NotionDatabase>(
            db,
            DMMF,
            'NotionDatabase',
            '"tenant" = ? AND "inTrash" = ? AND "id" = ?',
            tenant,
            false,
            cursor,
          )
      const row = rows.find((r) => (asDataSource ? dataSourceIdOf(r.id) : r.id) === cursor)
      if (row !== undefined) anchor = { row, database: true }
    }
    if (anchor === null) return []
  }
  const laterTime = (row: Key): Clause => [
    ascending ? '"lastEditedTime" > ?' : '"lastEditedTime" < ?',
    [row.lastEditedTime],
  ]
  // Rows from `row` on in sort order; the cursor row itself opens its page, a
  // batch resumes strictly after the row it ended on.
  const from = (row: Key, inclusive: boolean): Clause => {
    const [later, params] = laterTime(row)
    return [
      `(${later} OR ("lastEditedTime" = ? AND ("position" > ? OR ` +
        `("position" = ? AND "id" ${inclusive ? '>=' : '>'} ?))))`,
      [...params, row.lastEditedTime, row.position, row.position, row.id],
    ]
  }
  const bounds = (database: boolean): Clause => {
    if (anchor === null) return ['1 = 1', []]
    const row = anchor.row
    if (database !== anchor.database) {
      if (database) return laterTime(row)
      const [later, params] = laterTime(row)
      return [`(${later} OR "lastEditedTime" = ?)`, [...params, row.lastEditedTime]]
    }
    return from(row, true)
  }
  const batch = <T>(model: string, database: boolean, after: Key | null): T[] => {
    const [bound, boundParams] = bounds(database)
    const [rest, restParams] = after === null ? ['1 = 1', []] : from(after, false)
    return select<T>(
      db,
      DMMF,
      model,
      `"tenant" = ? AND "inTrash" = ? AND ${bound} AND ${rest} ${order}`,
      tenant,
      false,
      ...boundParams,
      ...restParams,
      take,
    )
  }
  const found: { row: Key; item: Json; database: boolean }[] = []
  if (includeDatabases) {
    const rows = await firstMatches(
      (after) => batch<NotionDatabase>('NotionDatabase', true, after),
      take,
      matches,
    )
    for (const row of rows)
      found.push({
        row,
        database: true,
        item: asDataSource ? dataSourceJson(row) : databaseJson(row, version),
      })
  }
  if (!onlyDatabases) {
    const rows = await firstMatches(
      (after) => batch<NotionPage>('NotionPage', false, after),
      take,
      matches,
    )
    for (const row of rows) found.push({ row, database: false, item: pageJson(row, version) })
  }
  const sign = ascending ? 1 : -1
  found.sort((a, b) => {
    if (a.row.lastEditedTime !== b.row.lastEditedTime)
      return a.row.lastEditedTime < b.row.lastEditedTime ? -sign : sign
    if (a.database !== b.database) return a.database ? -1 : 1
    return (
      a.row.position - b.row.position || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
    )
  })
  return found.slice(0, take).map((one) => one.item)
}

// A filter, a sort, `filter_properties` and a property item read all name a
// property by its name or its id. Notion stores an id percent-encoded (`%3BEch`) and a client may send
// it either way; the MCP-Atlas recordings send it decoded (`f:fc` for
// `f%3Afc`), so both spellings resolve.
export function propByRef(page: Json, ref: string): Json | undefined {
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
  db: Db,
  tenant: string,
  databaseId: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const rows = select<NotionPage>(
    db,
    DMMF,
    'NotionPage',
    '"tenant" = ? AND "parentType" = ? AND "parentId" = ? AND "inTrash" = ? ORDER BY "position" ASC, "id" ASC',
    tenant,
    'database_id',
    databaseId,
    false,
  ) as PageRow[]
  let out = rows.map((row) => pageJson(row, version))
  if (args.filter !== undefined) {
    out = out.filter((row) => matchesFilter(row, asObject(args.filter)))
  }
  return applySorts(out, args.sorts)
}

// A child page is one object in two tables: the NotionPage row is the record,
// the NotionBlock row of type child_page is how the parent's children listing

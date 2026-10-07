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

import { PathSpec } from '../../types.ts'
import { grepSearchOptions } from '../../commands/builtin/grep_pushdown.ts'
import type { PostgresAccessor } from '../../accessor/postgres.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { queryMatcher, type Searcher } from '../hierarchy/search.ts'
import { type SearchQuery, type SearchResult } from '../../vfs/types.ts'
import {
  fetchBoundedQuery,
  fetchColumns,
  listMatviews,
  listSchemas,
  listTables,
  listViews,
  qualified,
  quoteIdent,
} from './client.ts'
import { buildEntitySchemaJson } from './_schema_json.ts'
import { readRows, rowLine } from './read.ts'
import { buildEntitySemanticJson } from './semantic.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { jsonText } from '../render/json.ts'
import { efbig } from '../../errors/fs.ts'

// Column types whose `::text` is the value exactly as a rows.jsonl line spells
// it, so a LIKE over the cast finds every row whose line holds the pattern
// inside that value. Everything else renders differently in the line (a
// timestamp's separator, a float's digits, a `char(n)`'s padding, json's
// spacing), and a table holding one is not searchable. Mirrors
// `_SAME_TEXT_TYPES` in `mirage/core/postgres/search.py`.
const SAME_TEXT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'character varying',
  'name',
  'uuid',
  'smallint',
  'integer',
  'bigint',
  'boolean',
])
// The ones that can hold a control character, which the line spells as an
// escape (`\n`, `\u0001`), so a pattern can match the escape's letters in a
// row whose value never holds them: such rows are candidates too.
const STRING_TYPES: ReadonlySet<string> = new Set(['text', 'character varying', 'name'])
// What a line spells around and between values: a pattern holding one can
// match where no single value holds it (`:4` after a key).
const STRUCTURAL: ReadonlySet<string> = new Set(['"', '\\', ':', ',', '{', '}'])
// How a NULL spells in the line; no LIKE over a NULL ever matches it.
const NULL = 'null'

export interface EntityMatches {
  schema: string
  kind: string
  entity: string
  lines: string[]
}

// Escape LIKE/ILIKE wildcards so the pattern matches as a literal: Postgres
// LIKE treats % and _ as wildcards and \ as the default escape char, but
// grep's substring pattern has no such meaning (`user_id` must not match
// `userXid`).
function escapeLike(pattern: string): string {
  return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// Whether a LIKE over the columns finds every row a scan would. The push-down
// prints what grep over rows.jsonl would print, and a LIKE per column sees
// only values: a pattern that can match a key (every row holds every key), the
// text between values, a NULL's `null` or a value the line spells differently
// from its cast would be found by the scan and missed by the query. Mirrors
// `_answerable` in `mirage/core/postgres/search.py`.
function answerable(columns: readonly [string, string][], query: SearchQuery): boolean {
  const pattern = query.query
  for (const ch of pattern) {
    if (STRUCTURAL.has(ch) || (ch.codePointAt(0) ?? 0) < 0x20) return false
  }
  const folded = grepSearchOptions(query).ignoreCase ? pattern.toLowerCase() : pattern
  if (NULL.includes(folded)) return false
  for (const [name, dataType] of columns) {
    if (!SAME_TEXT_TYPES.has(dataType)) return false
    const key = grepSearchOptions(query).ignoreCase ? name.toLowerCase() : name
    if (key.includes(folded)) return false
  }
  return true
}

/**
 * The rows.jsonl lines of one entity that grep would print. When the columns
 * and the pattern let a LIKE see every match (`answerable`), the query picks
 * candidates (a value holding the pattern, or one holding a control character
 * the line escapes) and the matcher grep compiles decides each candidate's
 * line. Otherwise the file is read and scanned the way `cat | grep` would,
 * through the same read and its size guard, so a table too large to read is
 * refused rather than answered short. There is no result cap: the push-down
 * used to stop at `defaultSearchLimit` rows and print those as grep's whole
 * answer; past `maxReadRows` candidates it now refuses with EFBIG, as a whole
 * read of that many rows is refused. Mirrors `search_entity` in
 * `mirage/core/postgres/search.py`.
 */
export async function searchEntity(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  entity: string,
  query: SearchQuery,
): Promise<string[]> {
  const cap = accessor.config.maxReadRows
  const rowsPath = `${schema}/${kind}/${entity}/rows.jsonl`
  const matcher = queryMatcher(query)
  const columns = (await fetchColumns(accessor, schema, entity)).map((c): [string, string] => [
    c.name,
    c.type,
  ])
  if (columns.length === 0) return []
  if (answerable(columns, query)) {
    const op = grepSearchOptions(query).ignoreCase ? 'ILIKE' : 'LIKE'
    const clauses = columns.map(([name]) => `${quoteIdent(name)}::text ${op} $1`)
    for (const [name, dataType] of columns) {
      if (STRING_TYPES.has(dataType)) clauses.push(`${quoteIdent(name)} ~ '[[:cntrl:]]'`)
    }
    const sql =
      `SELECT * FROM ${qualified(schema, entity)} ` + `WHERE ${clauses.join(' OR ')} LIMIT $2`
    const maxBytes = accessor.config.maxReadBytes
    const rows = await fetchBoundedQuery(
      accessor,
      sql,
      [`%${escapeLike(query.query)}%`, cap + 1],
      new Set(columns.map(([name]) => name)),
      maxBytes,
    )
    if (rows === null || rows.length > cap) throw efbig(rowsPath)
    const lines: string[] = []
    const encoder = new TextEncoder()
    let renderedBytes = 0
    for (const row of rows) {
      const line = rowLine(row)
      renderedBytes += encoder.encode(line).length + 1
      if (renderedBytes > maxBytes) throw efbig(rowsPath)
      if (matcher(line)) lines.push(line)
    }
    return lines
  }
  const text = new TextDecoder().decode(await readRows(accessor, schema, entity, rowsPath))
  return splitLines(text).filter((line) => matcher(line))
}

// python's `str.splitlines()` over a rows.jsonl rendering, whose only
// terminators are the `\n` after each row (a value's own newline is escaped).
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

async function entityNames(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
): Promise<string[]> {
  if (kind === 'tables') return listTables(accessor, schema)
  const views = await listViews(accessor, schema)
  const mviews = await listMatviews(accessor, schema)
  return [...new Set([...views, ...mviews])].sort(compareCodePoints)
}

// Grep an entity's rendered metadata files. The LIKE push-down only ever
// sees row values, so schema.json and semantic.json would be invisible at
// directory scope: `grep -r` would report "not found" for content that is
// plainly there. These documents are rendered, not stored, so the only honest
// way to match them is to render and scan, with the matcher grep compiles.
export async function searchEntityMetadata(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  entity: string,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const entityKind = kind === 'tables' ? 'table' : 'view'
  const matcher = queryMatcher(query)
  const docs: [string, unknown][] = [
    ['schema.json', await buildEntitySchemaJson(accessor, schema, entity, entityKind)],
    ['semantic.json', await buildEntitySemanticJson(accessor, schema, entity, entityKind)],
  ]
  const lines: SearchResult[] = []
  for (const [name, doc] of docs) {
    for (const line of jsonText(doc).split('\n')) {
      if (matcher(line))
        lines.push([
          PathSpec.fromStrPath(`/${schema}/${kind}/${entity}/${name}`),
          `${schema}/${kind}/${entity}/${name}:${line}`,
        ])
    }
  }
  return lines
}

export async function searchKindMetadata(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const lines: SearchResult[] = []
  for (const n of await entityNames(accessor, schema, kind)) {
    lines.push(...(await searchEntityMetadata(accessor, schema, kind, n, query)))
  }
  return lines
}

export async function searchSchemaMetadata(
  accessor: PostgresAccessor,
  schema: string,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const lines: SearchResult[] = []
  for (const kind of ['tables', 'views'] as const) {
    lines.push(...(await searchKindMetadata(accessor, schema, kind, query)))
  }
  return lines
}

export async function searchDatabaseMetadata(
  accessor: PostgresAccessor,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const lines: SearchResult[] = []
  for (const s of await listSchemas(accessor, accessor.config.schemas)) {
    lines.push(...(await searchSchemaMetadata(accessor, s, query)))
  }
  return lines
}

export async function searchKind(
  accessor: PostgresAccessor,
  schema: string,
  kind: string,
  query: SearchQuery,
): Promise<EntityMatches[]> {
  const out: EntityMatches[] = []
  for (const n of await entityNames(accessor, schema, kind)) {
    const lines = await searchEntity(accessor, schema, kind, n, query)
    if (lines.length > 0) out.push({ schema, kind, entity: n, lines })
  }
  return out
}

export async function searchSchema(
  accessor: PostgresAccessor,
  schema: string,
  query: SearchQuery,
): Promise<EntityMatches[]> {
  const out: EntityMatches[] = []
  for (const kind of ['tables', 'views'] as const) {
    out.push(...(await searchKind(accessor, schema, kind, query)))
  }
  return out
}

export async function searchDatabase(
  accessor: PostgresAccessor,
  query: SearchQuery,
): Promise<EntityMatches[]> {
  const out: EntityMatches[] = []
  for (const s of await listSchemas(accessor, accessor.config.schemas)) {
    out.push(...(await searchSchema(accessor, s, query)))
  }
  return out
}

export function formatGrepResults(results: readonly EntityMatches[]): SearchResult[] {
  const lines: SearchResult[] = []
  for (const { schema, kind, entity, lines: found } of results) {
    for (const line of found)
      lines.push([
        PathSpec.fromStrPath(`/${schema}/${kind}/${entity}/rows.jsonl`),
        `${schema}/${kind}/${entity}/rows.jsonl:${line}`,
      ])
  }
  return lines
}

// Directory scopes cover every file under them, so the rendered
// schema.json / semantic.json are searched alongside the row push-down.
// Deliberate divergence from GNU: rows come first and metadata second,
// rather than in per-entity readdir order.
const rootSearcher: Searcher<PostgresAccessor> = async (accessor, _match, query) => [
  ...formatGrepResults(await searchDatabase(accessor, query)),
  ...(await searchDatabaseMetadata(accessor, query)),
]

const schemaSearcher: Searcher<PostgresAccessor> = async (accessor, match, query) => {
  const schema = match.slots.schema ?? ''
  return [
    ...formatGrepResults(await searchSchema(accessor, schema, query)),
    ...(await searchSchemaMetadata(accessor, schema, query)),
  ]
}

const kindSearcher: Searcher<PostgresAccessor> = async (accessor, match, query) => {
  const schema = match.slots.schema ?? ''
  const kind = match.slots.kind ?? ''
  return [
    ...formatGrepResults(await searchKind(accessor, schema, kind, query)),
    ...(await searchKindMetadata(accessor, schema, kind, query)),
  ]
}

async function entityLines(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  query: SearchQuery,
  metadata: boolean,
): Promise<SearchResult[]> {
  const schema = match.slots.schema ?? ''
  const kind = match.slots.kind ?? ''
  const entity = match.slots.entity ?? ''
  const lines = await searchEntity(accessor, schema, kind, entity, query)
  const found = formatGrepResults([{ schema, kind, entity, lines }])
  // entity_rows names rows.jsonl explicitly; only the directory scope
  // pulls in the sibling metadata files.
  if (metadata) found.push(...(await searchEntityMetadata(accessor, schema, kind, entity, query)))
  return found
}

export const SEARCHERS: Readonly<Record<string, Searcher<PostgresAccessor>>> = {
  root: rootSearcher,
  schema: schemaSearcher,
  kind: kindSearcher,
  entity: (accessor, match, query) => entityLines(accessor, match, query, true),
  entity_rows: (accessor, match, query) => entityLines(accessor, match, query, false),
}

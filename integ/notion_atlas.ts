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

// Replays live Notion against the notion fake. MCP-Atlas recorded every Notion
// call its agents made through @notionhq/notion-mcp-server 1.8.1 against a live
// workspace (Notion-Version 2022-06-28); scripts/gen_notion_atlas.py keeps each
// call, its reply and the workspace those replies show in
// truth/notion_atlas.json. This seeds the fake with that workspace, sends each
// call the way the MCP server does, and compares the whole reply. A reply the
// fake cannot reproduce is a divergence from live Notion, never a golden to
// regenerate.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { start } from './server/kit/typescript/index.ts'
import type { JsonValue } from './server/kit/typescript/index.ts'
import { notionFake } from './server/notion/fake.ts'

type Json = Record<string, JsonValue>

interface Table {
  database: Json
  created_time: string
  last_edited_time: string
  author: string
  columns: string[]
  rows: JsonValue[][]
}

interface Call {
  task: string
  tool: string
  args: Json
  reply: Json
  // The row this reply's cursor names was never recorded, or not with every
  // column the call reads, so no fixture can place it: the results are
  // compared, and `has_more` / `next_cursor` cannot be.
  next?: 'unrecorded'
  // Why the recordings cannot hold what replaying this call needs, set by the
  // generator from the recordings alone. Reported, never silently dropped.
  skip?: string
}

interface Corpus {
  users: Json[]
  tables: Table[]
  calls: Call[]
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CORPUS = join(HERE, 'truth', 'notion_atlas.json')
const FIXTURE = 'atlas'
// The fake's default tenant, which `start` seeds with the fixture it is handed.
const TOKEN = 'integ-test'
const VERSION = '2022-06-28'
const URL_BASE = 'https://www.notion.so/'
const ANNOTATIONS: Json = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

function asJson(value: JsonValue | undefined): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function richText(content: string): JsonValue[] {
  return [
    {
      type: 'text',
      text: { content, link: null },
      annotations: { ...ANNOTATIONS },
      plain_text: content,
      href: null,
    },
  ]
}

// The live property a stored bare value stands for; the generator refuses a
// recording this would not rebuild exactly.
function buildProp(column: Json, value: JsonValue): Json {
  const kind = String(column.type)
  let rendered: JsonValue = value
  if (kind === 'title' || kind === 'rich_text') rendered = richText(String(value))
  if (kind === 'select') {
    const options = asJson(column.select).options as Json[]
    const option = options.find((one) => one.name === value) ?? {}
    rendered = { id: option.id ?? null, name: option.name ?? null, color: option.color ?? null }
  }
  if (kind === 'date') rendered = { start: value, end: null, time_zone: null }
  return { id: column.id ?? null, type: kind, [kind]: rendered }
}

function pageUrl(title: string, id: string): string {
  const slug = title.replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-+|-+$/g, '')
  return `${URL_BASE}${slug === '' ? '' : `${slug}-`}${id.replaceAll('-', '')}`
}

interface Row {
  table: Table
  id: string
  url: string
  title: string
  cells: Map<string, JsonValue>
}

function rowOf(table: Table, raw: JsonValue[]): Row {
  const [id, url, ...values] = raw
  const columns = asJson(table.database.properties)
  const cells = new Map<string, JsonValue>()
  table.columns.forEach((name, i) => {
    const value = values[i]
    if (value !== null && value !== undefined) cells.set(name, value)
  })
  const titleColumn = table.columns.find((name) => asJson(columns[name]).type === 'title') ?? ''
  const title = cells.has(titleColumn) ? String(cells.get(titleColumn)) : ''
  return {
    table,
    id: String(id),
    url: typeof url === 'string' ? url : pageUrl(title, String(id)),
    title,
    cells,
  }
}

// `filter_properties` keeps the named columns in the order it names them.
function picked(columns: Json, refs: string[]): string[] {
  const out: string[] = []
  for (const ref of refs) {
    const encoded = encodeURIComponent(ref)
    const hit = Object.entries(columns).find(([name, column]) => {
      const id = asJson(column).id
      return ref === name || ref === id || encoded === id
    })
    if (hit !== undefined && !out.includes(hit[0])) out.push(hit[0])
  }
  return out
}

function propertiesOf(row: Row, refs: string[]): Json {
  const columns = asJson(row.table.database.properties)
  const names = refs.length > 0 ? picked(columns, refs) : row.table.columns
  const out: Json = {}
  for (const name of names) {
    const value = row.cells.get(name)
    if (value !== undefined) out[name] = buildProp(asJson(columns[name]), value)
  }
  return out
}

function pageOf(row: Row, refs: string[]): Json {
  const author = { object: 'user', id: row.table.author }
  return {
    object: 'page',
    id: row.id,
    created_time: row.table.created_time,
    last_edited_time: row.table.last_edited_time,
    created_by: author,
    last_edited_by: author,
    cover: null,
    icon: null,
    parent: { type: 'database_id', database_id: String(row.table.database.id) },
    archived: false,
    in_trash: false,
    properties: propertiesOf(row, refs),
    url: row.url,
    public_url: null,
  }
}

function ownBot(corpus: Corpus): Json {
  const bot = corpus.users.find((user) => asJson(user.bot).owner !== undefined)
  if (bot === undefined) throw new Error('notion atlas: the recorded users name no integration')
  return bot
}

// The workspace as the fake's own fixture: the recorded database objects, the
// rows in stored order (which the generator made agree with every recorded
// reply), the members, and the integration's bot as the meta identity.
function fixtureOf(corpus: Corpus, rows: Row[]): Json {
  const bot = ownBot(corpus)
  const detail = asJson(bot.bot)
  const first = corpus.tables[0]!
  return {
    meta: {
      workspaceName: String(detail.workspace_name),
      // Not in the recording; the fake always renders one (see withoutNewer).
      workspaceId: 'a7a50000-0000-4000-8000-000000000000',
      botId: String(bot.id),
      botName: String(bot.name),
      maxUploadSize: Number(asJson(detail.workspace_limits).max_file_upload_size_in_bytes),
      urlBase: URL_BASE,
      createdTime: first.created_time,
      lastEditedTime: first.last_edited_time,
      createdBy: first.author,
      lastEditedBy: first.author,
    },
    databases: corpus.tables.map((table, position) => {
      const db = table.database
      return {
        id: String(db.id),
        parentType: 'workspace',
        parentId: null,
        titleText: (db.title as Json[]).map((part) => String(part.plain_text)).join(''),
        titleJson: db.title ?? [],
        descriptionJson: db.description ?? [],
        propertiesJson: db.properties ?? {},
        isInline: db.is_inline === true,
        inTrash: false,
        createdTime: String(db.created_time),
        lastEditedTime: String(db.last_edited_time),
        createdBy: String(asJson(db.created_by).id),
        lastEditedBy: String(asJson(db.last_edited_by).id),
        url: String(db.url),
        position,
      }
    }),
    pages: rows.map((row, position) => ({
      id: row.id,
      parentType: 'database_id',
      parentId: String(row.table.database.id),
      titleText: row.title,
      propertiesJson: propertiesOf(row, []),
      iconJson: null,
      coverJson: null,
      inTrash: false,
      createdTime: row.table.created_time,
      lastEditedTime: row.table.last_edited_time,
      createdBy: row.table.author,
      lastEditedBy: row.table.author,
      url: row.url,
      position,
    })),
    users: corpus.users
      .filter((user) => user.id !== bot.id)
      .map((user) => ({
        id: String(user.id),
        name: String(user.name),
        avatarUrl: user.avatar_url ?? null,
        type: String(user.type),
        detailJson: user[String(user.type)] ?? {},
      })),
  }
}

// How @notionhq/notion-mcp-server 1.8.1 turns a tool call into a request: a
// path parameter fills the path, a query parameter (`filter_properties`, the
// users list's cursor) rides the query string, repeated for an array, and the
// rest is the JSON body.
function requestOf(call: Call): { method: string; path: string; body?: Json } {
  const args = { ...call.args }
  if (call.tool === 'API-post-search') return { method: 'POST', path: '/v1/search', body: args }
  if (call.tool === 'API-get-users') {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(args)) query.append(key, String(value))
    const tail = query.size === 0 ? '' : `?${query.toString()}`
    return { method: 'GET', path: `/v1/users${tail}` }
  }
  if (call.tool === 'API-post-database-query') {
    const id = String(args.database_id)
    const refs = (args.filter_properties ?? []) as string[]
    delete args.database_id
    delete args.filter_properties
    const query = new URLSearchParams()
    for (const ref of refs) query.append('filter_properties', ref)
    const tail = refs.length === 0 ? '' : `?${query.toString()}`
    return { method: 'POST', path: `/v1/databases/${id}/query${tail}`, body: args }
  }
  throw new Error(`notion atlas: no request for ${call.tool}`)
}

// Keys live Notion has added since the recordings were made, which the fake
// renders because live does today (probed 2026-09-22): a page's `is_archived`
// and `is_locked`, and the integration's `workspace_id` in the users list. A
// recording cannot carry them, so they are dropped from the fake's side only.
function withoutNewer(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutNewer)
  if (typeof value !== 'object' || value === null) return value
  const out: Json = {}
  for (const [key, inner] of Object.entries(value)) {
    if (value.object === 'page' && (key === 'is_archived' || key === 'is_locked')) continue
    if (value.object === 'user' && key === 'bot') {
      const bot = { ...asJson(inner) }
      delete bot.workspace_id
      out[key] = bot
      continue
    }
    out[key] = withoutNewer(inner)
  }
  return out
}

// Both sides are compared with their keys sorted, because the order of an
// object's own keys is not part of it and live Notion reordered a page's since
// the recordings. A `properties` map is the exception: its order is the
// schema's, or the order `filter_properties` asked in, and a reader that prints
// the map shows it.
function canonical(value: JsonValue, ordered = false): JsonValue {
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  if (typeof value !== 'object' || value === null) return value
  const keys = ordered ? Object.keys(value) : Object.keys(value).sort()
  return Object.fromEntries(keys.map((key) => [key, canonical(value[key]!, key === 'properties')]))
}

function firstDiff(want: JsonValue, got: JsonValue, at: string): string | null {
  if (JSON.stringify(want) === JSON.stringify(got)) return null
  if (Array.isArray(want) && Array.isArray(got)) {
    if (want.length !== got.length)
      return `${at}: ${String(got.length)} items, want ${String(want.length)}`
    for (let i = 0; i < want.length; i += 1) {
      const inner = firstDiff(want[i]!, got[i]!, `${at}[${String(i)}]`)
      if (inner !== null) return inner
    }
  }
  if (
    typeof want === 'object' &&
    want !== null &&
    !Array.isArray(want) &&
    typeof got === 'object' &&
    got !== null &&
    !Array.isArray(got)
  ) {
    for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const inner = firstDiff(want[key] ?? null, got[key] ?? null, `${at}.${key}`)
      if (inner !== null) return inner
    }
  }
  const clip = (v: JsonValue): string => JSON.stringify(v).slice(0, 160)
  return `${at}: got ${clip(got)}, want ${clip(want)}`
}

async function main(): Promise<void> {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as Corpus
  const rows = corpus.tables.flatMap((table) => table.rows.map((raw) => rowOf(table, raw)))
  const byId = new Map<string, JsonValue>()
  for (const table of corpus.tables) byId.set(String(table.database.id), table.database)
  for (const user of corpus.users) byId.set(String(user.id), user)
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const root = mkdtempSync(join(tmpdir(), 'notion-atlas-'))
  mkdirSync(join(root, 'notion'))
  writeFileSync(join(root, 'notion', `${FIXTURE}.json`), JSON.stringify(fixtureOf(corpus, rows)))
  const fake = await start(notionFake, 0, FIXTURE, root)
  let failed = 0
  let skipped = 0
  try {
    for (const [i, call] of corpus.calls.entries()) {
      const label = `${String(i).padStart(2, '0')} ${call.task} ${call.tool}`
      if (call.skip !== undefined) {
        skipped += 1
        process.stdout.write(`  skip ${label}  [${call.skip}]\n`)
        continue
      }
      const req = requestOf(call)
      const response = await fetch(`${fake.endpoint}${req.path}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Notion-Version': VERSION,
          'Content-Type': 'application/json',
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      })
      const got = (await response.json()) as Json
      const refs = (call.args.filter_properties ?? []) as string[]
      const { results, ...envelope } = call.reply
      const want: Json = {
        ...envelope,
        results: (results as string[]).map((id) => {
          const row = rowById.get(id)
          return row === undefined ? (byId.get(id) ?? null) : pageOf(row, refs)
        }),
      }
      const seen = withoutNewer(got) as Json
      if (call.next === 'unrecorded') {
        for (const side of [want, seen]) {
          delete side.has_more
          delete side.next_cursor
        }
      }
      const diff = firstDiff(canonical(want), canonical(seen), 'reply')
      if (diff === null) {
        process.stdout.write(`  ok   ${label}\n`)
      } else {
        failed += 1
        process.stdout.write(`  FAIL ${label}  [${diff}]\n`)
      }
    }
  } finally {
    await fake.close()
    rmSync(root, { recursive: true, force: true })
  }
  const total = corpus.calls.length - skipped
  process.stdout.write(
    `notion atlas: ${String(total - failed)}/${String(total)} live replies reproduced, ${String(skipped)} skipped\n`,
  )
  if (failed > 0) process.exit(1)
}

await main()

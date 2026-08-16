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

// One shared fake Notion REST API, backed by Prisma + SQLite and seeded from
// integ/fixtures/notion/v1.json. This is the only notion fake: the Python and
// TypeScript battery hosts both point at NOTION_URL/v1 over HTTP, so responses
// are byte-identical across hosts by construction rather than by keeping two
// implementations in step.
//
// Three things follow from being a database rather than module-level dicts:
//
//   - Mutations land. create/update/append write rows, so a read after a write
//     sees the write. That is what an evaluator grading an agent's output
//     needs, and it is why POST /v1/pages mints a real id instead of echoing a
//     fixed one.
//   - Pagination is real. has_more/next_cursor come from the row count, so the
//     cursor loops in mirage's own client (paginate_list / paginate_post /
//     paginateTool) actually execute instead of always exiting after one pass.
//   - Scenarios are isolated. The bearer token *is* the workspace id, matching
//     how a real Notion integration token scopes you to one workspace, so
//     parallel scenarios can share one server. POST /reset re-seeds one
//     workspace and leaves the others alone.
//
// Errors use Notion's envelope ({object, status, code, message}) with a JSON
// content type. An empty-bodied 404 made mirage's client die inside
// resp.json() with a mimetype error, so every NotionAPIError branch it has was
// unreachable.
//
// Not implemented yet, tracked as later phases: the remaining Notion
// operations (users, block get/update, database create and update, page
// properties), and filter/sorts on database query.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { PrismaClient } from '@prisma/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const FIXTURE = join(HERE, '..', 'fixtures', 'notion', 'v1.json')
// 5092-5099 are already handed out in .github/actions/integ-battery-setup.
const DEFAULT_PORT = 5091
// mirage's notion mounts and the ntn CLI are both configured with this key in
// integ/runners/*/adapters, so it names the workspace the battery seeds.
const DEFAULT_TOKEN = 'integ-test'
const MAX_PAGE_SIZE = 100
// The version mirage's own client and the ntn CLI both send, so an unversioned
// request answers the way every in-repo caller expects.
const DEFAULT_API_VERSION = '2025-09-03'
// The generation that moved the column schema off the database and onto the
// data source. Versions are ISO dates, so they order as strings.
const DATA_SOURCE_VERSION = '2025-09-03'

const MOUNT = '/notion'
const PAGE_A = 'aaaa1111-2222-3333-4444-555566667777'
const PAGE_B = 'bbbb2222-3333-4444-5555-666677778888'
const PAGE_C = 'cccc1111-2222-3333-4444-555566667777'
const DB_TASKS = 'eeee1111-2222-3333-4444-555566667777'
const ROW_1 = 'ffff1111-2222-3333-4444-555566667777'
const DIR_A = `${MOUNT}/pages/Project_Roadmap__${PAGE_A}`
const DIR_B = `${MOUNT}/pages/Notes__${PAGE_B}`
const DIR_C = `${DIR_A}/Q1_Goals__${PAGE_C}`
const DB_DIR = `${MOUNT}/databases/Tasks__${DB_TASKS}`
// Since 2025-09-03 the rows live under the data source, not the database, so a
// row sits one level deeper than it used to. These paths feed the MCP/REST
// parity battery, where a stale one costs nothing visible: both arms answer
// the same error and the case passes while asserting nothing.
const DS_DIR = `${DB_DIR}/Tasks__${dataSourceIdOf(DB_TASKS)}`
const ROW_1_DIR = `${DS_DIR}/Write_spec__${ROW_1}`

type Json = Record<string, unknown>

interface FixtureParent {
  type: string
  id?: string
}
interface FixtureDefaults {
  created_time: string
  last_edited_time: string
  created_by: string
  last_edited_by: string
  url_base: string
}
interface FixturePage {
  id: string
  title: string
  parent: FixtureParent
  properties?: Json
  created_time?: string
  last_edited_time?: string
  created_by?: string
  last_edited_by?: string
  url?: string
  archived?: boolean
  in_trash?: boolean
  icon?: Json
  cover?: Json
}
interface FixtureDatabase {
  id: string
  title: string
  parent: FixtureParent
  properties: Json
  description?: unknown[]
  is_inline?: boolean
  created_time?: string
  last_edited_time?: string
  created_by?: string
  last_edited_by?: string
  url?: string
  archived?: boolean
  in_trash?: boolean
}
interface FixtureBlock {
  id: string
  parent: string
  type: string
  payload: Json
  has_children?: boolean
  created_time?: string
  last_edited_time?: string
  created_by?: string
  last_edited_by?: string
}
interface FixtureComment {
  id: string
  parent: FixtureParent
  discussion_id?: string
  rich_text: unknown[]
  created_time?: string
  last_edited_time?: string
  created_by?: string
}
interface Fixture {
  defaults: FixtureDefaults
  databases: FixtureDatabase[]
  pages: FixturePage[]
  blocks: FixtureBlock[]
  comments: FixtureComment[]
}

interface PageRow {
  id: string
  parentType: string
  parentId: string | null
  titleText: string
  propertiesJson: string
  iconJson: string | null
  coverJson: string | null
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
  url: string
}
interface DatabaseRow {
  id: string
  parentType: string
  parentId: string | null
  titleText: string
  titleJson: string
  descriptionJson: string | null
  propertiesJson: string
  isInline: boolean
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
  url: string
}
interface BlockRow {
  id: string
  parentId: string
  position: number
  type: string
  payloadJson: string
  hasChildren: boolean
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
}
interface CommentRow {
  id: string
  parentType: string
  parentId: string
  discussionId: string
  richTextJson: string
  createdTime: string
  lastEditedTime: string
  createdBy: string
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

// db push materializes schema.prisma into a fresh SQLite file per server
// instance, so every start is clean state (no migration history to carry).
function pushSchema(dbUrl: string): void {
  const prismaBin = createRequire(import.meta.url).resolve('prisma/build/index.js')
  execFileSync('node', [prismaBin, 'db', 'push', '--schema', SCHEMA, '--skip-generate'], {
    env: { ...process.env, INTEG_DB_URL: dbUrl },
    stdio: 'ignore',
  })
}

// Created ids are a per-workspace counter rather than a random uuid so the
// battery can pin them in a golden. The leading group says what was minted.
const idSeq = new Map<string, number>()

function nextSeq(workspaceId: string): number {
  const next = (idSeq.get(workspaceId) ?? 0) + 1
  idSeq.set(workspaceId, next)
  return next
}

function idAt(prefix: string, seq: number): string {
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

function mintId(workspaceId: string, prefix: string): string {
  return idAt(prefix, nextSeq(workspaceId))
}

function defaultUrl(fx: Fixture, id: string): string {
  return `${fx.defaults.url_base}${id.replaceAll('-', '')}`
}

// A page's title lives under whatever its schema calls the title column, so a
// row created in a data source gets `Name` (or whatever that data source
// named it) while a plain page gets the bare `title` every page object has.
function titleProp(title: string, column = 'title'): Json {
  return {
    [column]: {
      id: 'title',
      type: 'title',
      title: [{ type: 'text', plain_text: title, text: { content: title } }],
    },
  }
}

function schemaOf(database: DatabaseRow | null): Json {
  if (database === null) return {}
  return asObject(JSON.parse(database.propertiesJson))
}

// Normalizing a write can add a select option to its column, and the option id
// the answer carries is only usable if that lands, so the schema goes back to
// the row whenever normalization changed it.
async function persistSchema(
  db: PrismaClient,
  workspaceId: string,
  owner: DatabaseRow | null,
  schema: Json,
  before: string,
): Promise<void> {
  const next = JSON.stringify(schema)
  if (owner === null || next === before) return
  await db.notionDatabase.update({
    where: { workspaceId_id: { workspaceId, id: owner.id } },
    data: { propertiesJson: next },
  })
}

function titleColumnOf(schema: Json): string {
  for (const [name, spec] of Object.entries(schema)) {
    if (asObject(spec).type === 'title') return name
  }
  return 'title'
}

// Notion spells a parent as {type, [type]: value}; workspace is the one that
// carries a boolean rather than an id.
function parentJson(parentType: string, parentId: string | null): Json {
  if (parentType === 'workspace') return { type: 'workspace', workspace: true }
  return { type: parentType, [parentType]: parentId ?? '' }
}

function plainTextOf(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  let out = ''
  for (const part of rich) {
    const item = part as Json
    if (typeof item.plain_text === 'string') {
      out += item.plain_text
      continue
    }
    const text = item.text as Json | undefined
    if (text !== undefined && typeof text.content === 'string') out += text.content
  }
  return out
}

// The title of a page is whichever property has type "title"; a database row
// names that column itself (Name, Task, ...) so it cannot be looked up by key.
// A create body may also send the bare rich-text array under the column name.
function titleOfProperties(properties: Json): string {
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
// Key order matches the fixture's so created and seeded content look alike.
function normalizeRichText(value: unknown): Json[] {
  if (!Array.isArray(value)) return []
  const out: Json[] = []
  for (const part of value) {
    const item = asObject(part)
    const text = asObject(item.text)
    const content =
      typeof text.content === 'string'
        ? text.content
        : typeof item.plain_text === 'string'
          ? item.plain_text
          : ''
    const entry: Json = {
      type: typeof item.type === 'string' ? item.type : 'text',
      plain_text: typeof item.plain_text === 'string' ? item.plain_text : content,
    }
    if (item.annotations !== undefined) entry.annotations = item.annotations
    entry.text = { content }
    if (item.href !== undefined) entry.href = item.href
    out.push(entry)
  }
  return out
}

// The value key is the discriminator: {"select": {...}} says select on its
// own, which is how a body that omits `type` still names its own shape. The
// column is the fallback for a body that carries nothing readable.
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
        return { id: option.id, name: option.name, color: option.color }
      }
    }
  }
  const minted: Json = { id: id !== '' ? id : name, name, color: 'default' }
  if (Array.isArray(options)) options.push({ ...minted })
  return minted
}

function normalizeValue(column: Json, kind: string, value: unknown): unknown {
  if (kind === 'title' || kind === 'rich_text') return normalizeRichText(value)
  if (kind === 'select' || kind === 'status') {
    return value === null || value === undefined ? null : selectOption(column, kind, asObject(value))
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
function normalizeProperties(properties: Json, schema: Json): Json {
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
    copy[kind] = normalizeValue(column, kind, prop[kind])
    out[key] = copy
  }
  return out
}

function normalizeBlockPayload(payload: Json): Json {
  const out: Json = { ...payload }
  if (Array.isArray(payload.rich_text)) out.rich_text = normalizeRichText(payload.rich_text)
  if (Array.isArray(payload.caption)) out.caption = normalizeRichText(payload.caption)
  return out
}

async function seed(db: PrismaClient, fx: Fixture, workspaceId: string): Promise<void> {
  idSeq.set(workspaceId, 0)
  const scope = { where: { workspaceId } }
  await db.notionComment.deleteMany(scope)
  await db.notionBlock.deleteMany(scope)
  await db.notionPage.deleteMany(scope)
  await db.notionDatabase.deleteMany(scope)
  let position = 0
  for (const d of fx.databases) {
    await db.notionDatabase.create({
      data: {
        id: d.id,
        workspaceId,
        parentType: d.parent.type,
        parentId: d.parent.id ?? null,
        titleText: d.title,
        titleJson: JSON.stringify([
          { type: 'text', plain_text: d.title, text: { content: d.title } },
        ]),
        descriptionJson: d.description !== undefined ? JSON.stringify(d.description) : null,
        propertiesJson: JSON.stringify(d.properties),
        isInline: d.is_inline ?? false,
        inTrash: d.in_trash ?? d.archived ?? false,
        createdTime: d.created_time ?? fx.defaults.created_time,
        lastEditedTime: d.last_edited_time ?? fx.defaults.last_edited_time,
        createdBy: d.created_by ?? fx.defaults.created_by,
        lastEditedBy: d.last_edited_by ?? fx.defaults.last_edited_by,
        url: d.url ?? defaultUrl(fx, d.id),
        position: position++,
      },
    })
  }
  position = 0
  for (const p of fx.pages) {
    const properties = p.properties ?? titleProp(p.title)
    await db.notionPage.create({
      data: {
        id: p.id,
        workspaceId,
        parentType: p.parent.type,
        parentId: p.parent.id ?? null,
        titleText: p.title !== '' ? p.title : titleOfProperties(properties),
        propertiesJson: JSON.stringify(properties),
        iconJson: p.icon !== undefined ? JSON.stringify(p.icon) : null,
        coverJson: p.cover !== undefined ? JSON.stringify(p.cover) : null,
        inTrash: p.in_trash ?? p.archived ?? false,
        createdTime: p.created_time ?? fx.defaults.created_time,
        lastEditedTime: p.last_edited_time ?? fx.defaults.last_edited_time,
        createdBy: p.created_by ?? fx.defaults.created_by,
        lastEditedBy: p.last_edited_by ?? fx.defaults.last_edited_by,
        url: p.url ?? defaultUrl(fx, p.id),
        position: position++,
      },
    })
  }
  const perParent = new Map<string, number>()
  for (const b of fx.blocks) {
    const at = perParent.get(b.parent) ?? 0
    perParent.set(b.parent, at + 1)
    await db.notionBlock.create({
      data: {
        id: b.id,
        workspaceId,
        parentId: b.parent,
        position: at,
        type: b.type,
        payloadJson: JSON.stringify(b.payload),
        hasChildren: b.has_children ?? false,
        createdTime: b.created_time ?? fx.defaults.created_time,
        lastEditedTime: b.last_edited_time ?? fx.defaults.last_edited_time,
        createdBy: b.created_by ?? fx.defaults.created_by,
        lastEditedBy: b.last_edited_by ?? fx.defaults.last_edited_by,
      },
    })
  }
  // Per parent, not a single running counter, because createComment numbers a
  // new comment by its parent's existing count. A global counter left a seeded
  // comment at a position a later write could duplicate and sort ahead of, so
  // an agent that wrote a comment and read it back saw it above the ones that
  // were already there.
  const perParentComment = new Map<string, number>()
  for (const c of fx.comments) {
    const parentId = c.parent.id ?? ''
    const at = perParentComment.get(parentId) ?? 0
    perParentComment.set(parentId, at + 1)
    await db.notionComment.create({
      data: {
        id: c.id,
        workspaceId,
        parentType: c.parent.type,
        parentId,
        discussionId: c.discussion_id ?? `disc-${c.id}`,
        richTextJson: JSON.stringify(c.rich_text),
        createdTime: c.created_time ?? fx.defaults.created_time,
        lastEditedTime: c.last_edited_time ?? fx.defaults.last_edited_time,
        createdBy: c.created_by ?? fx.defaults.created_by,
        position: at,
      },
    })
  }
}

// `archived` is upstream's deprecated alias for `in_trash` and, in its own
// words, "always returns the same value". So both names are read off the one
// stored bit here rather than from two columns that can disagree.
function pageJson(row: PageRow): Json {
  const out: Json = {
    object: 'page',
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    last_edited_by: { object: 'user', id: row.lastEditedBy },
    parent: pageParentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    url: row.url,
    properties: JSON.parse(row.propertiesJson) as Json,
  }
  if (row.iconJson !== null) out.icon = JSON.parse(row.iconJson) as Json
  if (row.coverJson !== null) out.cover = JSON.parse(row.coverJson) as Json
  return out
}

// Since 2025-09-03 a database holds data sources and the rows live under one
// of them. The fake derives one data source per database with a *distinct*
// deterministic id, so `db -> data source` resolution is really exercised
// rather than collapsing into an identity that would hide an id mix-up.
function dataSourceIdOf(databaseId: string): string {
  return `d5000000${databaseId.slice(8)}`
}

// A row's parent is its data source, not its database (2025-09-03). The
// database id rides along because Notion kept emitting it through the
// migration; storage still keys rows by database id, which is the same fact
// one derivation away.
//
// Deliberately not versioned, unlike `databaseJson`: 2022-06-28 answers
// `{type: "database_id", database_id}` with no data source, so a legacy caller
// reads a parent shape its generation never had. Left as one shape on purpose,
// because no in-repo or MCP caller reads `parent` off a row, and the divergence
// is drawn from Notion's upgrade guide rather than probed against the real API
// the way the schema behaviour was. Probe it before rendering both.
function pageParentJson(parentType: string, parentId: string | null): Json {
  if (parentType !== 'database_id' || parentId === null) {
    return parentJson(parentType, parentId)
  }
  return {
    type: 'data_source_id',
    data_source_id: dataSourceIdOf(parentId),
    database_id: parentId,
  }
}

function databaseIdOf(dataSourceId: string, databases: DatabaseRow[]): string | null {
  for (const row of databases) {
    if (dataSourceIdOf(row.id) === dataSourceId) return row.id
  }
  return null
}

function dataSourceJson(row: DatabaseRow): Json {
  return {
    object: 'data_source',
    id: dataSourceIdOf(row.id),
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    parent: { type: 'database_id', database_id: row.id },
    database_parent: parentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    title: JSON.parse(row.titleJson) as unknown[],
    description: [],
    properties: JSON.parse(row.propertiesJson) as Json,
  }
}

// The 2025-09-03 database object is a container, not a schema: `properties`
// moved to the data source and is deliberately absent there, so anything that
// still reads a column list off a modern database fails loudly instead of
// silently rendering an empty one.
//
// A 2022-06-28 caller gets the pre-split object back, because that is what real
// Notion answers it with: upstream calls the new behavior a *repurposing* of
// Retrieve a Database, and a connection on the old version "will continue to
// work with existing databases that have a single data source". Answering one
// shape to both versions is worse than either, and it cost a graded run: the
// agent could not learn a select column's options, wrote a value outside them,
// and Notion mints an unknown select option rather than rejecting it, so
// nothing told it. `data_sources` is absent from that answer for the same
// reason `properties` is absent from the modern one: the field did not exist
// at that version.
function databaseJson(row: DatabaseRow, version: string = DEFAULT_API_VERSION): Json {
  const out: Json = {
    object: 'database',
    ...(version < DATA_SOURCE_VERSION
      ? { properties: JSON.parse(row.propertiesJson) as Json }
      : { data_sources: [{ id: dataSourceIdOf(row.id), name: row.titleText }] }),
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    parent: parentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    is_inline: row.isInline,
    url: row.url,
    title: JSON.parse(row.titleJson) as unknown[],
  }
  if (row.descriptionJson !== null) {
    out.description = JSON.parse(row.descriptionJson) as unknown[]
  }
  return out
}

// Key order is load-bearing: mirage embeds the block verbatim in page.json, so
// the golden pins {object, id, type, has_children, <type>} exactly.
function blockJson(row: BlockRow): Json {
  return {
    object: 'block',
    id: row.id,
    type: row.type,
    has_children: row.hasChildren,
    [row.type]: JSON.parse(row.payloadJson) as Json,
  }
}

// Mirrors mirage's own _rich_text_to_md / _block_to_md so the /markdown
// endpoint and page.json's `markdown` field cannot disagree about the same
// blocks. Probed against live Notion: the response is
// {object: "page_markdown", id, markdown, truncated, unknown_block_ids}.
function richToMd(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  let out = ''
  for (const part of rich) {
    const item = asObject(part)
    let text = typeof item.plain_text === 'string' ? item.plain_text : ''
    const ann = asObject(item.annotations)
    if (ann.code === true) text = `\`${text}\``
    if (ann.bold === true) text = `**${text}**`
    if (ann.italic === true) text = `*${text}*`
    if (ann.strikethrough === true) text = `~~${text}~~`
    if (typeof item.href === 'string' && item.href !== '') text = `[${text}](${item.href})`
    out += text
  }
  return out
}

function blockToMd(row: BlockRow, indent: number): string {
  const content = JSON.parse(row.payloadJson) as Json
  const text = richToMd(content.rich_text)
  const pad = '  '.repeat(indent)
  const t = row.type
  if (t === 'paragraph') return `${pad}${text}`
  if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
    return `${'#'.repeat(Number(t.slice(-1)))} ${text}`
  }
  if (t === 'bulleted_list_item') return `${pad}- ${text}`
  if (t === 'numbered_list_item') return `${pad}1. ${text}`
  if (t === 'to_do') return `${pad}- [${content.checked === true ? 'x' : ' '}] ${text}`
  if (t === 'toggle') return `${pad}<details><summary>${text}</summary></details>`
  if (t === 'code') return `\`\`\`${String(content.language ?? '')}\n${text}\n\`\`\``
  if (t === 'quote') return `${pad}> ${text}`
  if (t === 'divider') return '---'
  if (t === 'child_page' || t === 'child_database') return ''
  return text === '' ? '' : `${pad}${text}`
}

async function markdownOf(
  db: PrismaClient,
  workspaceId: string,
  parentId: string,
  indent: number,
  lines: string[],
): Promise<void> {
  for (const row of await childrenOf(db, workspaceId, parentId)) {
    const line = blockToMd(row, indent)
    if (line !== '') lines.push(line)
    if (row.hasChildren) await markdownOf(db, workspaceId, row.id, indent + 1, lines)
  }
}

// The inverse, for POST /v1/pages {markdown}: the official CLI's
// `ntn pages create --content` sends Markdown, not properties.
function markdownToBlocks(markdown: string): Json[] {
  const blocks: Json[] = []
  const lines = markdown.split('\n')
  let fence: string[] | null = null
  let lang = ''
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (fence === null) {
        fence = []
        lang = line.slice(3).trim()
      } else {
        blocks.push({ type: 'code', code: { rich_text: [plainRich(fence.join('\n'))], language: lang || 'plain text' } })
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      const level = heading[1]?.length ?? 1
      blocks.push({
        type: `heading_${String(level)}`,
        [`heading_${String(level)}`]: { rich_text: [plainRich(heading[2] ?? '')] },
      })
      continue
    }
    const todo = /^-\s+\[([ xX])\]\s+(.*)$/.exec(trimmed)
    if (todo !== null) {
      blocks.push({
        type: 'to_do',
        to_do: { rich_text: [plainRich(todo[2] ?? '')], checked: (todo[1] ?? ' ').toLowerCase() === 'x' },
      })
      continue
    }
    if (trimmed.startsWith('- ')) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [plainRich(trimmed.slice(2))] },
      })
      continue
    }
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [plainRich(trimmed)] } })
  }
  return blocks
}

function plainRich(content: string): Json {
  return { type: 'text', plain_text: content, annotations: {}, text: { content } }
}

function commentJson(row: CommentRow): Json {
  return {
    object: 'comment',
    id: row.id,
    parent: parentJson(row.parentType, row.parentId),
    discussion_id: row.discussionId,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    rich_text: JSON.parse(row.richTextJson) as unknown[],
  }
}

// Notion's cursor is opaque, so an offset is a legal implementation and keeps
// the page boundary stable under the deterministic orderings used below.
function pageOf(items: Json[], startCursor: string | null, pageSize: number): Json {
  const offset = startCursor === null ? 0 : Number.parseInt(startCursor, 10)
  const start = Number.isNaN(offset) ? 0 : offset
  const size = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)
  const slice = items.slice(start, start + size)
  const next = start + size
  const more = next < items.length
  return {
    object: 'list',
    results: slice,
    has_more: more,
    next_cursor: more ? String(next) : null,
  }
}

type Reply = { status: number; json: unknown }

function apiError(status: number, code: string, message: string): Reply {
  return { status, json: { object: 'error', status, code, message } }
}

function notFound(kind: string, id: string): Reply {
  return apiError(
    404,
    'object_not_found',
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  )
}

function bearer(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

// Notion answers each request in the shape of the version it carries, and the
// two generations disagree about where a database's column schema lives, so
// the header has to reach the renderer rather than being read once at startup.
function apiVersion(req: IncomingMessage): string {
  const header = req.headers['notion-version']
  const value = Array.isArray(header) ? header[0] : header
  return value === undefined || value === '' ? DEFAULT_API_VERSION : value
}

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function intOr(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

function cursorOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

async function childrenOf(
  db: PrismaClient,
  workspaceId: string,
  parentId: string,
): Promise<BlockRow[]> {
  return (await db.notionBlock.findMany({
    where: { workspaceId, parentId, inTrash: false },
    orderBy: { position: 'asc' },
  })) as BlockRow[]
}

async function searchResults(
  db: PrismaClient,
  workspaceId: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const filter = asObject(args.filter)
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const matches = (title: string): boolean => query === '' || title.toLowerCase().includes(query)
  // 2022-06-28 spells this "database"; 2026-03-11 replaced it with
  // "data_source" and rejects the old word. The fake answers both so the
  // battery's client and the official CLI can share one server.
  if (filter.value === 'database' || filter.value === 'data_source') {
    const rows = (await db.notionDatabase.findMany({
      where: { workspaceId, inTrash: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })) as DatabaseRow[]
    const kept = rows.filter((r) => matches(r.titleText))
    return filter.value === 'data_source'
      ? kept.map(dataSourceJson)
      : kept.map((r) => databaseJson(r, version))
  }
  const rows = (await db.notionPage.findMany({
    where: { workspaceId, inTrash: false },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as PageRow[]
  return rows.filter((r) => matches(r.titleText)).map(pageJson)
}

function propByName(page: Json, name: string): Json | undefined {
  const value = asObject(page.properties)[name]
  return value === undefined ? undefined : asObject(value)
}

function textOfProp(prop: Json): string {
  if (Array.isArray(prop.title)) return plainTextOf(prop.title)
  if (Array.isArray(prop.rich_text)) return plainTextOf(prop.rich_text)
  return ''
}

function numberOfProp(prop: Json): number | null {
  return typeof prop.number === 'number' ? prop.number : null
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

// Notion's filter is a recursive and/or tree over typed property conditions.
// Implemented here for the types the battery's fixtures use (title/rich_text,
// number, checkbox, select); an unrecognized condition matches rather than
// silently dropping the row, so a filter this does not understand degrades to
// "no filter" instead of "no results".
function matchesFilter(page: Json, filter: Json): boolean {
  if (Array.isArray(filter.and)) return filter.and.every((f) => matchesFilter(page, asObject(f)))
  if (Array.isArray(filter.or)) return filter.or.some((f) => matchesFilter(page, asObject(f)))
  const name = typeof filter.property === 'string' ? filter.property : ''
  if (name === '') return true
  const prop = propByName(page, name)
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
  return true
}

function sortKey(page: Json, sort: Json): string | number {
  if (typeof sort.timestamp === 'string') {
    const key = sort.timestamp === 'created_time' ? 'created_time' : 'last_edited_time'
    return typeof page[key] === 'string' ? String(page[key]) : ''
  }
  const prop = propByName(page, typeof sort.property === 'string' ? sort.property : '')
  if (prop === undefined) return ''
  const num = numberOfProp(prop)
  return num === null ? textOfProp(prop) : num
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
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0
      if (cmp !== 0) return sort.direction === 'descending' ? -cmp : cmp
    }
    return 0
  })
  return out
}

async function databaseRows(
  db: PrismaClient,
  workspaceId: string,
  databaseId: string,
  args: Json,
): Promise<Json[]> {
  const rows = (await db.notionPage.findMany({
    where: { workspaceId, parentType: 'database_id', parentId: databaseId, inTrash: false },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as PageRow[]
  let out = rows.map(pageJson)
  if (args.filter !== undefined) {
    out = out.filter((row) => matchesFilter(row, asObject(args.filter)))
  }
  return applySorts(out, args.sorts)
}

// A child page is one object in two tables: the NotionPage row is the record,
// the NotionBlock row of type child_page is how the parent's children listing
// reaches it. Both are written here so the two views cannot drift.
async function createPage(
  db: PrismaClient,
  workspaceId: string,
  fx: Fixture,
  body: Json,
): Promise<Reply> {
  const parent = asObject(body.parent)
  let parentType = 'workspace'
  let parentId: string | null = null
  if (typeof parent.page_id === 'string') {
    parentType = 'page_id'
    parentId = parent.page_id
  } else if (typeof parent.data_source_id === 'string') {
    // Rows are addressed by data source since 2025-09-03, but storage keys
    // them by database, so the parent resolves back one hop here.
    const all = (await db.notionDatabase.findMany({ where: { workspaceId } })) as DatabaseRow[]
    const owner = databaseIdOf(parent.data_source_id, all)
    if (owner === null) return notFound('data source', parent.data_source_id)
    parentType = 'database_id'
    parentId = owner
  } else if (typeof parent.database_id === 'string') {
    parentType = 'database_id'
    parentId = parent.database_id
  } else if (parent.workspace !== true) {
    return apiError(400, 'validation_error', 'body.parent should be defined.')
  }
  if (parentType === 'page_id' && parentId !== null) {
    const owner = await db.notionPage.findFirst({ where: { workspaceId, id: parentId } })
    if (owner === null) return notFound('page', parentId)
  }
  // The owner is read once and serves three purposes: the parent check, the
  // column schema a written property is normalized against, and the name of
  // the title column a markdown-only create files its heading under.
  let owner: DatabaseRow | null = null
  if (parentType === 'database_id' && parentId !== null) {
    owner = (await db.notionDatabase.findFirst({
      where: { workspaceId, id: parentId },
    })) as DatabaseRow | null
    if (owner === null) return notFound('database', parentId)
  }
  const schema = schemaOf(owner)
  const schemaBefore = JSON.stringify(schema)
  const properties = normalizeProperties(asObject(body.properties), schema)
  await persistSchema(db, workspaceId, owner, schema, schemaBefore)
  const id = mintId(workspaceId, 'a0000000')
  // `ntn pages create --content` sends Markdown rather than properties; the
  // first heading becomes the title, exactly as the official CLI documents.
  const markdown = typeof body.markdown === 'string' ? body.markdown : ''
  const fromMarkdown = markdown === '' ? [] : markdownToBlocks(markdown)
  let title = titleOfProperties(properties)
  if (title === '' && fromMarkdown.length > 0) {
    const head = asObject(fromMarkdown[0])
    if (String(head.type).startsWith('heading_')) {
      title = richToMd(asObject(head[String(head.type)]).rich_text)
      fromMarkdown.shift()
    }
  }
  if (title !== '' && Object.keys(properties).length === 0) {
    Object.assign(properties, titleProp(title, titleColumnOf(schema)))
  }
  await db.notionPage.create({
    data: {
      id,
      workspaceId,
      parentType,
      parentId,
      titleText: title,
      propertiesJson: JSON.stringify(properties),
      iconJson: body.icon !== undefined ? JSON.stringify(body.icon) : null,
      coverJson: body.cover !== undefined ? JSON.stringify(body.cover) : null,
      createdTime: fx.defaults.created_time,
      lastEditedTime: fx.defaults.last_edited_time,
      createdBy: fx.defaults.created_by,
      lastEditedBy: fx.defaults.last_edited_by,
      url: defaultUrl(fx, id),
      position: await db.notionPage.count({ where: { workspaceId } }),
    },
  })
  if (parentType === 'page_id' && parentId !== null) {
    await db.notionBlock.create({
      data: {
        id,
        workspaceId,
        parentId,
        position: await db.notionBlock.count({ where: { workspaceId, parentId } }),
        type: 'child_page',
        payloadJson: JSON.stringify({ title }),
        hasChildren: false,
        createdTime: fx.defaults.created_time,
        lastEditedTime: fx.defaults.last_edited_time,
        createdBy: fx.defaults.created_by,
        lastEditedBy: fx.defaults.last_edited_by,
      },
    })
  }
  if (fromMarkdown.length > 0) {
    await appendChildren(db, workspaceId, fx, id, { children: fromMarkdown })
  }
  const created = (await db.notionPage.findFirst({ where: { workspaceId, id } })) as PageRow
  return { status: 200, json: pageJson(created) }
}

async function appendChildren(
  db: PrismaClient,
  workspaceId: string,
  fx: Fixture,
  parentId: string,
  body: Json,
): Promise<Reply> {
  const children = Array.isArray(body.children) ? body.children : []
  const parentPage = await db.notionPage.findFirst({ where: { workspaceId, id: parentId } })
  const parentBlock = await db.notionBlock.findFirst({ where: { workspaceId, id: parentId } })
  if (parentPage === null && parentBlock === null) return notFound('block', parentId)
  // Validate every child before touching the table: a refused request
  // must leave no partial insert and no shifted sibling behind.
  const specs: [string, Json][] = []
  for (const child of children) {
    const spec = asObject(child)
    const type = typeof spec.type === 'string' ? spec.type : ''
    if (type === '' || spec[type] === undefined) {
      return apiError(400, 'validation_error', 'body.children[].type should be defined.')
    }
    specs.push([type, asObject(spec[type])])
  }
  let at = await db.notionBlock.count({ where: { workspaceId, parentId } })
  let anchorPos: number | null = null
  const after = typeof body.after === 'string' ? body.after : null
  if (after !== null) {
    // `after` inserts the new blocks directly behind an existing child;
    // later siblings shift down. The live API reports a malformed id and
    // a well-formed one that is not a child of this parent with the SAME
    // validation message (probed on 2025-09-03).
    const anchor = await db.notionBlock.findFirst({ where: { workspaceId, id: after } })
    if (anchor === null || anchor.parentId !== parentId) {
      return apiError(
        400,
        'validation_error',
        `body failed validation: body.position.after_block.id should be a valid uuid, instead was \`"${after}"\`.`,
      )
    }
    await db.notionBlock.updateMany({
      where: { workspaceId, parentId, position: { gt: anchor.position } },
      data: { position: { increment: children.length } },
    })
    anchorPos = anchor.position
    at = anchor.position + 1
  }
  const created: Json[] = []
  for (const [type, payload] of specs) {
    const id = mintId(workspaceId, 'b0000000')
    await db.notionBlock.create({
      data: {
        id,
        workspaceId,
        parentId,
        position: at++,
        type,
        payloadJson: JSON.stringify(normalizeBlockPayload(payload)),
        hasChildren: false,
        createdTime: fx.defaults.created_time,
        lastEditedTime: fx.defaults.last_edited_time,
        createdBy: fx.defaults.created_by,
        lastEditedBy: fx.defaults.last_edited_by,
      },
    })
    const row = (await db.notionBlock.findFirst({ where: { workspaceId, id } })) as BlockRow
    created.push(blockJson(row))
  }
  if (parentBlock !== null) {
    await db.notionBlock.update({
      where: { workspaceId_id: { workspaceId, id: parentId } },
      data: { hasChildren: true },
    })
  }
  // With `after`, the live API answers with the inserted blocks AND every
  // sibling behind them, in order (probed); a plain append returns just
  // the inserted blocks.
  let results = created
  if (anchorPos !== null) {
    const fromAnchor = await db.notionBlock.findMany({
      where: { workspaceId, parentId, position: { gt: anchorPos } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })
    results = fromAnchor.map((row) => blockJson(row as BlockRow))
  }
  return {
    status: 200,
    json: { object: 'list', results, has_more: false, next_cursor: null },
  }
}

async function createComment(
  db: PrismaClient,
  workspaceId: string,
  fx: Fixture,
  body: Json,
): Promise<Reply> {
  const parent = asObject(body.parent)
  const parentId = typeof parent.page_id === 'string' ? parent.page_id : ''
  if (parentId === '') {
    return apiError(400, 'validation_error', 'body.parent.page_id should be a valid uuid.')
  }
  const owner = await db.notionPage.findFirst({ where: { workspaceId, id: parentId } })
  if (owner === null) return notFound('page', parentId)
  // One tick per comment: the discussion shares the comment's sequence number
  // so a scenario's ids stay easy to predict.
  const seq = nextSeq(workspaceId)
  const id = idAt('c0000000', seq)
  await db.notionComment.create({
    data: {
      id,
      workspaceId,
      parentType: 'page_id',
      parentId,
      discussionId: idAt('d0000000', seq),
      richTextJson: JSON.stringify(Array.isArray(body.rich_text) ? body.rich_text : []),
      createdTime: fx.defaults.created_time,
      lastEditedTime: fx.defaults.last_edited_time,
      createdBy: fx.defaults.created_by,
      position: await db.notionComment.count({ where: { workspaceId, parentId } }),
    },
  })
  const row = (await db.notionComment.findFirst({ where: { workspaceId, id } })) as CommentRow
  return { status: 200, json: commentJson(row) }
}

// The read half of the comment surface. Without it a scenario can only write:
// an evaluator that grades what an agent said in a comment, or an agent that
// leaves a link in one and reads it back, both need this and both used to hit
// the route-not-found fallthrough.
//
// `block_id` names a page or a block, which is why existence is resolved
// against both tables the way deleteBlock resolves its operand. Comments are
// stored parented to a page today, so an existing block carrying none of them
// answers with an empty list rather than a 404, since upstream 404s only when
// the id itself is not shared with the integration.
async function listComments(
  db: PrismaClient,
  workspaceId: string,
  q: URLSearchParams,
): Promise<Reply> {
  const blockId = q.get('block_id') ?? ''
  if (blockId === '') {
    return apiError(400, 'validation_error', 'block_id should be a valid uuid.')
  }
  const page = await db.notionPage.findFirst({ where: { workspaceId, id: blockId } })
  if (page === null) {
    const block = await db.notionBlock.findFirst({ where: { workspaceId, id: blockId } })
    if (block === null) return notFound('block', blockId)
  }
  // Upstream returns every discussion's comments in one ascending chronological
  // flat list, distinguishable by discussion_id, rather than grouped by thread.
  const rows = (await db.notionComment.findMany({
    where: { workspaceId, parentId: blockId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as CommentRow[]
  const size = intOr(q.get('page_size'), MAX_PAGE_SIZE)
  return { status: 200, json: pageOf(rows.map(commentJson), q.get('start_cursor'), size) }
}

// A child page is one object in two tables (see the schema's NotionPage note),
// so trashing it has to move both rows: the NotionPage row is what /search and
// a database query read, the NotionBlock row is what the parent's children
// listing reads, and setting only one leaves the page gone from half the
// surfaces and present in the other half.
async function setTrashed(
  db: PrismaClient,
  workspaceId: string,
  id: string,
  trashed: boolean,
): Promise<void> {
  const where = { workspaceId_id: { workspaceId, id } }
  if ((await db.notionPage.findFirst({ where: { workspaceId, id } })) !== null) {
    await db.notionPage.update({ where, data: { inTrash: trashed } })
  }
  if ((await db.notionBlock.findFirst({ where: { workspaceId, id } })) !== null) {
    await db.notionBlock.update({ where, data: { inTrash: trashed } })
  }
}

// DELETE /v1/blocks/{id} is the only delete verb the public API has, and the
// only one the MCP tool surface exposes (API-delete-a-block), so without it an
// MCP client cannot remove anything. Upstream: "Sets a Block object, including
// page blocks, to in_trash: true", which covers database rows, so this resolves
// a block id first and falls back to a page of the same id.
async function deleteBlock(db: PrismaClient, workspaceId: string, id: string): Promise<Reply> {
  const block = (await db.notionBlock.findFirst({
    where: { workspaceId, id },
  })) as BlockRow | null
  const page = (await db.notionPage.findFirst({
    where: { workspaceId, id },
  })) as PageRow | null
  if (block === null && page === null) return notFound('block', id)
  await setTrashed(db, workspaceId, id, true)
  // A page that owns no block row (a top-level page, or a database row) still
  // answers as a block, which is what "including page blocks" means.
  const body =
    block === null
      ? { object: 'block', id, type: 'child_page', has_children: false, child_page: { title: (page as PageRow).titleText } }
      : blockJson(block)
  return { status: 200, json: { ...body, archived: true, in_trash: true } }
}

async function updatePage(
  db: PrismaClient,
  workspaceId: string,
  id: string,
  body: Json,
): Promise<Reply> {
  const row = (await db.notionPage.findFirst({ where: { workspaceId, id } })) as PageRow | null
  if (row === null) return notFound('page', id)
  const data: Record<string, unknown> = {}
  // Two spellings of one bit, so `ntn pages trash` (in_trash) and an API or
  // MCP client (archived) reach the same state rather than half of it.
  const trash = typeof body.in_trash === 'boolean' ? body.in_trash : body.archived
  if (typeof trash === 'boolean') await setTrashed(db, workspaceId, id, trash)
  if (body.properties !== undefined) {
    const owner =
      row.parentType === 'database_id' && row.parentId !== null
        ? ((await db.notionDatabase.findFirst({
            where: { workspaceId, id: row.parentId },
          })) as DatabaseRow | null)
        : null
    const schema = schemaOf(owner)
    const schemaBefore = JSON.stringify(schema)
    const patch = normalizeProperties(asObject(body.properties), schema)
    await persistSchema(db, workspaceId, owner, schema, schemaBefore)
    const merged = { ...(JSON.parse(row.propertiesJson) as Json), ...patch }
    data.propertiesJson = JSON.stringify(merged)
    data.titleText = titleOfProperties(merged)
  }
  if (body.icon !== undefined) data.iconJson = JSON.stringify(body.icon)
  if (body.cover !== undefined) data.coverJson = JSON.stringify(body.cover)
  await db.notionPage.update({ where: { workspaceId_id: { workspaceId, id } }, data })
  const updated = (await db.notionPage.findFirst({ where: { workspaceId, id } })) as PageRow
  return { status: 200, json: pageJson(updated) }
}

async function handle(
  db: PrismaClient,
  fx: Fixture,
  method: string,
  req: IncomingMessage,
  url: URL,
  body: Json,
): Promise<Reply> {
  const parts = url.pathname.split('/').filter((part) => part !== '')
  const q = url.searchParams

  if (method === 'POST' && url.pathname === '/reset') {
    const workspaceId = typeof body.workspace === 'string' ? body.workspace : DEFAULT_TOKEN
    const fixture =
      typeof body.fixture === 'string'
        ? (JSON.parse(readFileSync(body.fixture, 'utf8')) as Fixture)
        : fx
    await seed(db, fixture, workspaceId)
    return { status: 200, json: { ok: true, workspace: workspaceId } }
  }

  const ws = bearer(req)
  if (ws === '') return apiError(401, 'unauthorized', 'API token is invalid.')
  if (parts[0] !== 'v1') return notFound('route', url.pathname)

  if (method === 'GET' && parts.length === 3 && parts[1] === 'pages') {
    const id = parts[2] ?? ''
    const row = (await db.notionPage.findFirst({
      where: { workspaceId: ws, id },
    })) as PageRow | null
    if (row === null) return notFound('page', id)
    return { status: 200, json: pageJson(row) }
  }

  if (method === 'GET' && parts.length === 3 && parts[1] === 'users' && parts[2] === 'me') {
    return {
      status: 200,
      json: {
        object: 'user',
        id: idAt('e0000000', 1),
        name: 'mirage-integ',
        avatar_url: null,
        type: 'bot',
        bot: {
          owner: { type: 'workspace', workspace: true },
          workspace_name: ws,
          workspace_id: idAt('e0000000', 2),
          workspace_limits: { max_file_upload_size_in_bytes: 5242880 },
        },
      },
    }
  }

  if (method === 'GET' && parts.length === 4 && parts[1] === 'pages' && parts[3] === 'markdown') {
    const id = parts[2] ?? ''
    const row = await db.notionPage.findFirst({ where: { workspaceId: ws, id } })
    if (row === null) return notFound('page', id)
    const lines: string[] = []
    await markdownOf(db, ws, id, 0, lines)
    return {
      status: 200,
      json: {
        object: 'page_markdown',
        id,
        markdown: lines.length === 0 ? '' : `${lines.join('\n\n')}\n`,
        truncated: false,
        unknown_block_ids: [],
      },
    }
  }

  // `ntn pages edit --content` replaces a page's body wholesale, which the
  // API models as one typed operation rather than a block-by-block diff.
  if (method === 'PATCH' && parts.length === 4 && parts[1] === 'pages' && parts[3] === 'markdown') {
    const id = parts[2] ?? ''
    const row = await db.notionPage.findFirst({ where: { workspaceId: ws, id } })
    if (row === null) return notFound('page', id)
    if (body.type !== 'replace_content') {
      return apiError(400, 'validation_error', 'body.type should be "replace_content".')
    }
    const replacement = asObject(body.replace_content).new_str
    if (typeof replacement !== 'string') {
      return apiError(400, 'validation_error', 'body.replace_content.new_str should be defined.')
    }
    const kept = await db.notionBlock.findMany({ where: { workspaceId: ws, parentId: id } })
    for (const one of kept) {
      if (one.type === 'child_page' || one.type === 'child_database') continue
      await db.notionBlock.delete({ where: { workspaceId_id: { workspaceId: ws, id: one.id } } })
    }
    const blocks = replacement === '' ? [] : markdownToBlocks(replacement)
    if (blocks.length > 0) {
      await appendChildren(db, ws, fx, id, { children: blocks })
    }
    const lines: string[] = []
    await markdownOf(db, ws, id, 0, lines)
    return {
      status: 200,
      json: {
        object: 'page_markdown',
        id,
        markdown: lines.length === 0 ? '' : `${lines.join('\n\n')}\n`,
        truncated: false,
        unknown_block_ids: [],
      },
    }
  }

  if (method === 'GET' && parts.length === 3 && parts[1] === 'data_sources') {
    const all = (await db.notionDatabase.findMany({ where: { workspaceId: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(parts[2] ?? '', all)
    const row = all.find((d) => d.id === owner)
    if (row === undefined) return notFound('data source', parts[2] ?? '')
    return { status: 200, json: dataSourceJson(row) }
  }

  if (
    method === 'POST' &&
    parts.length === 4 &&
    parts[1] === 'data_sources' &&
    parts[3] === 'query'
  ) {
    const all = (await db.notionDatabase.findMany({ where: { workspaceId: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(parts[2] ?? '', all)
    if (owner === null) return notFound('data source', parts[2] ?? '')
    const rows = await databaseRows(db, ws, owner, body)
    const size = intOr(body.page_size, MAX_PAGE_SIZE)
    return { status: 200, json: pageOf(rows, cursorOf(body.start_cursor), size) }
  }

  if (method === 'GET' && parts.length === 3 && parts[1] === 'databases') {
    const id = parts[2] ?? ''
    const row = (await db.notionDatabase.findFirst({
      where: { workspaceId: ws, id },
    })) as DatabaseRow | null
    if (row === null) return notFound('database', id)
    return { status: 200, json: databaseJson(row, apiVersion(req)) }
  }

  if (method === 'GET' && parts.length === 4 && parts[1] === 'blocks' && parts[3] === 'children') {
    const rows = await childrenOf(db, ws, parts[2] ?? '')
    const size = intOr(q.get('page_size'), MAX_PAGE_SIZE)
    return { status: 200, json: pageOf(rows.map(blockJson), q.get('start_cursor'), size) }
  }

  // Retrieve one block. The children route was here and this one was not,
  // which is a gap only a client that walks *to* a block notices:
  // @notionhq/notion-mcp-server reads an inline database by asking for the
  // block whose id it is, and got a 404 saying the object did not exist. A
  // database and a page both answer, because in Notion the child_database /
  // child_page block and the thing it points at share an id; a trashed row
  // still answers with the flag set, the way retrieve serves a trashed page
  // and DELETE reports the block it just trashed.
  if (method === 'GET' && parts.length === 3 && parts[1] === 'blocks') {
    const id = parts[2] ?? ''
    const block = (await db.notionBlock.findFirst({
      where: { workspaceId: ws, id },
    })) as BlockRow | null
    if (block !== null) {
      return {
        status: 200,
        json: { ...blockJson(block), archived: block.inTrash, in_trash: block.inTrash },
      }
    }
    const database = (await db.notionDatabase.findFirst({
      where: { workspaceId: ws, id },
    })) as DatabaseRow | null
    if (database !== null) {
      return {
        status: 200,
        json: {
          object: 'block',
          id: database.id,
          type: 'child_database',
          has_children: false,
          child_database: { title: database.titleText },
          archived: database.inTrash,
          in_trash: database.inTrash,
        },
      }
    }
    const page = (await db.notionPage.findFirst({
      where: { workspaceId: ws, id },
    })) as PageRow | null
    if (page !== null) {
      const kids = await childrenOf(db, ws, id)
      return {
        status: 200,
        json: {
          object: 'block',
          id: page.id,
          type: 'child_page',
          has_children: kids.length > 0,
          child_page: { title: page.titleText },
          archived: page.inTrash,
          in_trash: page.inTrash,
        },
      }
    }
    return notFound('block', id)
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'search') {
    const results = await searchResults(db, ws, body, apiVersion(req))
    const size = intOr(body.page_size, MAX_PAGE_SIZE)
    return { status: 200, json: pageOf(results, cursorOf(body.start_cursor), size) }
  }

  if (method === 'POST' && parts.length === 4 && parts[1] === 'databases' && parts[3] === 'query') {
    const id = parts[2] ?? ''
    const owner = await db.notionDatabase.findFirst({ where: { workspaceId: ws, id } })
    if (owner === null) return notFound('database', id)
    const rows = await databaseRows(db, ws, id, body)
    const size = intOr(body.page_size, MAX_PAGE_SIZE)
    return { status: 200, json: pageOf(rows, cursorOf(body.start_cursor), size) }
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'pages') {
    return createPage(db, ws, fx, body)
  }

  if (method === 'PATCH' && parts.length === 3 && parts[1] === 'pages') {
    return updatePage(db, ws, parts[2] ?? '', body)
  }

  if (method === 'PATCH' && parts.length === 4 && parts[1] === 'blocks' && parts[3] === 'children') {
    return appendChildren(db, ws, fx, parts[2] ?? '', body)
  }

  if (method === 'DELETE' && parts.length === 3 && parts[1] === 'blocks') {
    return deleteBlock(db, ws, parts[2] ?? '')
  }

  if (method === 'GET' && parts.length === 2 && parts[1] === 'comments') {
    return listComments(db, ws, q)
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'comments') {
    return createComment(db, ws, fx, body)
  }

  return notFound('route', url.pathname)
}

async function createStore(label: string): Promise<{ db: PrismaClient; fx: Fixture }> {
  const dbUrl = `file:${join(tmpdir(), `mirage-notion-${label}-${String(process.pid)}.db`)}`
  pushSchema(dbUrl)
  const db = new PrismaClient({ datasourceUrl: dbUrl })
  const fx = loadFixture()
  await seed(db, fx, DEFAULT_TOKEN)
  return { db, fx }
}

// The fake answers every request from one event loop, so two writes to the
// same workspace interleave at any await: both read the schema (or a page's
// properties, or the row count that becomes a position), both write it back,
// and the later one silently drops the earlier one's change. A minted select
// option lost that way is the worst of them, because the page that minted it
// still stores the id the schema no longer has. Every mutating route is a
// read-modify-write from end to end, so they queue per workspace at the door
// rather than step by step: one rule, and the only place that cannot fall out
// of step when a route is added. Reads over GET stay concurrent, and a POST
// query waiting behind a pending write is what makes its answer a consistent
// one.
const writeQueue = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = writeQueue.get(key) ?? Promise.resolve()
  const next = prior.then(run)
  writeQueue.set(
    key,
    next.catch(() => null),
  )
  return next
}

// /reset carries no bearer, so its workspace comes from the body; every other
// route is scoped by the token, which is the workspace id.
function workspaceKey(req: IncomingMessage, url: URL, body: Json): string {
  if (url.pathname === '/reset') {
    return typeof body.workspace === 'string' ? body.workspace : DEFAULT_TOKEN
  }
  return bearer(req)
}

function dispatch(
  db: PrismaClient,
  fx: Fixture,
  method: string,
  req: IncomingMessage,
  url: URL,
  body: Json,
): Promise<Reply> {
  if (method === 'GET' || method === 'HEAD') return handle(db, fx, method, req, url, body)
  return serialize(workspaceKey(req, url, body), () => handle(db, fx, method, req, url, body))
}

function serve(db: PrismaClient, fx: Fixture): Server {
  return createServer((req, res) => {
    const host = req.headers.host ?? '127.0.0.1'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Json = {}
      if (raw !== '') {
        try {
          body = JSON.parse(raw) as Json
        } catch {
          const bad = apiError(400, 'invalid_json', 'Error parsing JSON body.')
          res.writeHead(bad.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(bad.json))
          return
        }
      }
      void dispatch(db, fx, req.method ?? 'GET', req, url, body)
        .then((reply) => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(reply.json))
        })
        .catch((err: unknown) => {
          console.error('notion fake: route error', err)
          const oops = apiError(500, 'internal_server_error', String(err))
          res.writeHead(oops.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(oops.json))
        })
    })
  })
}

export async function startServer(port: number, host = '127.0.0.1'): Promise<Server> {
  const { db, fx } = await createStore(`rest-${String(port)}`)
  const server = serve(db, fx)
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server))
  })
}

export async function startMockServer(): Promise<{ server: Server; port: number }> {
  const server = await startServer(0)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

// The MCP arm speaks the tool names @notionhq/notion-mcp-server derives from
// the Notion OpenAPI document (operationId prefixed with "API-"), so a mount
// backed by MCP and one backed by REST render the same tree.
async function toolPayload(db: PrismaClient, name: string, args: Json): Promise<unknown> {
  const ws = DEFAULT_TOKEN
  if (name === 'API-post-search') {
    const results = await searchResults(db, ws, args)
    return pageOf(results, cursorOf(args.start_cursor), intOr(args.page_size, MAX_PAGE_SIZE))
  }
  if (name === 'API-retrieve-a-page') {
    const id = String(args.page_id)
    const row = (await db.notionPage.findFirst({
      where: { workspaceId: ws, id },
    })) as PageRow | null
    if (row === null) throw new Error(`mock notion: unknown page ${id}`)
    return pageJson(row)
  }
  if (name === 'API-retrieve-a-database') {
    const id = String(args.database_id)
    const row = (await db.notionDatabase.findFirst({
      where: { workspaceId: ws, id },
    })) as DatabaseRow | null
    if (row === null) throw new Error(`mock notion: unknown database ${id}`)
    // No version to read: a tool call carries no Notion-Version, and this arm
    // exists to render byte-identically to the REST arm, which mirage's own
    // 2025-09-03 client drives. An external MCP server that pins 2022-06-28
    // reaches the fake over REST and gets that version's shape from there.
    return databaseJson(row)
  }
  if (name === 'API-retrieve-a-data-source') {
    const id = String(args.data_source_id)
    const all = (await db.notionDatabase.findMany({ where: { workspaceId: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(id, all)
    const row = owner === null ? null : all.find((one) => one.id === owner)
    if (row === undefined || row === null) throw new Error(`mock notion: unknown data source ${id}`)
    return dataSourceJson(row)
  }
  if (name === 'API-post-data-source-query') {
    const all = (await db.notionDatabase.findMany({ where: { workspaceId: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(String(args.data_source_id), all)
    if (owner === null) throw new Error(`mock notion: unknown data source`)
    const rows = await databaseRows(db, ws, owner, args)
    return pageOf(rows, cursorOf(args.start_cursor), intOr(args.page_size, MAX_PAGE_SIZE))
  }
  if (name === 'API-retrieve-block-children') {
    const rows = await childrenOf(db, ws, String(args.block_id))
    const size = intOr(args.page_size, MAX_PAGE_SIZE)
    return pageOf(rows.map(blockJson), cursorOf(args.start_cursor), size)
  }
  // The one delete verb the tool surface has. It mutates, so it takes the same
  // per-workspace queue every REST mutation takes rather than a second rule.
  if (name === 'API-delete-a-block') {
    const id = String(args.block_id)
    const reply = await serialize(ws, () => deleteBlock(db, ws, id))
    if (reply.status !== 200) throw new Error(`mock notion: unknown block ${id}`)
    return reply.json
  }
  throw new Error(`mock notion: unsupported tool ${name}`)
}

function buildMcpServer(db: PrismaClient): McpServer {
  const server = new McpServer(
    { name: 'mock-notion-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const payload = await toolPayload(db, req.params.name, req.params.arguments ?? {})
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  })
  return server
}

export async function startMockMcpServer(): Promise<{ server: Server; port: number }> {
  const { db } = await createStore('mcp')
  const server = createServer((req, res) => {
    void (async () => {
      const mcp = buildMcpServer(db)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    })().catch((err: unknown) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({ server, port: address.port })
    })
  })
}

export const CASES: ReadonlyArray<readonly [string, string]> = [
  ['ls_root', `ls ${MOUNT}/`],
  ['ls_pages', `ls ${MOUNT}/pages/`],
  ['ls_l_pages', `ls -l ${MOUNT}/pages/`],
  ['ls_page_a', `ls ${DIR_A}/`],
  ['stat_dir_a', `stat -c '%n %y' ${DIR_A}`],
  ['cat_page_a', `cat ${DIR_A}/page.json`],
  ['cat_child', `cat ${DIR_C}/page.json`],
  ['jq_title', `jq ".title" ${DIR_A}/page.json`],
  ['jq_markdown', `jq ".markdown" ${DIR_B}/page.json`],
  ['head_4', `head -n 4 ${DIR_A}/page.json`],
  ['wc_l_two', `wc -l ${DIR_A}/page.json ${DIR_B}/page.json`],
  ['stat_page_json', `stat ${DIR_A}/page.json`],
  ['find_json', `find ${MOUNT}/pages/ -name page.json`],
  ['find_root_maxdepth0', `find ${MOUNT} -maxdepth 0`],
  ['find_root_name', `find ${MOUNT} -name notion`],
  ['pipe_grep', `cat ${DIR_B}/page.json | grep -c alpha`],
  ['grep_file', `grep -n alpha ${DIR_B}/page.json`],
  ['grep_multi', `grep -c alpha ${DIR_A}/page.json ${DIR_B}/page.json`],
  ['grep_recursive', `grep -rl alpha ${MOUNT}/pages/`],
  ['realpath_dotdot', `realpath -e ${DIR_C}/../page.json`],
  ['ls_databases', `ls ${MOUNT}/databases/`],
  ['ls_database_dir', `ls ${DB_DIR}/`],
  ['cat_database_json', `cat ${DB_DIR}/database.json`],
  ['ls_data_source_dir', `ls ${DS_DIR}/`],
  ['cat_data_source_json', `cat ${DS_DIR}/data_source.json`],
  ['jq_data_source_props', `jq ".properties | keys" ${DS_DIR}/data_source.json`],
  ['cat_row', `cat ${ROW_1_DIR}/page.json`],
  ['jq_row_cells', `jq ".properties.Priority.number" ${ROW_1_DIR}/page.json`],
  ['du_pages', `du ${MOUNT}/pages/`],
  ['du_page_a', `du ${DIR_A}/`],
]

export const EXIT_CODE_CASES: ReadonlyArray<readonly [string, string]> = [
  ['grep_c_match_exit', `grep -c alpha ${DIR_B}/page.json`],
  ['grep_c_no_match_exit', `grep -c zzz ${DIR_B}/page.json`],
  ['grep_rc_no_match_exit', `grep -rc zzz ${MOUNT}/pages/`],
]

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('notion_server.ts')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port =
    portArg !== -1 ? Number.parseInt(process.argv[portArg + 1] as string, 10) : DEFAULT_PORT
  // Loopback by default, which is every direct invocation. A container has
  // to bind 0.0.0.0 or its published port accepts the connection and then
  // answers nothing -- an empty reply with no error anywhere to explain it.
  const hostArg = process.argv.indexOf('--host')
  const host = hostArg !== -1 ? (process.argv[hostArg + 1] as string) : '127.0.0.1'
  void startServer(port, host).then(() => {
    console.log(`NOTION_URL=http://127.0.0.1:${String(port)}`)
  })
}

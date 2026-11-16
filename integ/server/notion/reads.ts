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
import type {
  NotionBlock,
  NotionDatabase,
  NotionPage,
  NotionUser,
} from '../../generated/notion/index.js'
import { DMMF } from './store.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { DEFAULT_API_VERSION, MAX_PAGE_SIZE } from './config.ts'
import { databaseRows, filterRefusal, keepProperties, propByRef, searchResults } from './search.ts'
import { childrenOf, dataSourceOwner, markdownOf, metaOf } from './store.ts'
import type { BlockRow, DatabaseRow, Json, PageRow, UserRow } from './types.ts'
import {
  apiError,
  asObject,
  blockJson,
  botJson,
  cursorOf,
  dataSourceJson,
  databaseJson,
  intOr,
  listTypeOf,
  notFound,
  pageJson,
  pageOf,
  userJson,
} from './wire.ts'

// The kit resolves a tenant from the bearer with a FALLBACK to the default
// one, because an unreadable vendor token has asked for nothing. Notion asks
// for something: a call with no token at all is a 401 in its own words, and
// the fake this replaces answered that. So presence is checked here rather
// than in the kit, where a fallback is the right answer for every other fake.
export function unauthorized(ctx: Ctx<C>): Reply | null {
  const raw = ctx.headers.authorization
  const auth = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  if (auth.startsWith('Bearer ') && auth.slice(7) !== '') return null
  return apiError(401, 'unauthorized', 'API token is invalid.')
}

// Notion answers each request in the shape of the version it carries, and the
// two generations disagree about where a database's column schema lives, so
// the header has to reach the renderer rather than being read once at startup.
export function apiVersion(ctx: Ctx<C>): string {
  const raw = ctx.headers['notion-version']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === '' ? DEFAULT_API_VERSION : value
}

function markdownReply(id: string, lines: string[]): Reply {
  return {
    status: 200,
    body: {
      object: 'page_markdown',
      id,
      markdown: lines.length === 0 ? '' : `${lines.join('\n\n')}\n`,
      truncated: false,
      unknown_block_ids: [],
    },
  }
}

export { markdownReply }

export async function retrievePage(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = first<NotionPage>(
    ctx.sql,
    DMMF,
    'NotionPage',
    '"tenant" = ? AND "id" = ?',
    ctx.tenant,
    id,
  ) as PageRow | null
  if (row === null) return notFound('page', id)
  const body = keepProperties(pageJson(row, apiVersion(ctx)), propertyRefs(ctx))
  return { status: 200, body }
}

// Title, rich text, people and relation answer as a list with one property
// item per element, even for one element, and a rollup as a list whose result
// rides on `property_item`; every other type is one property item (API
// reference, property item object). A list pages 100 at a time unless
// `page_size` asks for fewer, and `next_url` is the same request resumed at the
// next cursor. The fake computes no rollup, so a rollup's list is empty and its
// stored value is the result, where live lists the related rows' items. A
// missing page's wording is the probed one `retrievePage` answers; a missing
// property's is the same sentence, not probed.
const LISTED = new Set(['title', 'rich_text', 'people', 'relation'])

export async function retrievePageProperty(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const ref = ctx.params.property ?? ''
  const row = first<NotionPage>(
    ctx.sql,
    DMMF,
    'NotionPage',
    '"tenant" = ? AND "id" = ?',
    ctx.tenant,
    id,
  ) as PageRow | null
  if (row === null) return notFound('page', id)
  const prop = propByRef({ properties: JSON.parse(row.propertiesJson) as Json }, ref)
  if (prop === undefined) return notFound('property', ref)
  const type = typeof prop.type === 'string' ? prop.type : ''
  const item = (value: JsonValue | undefined): Json => ({
    object: 'property_item',
    id: prop.id ?? null,
    type,
    [type]: value ?? null,
  })
  if (!LISTED.has(type) && type !== 'rollup') return { status: 200, body: item(prop[type]) }
  const value = prop[type]
  const reply = pageOf(
    LISTED.has(type) && Array.isArray(value) ? value.map(item) : [],
    cursorOf(ctx.query.get('start_cursor')),
    intOr(ctx.query.get('page_size'), MAX_PAGE_SIZE),
    'property_item',
    (_item, at) => String(at),
  )
  if (reply.status !== 200) return reply
  const body = reply.body as Json
  let nextUrl: string | null = null
  if (typeof body.next_cursor === 'string') {
    const next = new URL(ctx.url)
    next.pathname = `${ctx.runPrefix}${ctx.url.pathname}`
    next.searchParams.set('start_cursor', body.next_cursor)
    nextUrl = next.href
  }
  body.property_item = {
    id: prop.id ?? null,
    next_url: nextUrl,
    type,
    [type]: type === 'rollup' ? (value ?? null) : {},
  }
  return reply
}

export async function whoami(ctx: Ctx<C>): Promise<Reply> {
  return { status: 200, body: botJson(await metaOf(ctx.sql, ctx.tenant)) }
}

// Every member and bot the integration can see, the integration's own bot
// last, which is where both the MCP-Atlas recording and a live probe
// (2026-09-22) put it.
async function allUsers(ctx: Ctx<C>): Promise<Json[]> {
  const rows = select<NotionUser>(
    ctx.sql,
    DMMF,
    'NotionUser',
    '"tenant" = ? ORDER BY "seq" ASC, "id" ASC',
    ctx.tenant,
  ) as UserRow[]
  return [...rows.map(userJson), botJson(await metaOf(ctx.sql, ctx.tenant))]
}

export async function listUsers(ctx: Ctx<C>): Promise<Reply> {
  const size = intOr(ctx.query.get('page_size'), MAX_PAGE_SIZE)
  return pageOf(await allUsers(ctx), cursorOf(ctx.query.get('start_cursor')), size, 'user')
}

export async function retrieveUser(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const user = (await allUsers(ctx)).find((one) => one.id === id)
  if (user !== undefined) return { status: 200, body: user }
  const meta = await metaOf(ctx.sql, ctx.tenant)
  // Live wording (probed 2026-09-22), which unlike every other 404 names the
  // integration, whose id is its bot user's id.
  return {
    status: 404,
    body: {
      object: 'error',
      status: 404,
      code: 'object_not_found',
      message: `Could not find user with ID: ${id}. Make sure your integration has capabilities to read user information. With those capabilities, only members and guests in the integration's workspace are visible.`,
      additional_data: { integration_id: meta.botId },
    },
  }
}

// `filter_properties` is a repeated query parameter
// (`?filter_properties=a&filter_properties=b`), which is how the API documents
// it and how @notionhq/notion-mcp-server sends an array.
function propertyRefs(ctx: Ctx<C>): string[] {
  return [...ctx.query]
    .filter(([key]) => key === 'filter_properties' || key === 'filter_properties[]')
    .map(([, value]) => value)
}

async function queryRows(ctx: Ctx<C>, databaseId: string, body: Json): Promise<Reply> {
  const refused = filterRefusal(body.filter)
  if (refused !== null) return refused
  const version = apiVersion(ctx)
  const rows = await databaseRows(ctx.sql, ctx.tenant, databaseId, body, version)
  const refs = propertyRefs(ctx)
  const size = intOr(body.page_size, MAX_PAGE_SIZE)
  return pageOf(
    rows.map((row) => keepProperties(row, refs)),
    cursorOf(body.start_cursor),
    size,
    listTypeOf(version),
  )
}

export async function pageMarkdown(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = first<NotionPage>(
    ctx.sql,
    DMMF,
    'NotionPage',
    '"tenant" = ? AND "id" = ?',
    ctx.tenant,
    id,
  )
  if (row === null) return notFound('page', id)
  const lines: string[] = []
  await markdownOf(ctx.sql, ctx.tenant, id, 0, lines)
  return markdownReply(id, lines)
}

export async function retrieveDataSource(ctx: Ctx<C>): Promise<Reply> {
  const wanted = ctx.params.id ?? ''
  const row = await dataSourceOwner(ctx.sql, ctx.tenant, wanted)
  if (row === null) return notFound('data source', wanted)
  return { status: 200, body: dataSourceJson(row) }
}

export async function queryDataSource(ctx: Ctx<C>): Promise<Reply> {
  const wanted = ctx.params.id ?? ''
  const body = asObject(ctx.json())
  const owner = await dataSourceOwner(ctx.sql, ctx.tenant, wanted)
  if (owner === null) return notFound('data source', wanted)
  return queryRows(ctx, owner.id, body)
}

// The fake models no page templates, so a data source lists none, in the
// shape the API reference gives. A cursor is refused as any list refuses one
// it never handed out.
export async function listTemplates(ctx: Ctx<C>): Promise<Reply> {
  const wanted = ctx.params.id ?? ''
  if ((await dataSourceOwner(ctx.sql, ctx.tenant, wanted)) === null) {
    return notFound('data source', wanted)
  }
  const size = intOr(ctx.query.get('page_size'), MAX_PAGE_SIZE)
  const listed = pageOf([], cursorOf(ctx.query.get('start_cursor')), size, 'template')
  if (listed.status !== 200) return listed
  return { status: 200, body: { templates: [], has_more: false, next_cursor: null } }
}

export async function retrieveDatabase(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const row = first<NotionDatabase>(
    ctx.sql,
    DMMF,
    'NotionDatabase',
    '"tenant" = ? AND "id" = ?',
    ctx.tenant,
    id,
  ) as DatabaseRow | null
  if (row === null) return notFound('database', id)
  return { status: 200, body: databaseJson(row, apiVersion(ctx)) }
}

export async function queryDatabase(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const body = asObject(ctx.json())
  const owner = first<NotionDatabase>(
    ctx.sql,
    DMMF,
    'NotionDatabase',
    '"tenant" = ? AND "id" = ?',
    ctx.tenant,
    id,
  )
  if (owner === null) return notFound('database', id)
  return queryRows(ctx, id, body)
}

export async function blockChildren(ctx: Ctx<C>): Promise<Reply> {
  const rows = await childrenOf(ctx.sql, ctx.tenant, ctx.params.id ?? '')
  const size = intOr(ctx.query.get('page_size'), MAX_PAGE_SIZE)
  return pageOf(rows.map(blockJson), cursorOf(ctx.query.get('start_cursor')), size, 'block')
}

// Retrieve one block. The children route existed and this one did not, which
// is a gap only a client that walks *to* a block notices:
// @notionhq/notion-mcp-server reads an inline database by asking for the block
// whose id it is, and got a 404 saying the object did not exist. A database and
// a page both answer, because in Notion the child_database / child_page block
// and the thing it points at share an id; a trashed row still answers with the
// flag set, the way retrieve serves a trashed page and DELETE reports the block
// it just trashed.
export async function retrieveBlock(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const scope = '"tenant" = ? AND "id" = ?'
  const block = first<NotionBlock>(
    ctx.sql,
    DMMF,
    'NotionBlock',
    scope,
    ctx.tenant,
    id,
  ) as BlockRow | null
  if (block !== null) {
    return {
      status: 200,
      body: { ...blockJson(block), archived: block.inTrash, in_trash: block.inTrash },
    }
  }
  const database = first<NotionDatabase>(
    ctx.sql,
    DMMF,
    'NotionDatabase',
    scope,
    ctx.tenant,
    id,
  ) as DatabaseRow | null
  if (database !== null) {
    return {
      status: 200,
      body: {
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
  const page = first<NotionPage>(
    ctx.sql,
    DMMF,
    'NotionPage',
    scope,
    ctx.tenant,
    id,
  ) as PageRow | null
  if (page !== null) {
    const kids = await childrenOf(ctx.sql, ctx.tenant, id)
    return {
      status: 200,
      body: {
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

export async function search(ctx: Ctx<C>): Promise<Reply> {
  const body = asObject(ctx.json())
  const version = apiVersion(ctx)
  const results = await searchResults(ctx.sql, ctx.tenant, body, version)
  const size = intOr(body.page_size, MAX_PAGE_SIZE)
  return pageOf(results, cursorOf(body.start_cursor), size, listTypeOf(version))
}

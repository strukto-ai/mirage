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

import { DATA_SOURCE_VERSION, DEFAULT_API_VERSION, MAX_PAGE_SIZE } from './config.ts'
import type { BlockRow, CommentRow, DatabaseRow, Json, MetaRow, PageRow, UserRow } from './types.ts'
import type { JsonValue, Minter, Reply } from '../kit/typescript/index.ts'

export function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

export function intOr(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

export function cursorOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parentJson(parentType: string, parentId: string | null): Json {
  if (parentType === 'workspace') return { type: 'workspace', workspace: true }
  return { type: parentType, [parentType]: parentId ?? '' }
}

function jsonOrNull(raw: string | null): JsonValue {
  return raw === null ? null : (JSON.parse(raw) as JsonValue)
}

// Every key is always present, unset ones as null, in the order live Notion
// sends them on both API versions (probed 2026-09-22). `is_archived` and
// `is_locked` are newer than the 2025 MCP-Atlas recordings; the fake has
// neither state, so both are false.
export function pageJson(row: PageRow, version: string = DEFAULT_API_VERSION): Json {
  return {
    object: 'page',
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    last_edited_by: { object: 'user', id: row.lastEditedBy },
    cover: jsonOrNull(row.coverJson),
    icon: jsonOrNull(row.iconJson),
    parent: pageParentJson(row.parentType, row.parentId, version),
    in_trash: row.inTrash,
    is_archived: false,
    is_locked: false,
    properties: JSON.parse(row.propertiesJson) as Json,
    url: row.url,
    public_url: null,
    archived: row.inTrash,
  }
}

// Since 2025-09-03 a database holds data sources and the rows live under one
// of them. The fake derives one data source per database with a *distinct*
// deterministic id, so `db -> data source` resolution is really exercised
// rather than collapsing into an identity that would hide an id mix-up.
export function dataSourceIdOf(databaseId: string): string {
  return `d5000000${databaseId.slice(8)}`
}

// A row's parent is its data source, not its database (2025-09-03). The
// database id rides along because Notion kept emitting it through the
// migration; storage still keys rows by database id, which is the same fact
// one derivation away. A 2022-06-28 caller gets `{type: "database_id",
// database_id}` with no data source, which is what every row in the MCP-Atlas
// recordings of live Notion carries at that version.
function pageParentJson(parentType: string, parentId: string | null, version: string): Json {
  if (parentType !== 'database_id' || parentId === null || version < DATA_SOURCE_VERSION) {
    return parentJson(parentType, parentId)
  }
  return {
    type: 'data_source_id',
    data_source_id: dataSourceIdOf(parentId),
    database_id: parentId,
  }
}

export function databaseIdOf(dataSourceId: string, databases: DatabaseRow[]): string | null {
  for (const row of databases) {
    if (dataSourceIdOf(row.id) === dataSourceId) return row.id
  }
  return null
}

export function dataSourceJson(row: DatabaseRow): Json {
  return {
    object: 'data_source',
    id: dataSourceIdOf(row.id),
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    parent: { type: 'database_id', database_id: row.id },
    database_parent: parentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    title: JSON.parse(row.titleJson) as JsonValue[],
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
//
// Keys and their order are the MCP-Atlas recordings' (2022-06-28), and
// `data_sources` takes the slot `properties` held. The fake stores no database
// icon, cover or public link, so those are always null.
export function databaseJson(row: DatabaseRow, version: string = DEFAULT_API_VERSION): Json {
  return {
    object: 'database',
    id: row.id,
    cover: null,
    icon: null,
    created_time: row.createdTime,
    created_by: { object: 'user', id: row.createdBy },
    last_edited_by: { object: 'user', id: row.lastEditedBy },
    last_edited_time: row.lastEditedTime,
    title: JSON.parse(row.titleJson) as JsonValue[],
    description: row.descriptionJson === null ? [] : (JSON.parse(row.descriptionJson) as JsonValue),
    is_inline: row.isInline,
    ...(version < DATA_SOURCE_VERSION
      ? { properties: JSON.parse(row.propertiesJson) as Json }
      : { data_sources: [{ id: dataSourceIdOf(row.id), name: row.titleText }] }),
    parent: parentJson(row.parentType, row.parentId),
    url: row.url,
    public_url: null,
    archived: row.inTrash,
    in_trash: row.inTrash,
  }
}

// A person or a bot. The integration's own bot is rendered from the meta row by
// `botJson`, so the list and `/v1/users/me` are one object.
export function userJson(row: UserRow): Json {
  return {
    object: 'user',
    id: row.id,
    name: row.name,
    avatar_url: row.avatarUrl,
    type: row.type,
    [row.type]: JSON.parse(row.detailJson) as Json,
  }
}

export function botJson(meta: MetaRow): Json {
  return {
    object: 'user',
    id: meta.botId,
    name: meta.botName,
    avatar_url: null,
    type: 'bot',
    bot: {
      owner: { type: 'workspace', workspace: true },
      workspace_name: meta.workspaceName,
      workspace_id: meta.workspaceId,
      workspace_limits: { max_file_upload_size_in_bytes: meta.maxUploadSize },
    },
  }
}

// Key order is load-bearing: mirage embeds the block verbatim in page.json, so
// the golden pins {object, id, type, has_children, <type>} exactly.
export function blockJson(row: BlockRow): Json {
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

export function commentJson(row: CommentRow): Json {
  return {
    object: 'comment',
    id: row.id,
    parent: parentJson(row.parentType, row.parentId),
    discussion_id: row.discussionId,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    rich_text: JSON.parse(row.richTextJson) as JsonValue[],
  }
}

// What a list holds, which live Notion names in every list envelope next to an
// empty object of the same name. Search and a query changed theirs when
// databases split into data sources.
export function listTypeOf(version: string): string {
  return version < DATA_SOURCE_VERSION ? 'page_or_database' : 'page_or_data_source'
}

export function listJson(results: Json[], nextCursor: string | null, type: string): Json {
  return {
    object: 'list',
    results,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    type,
    [type]: {},
  }
}

// A cursor is the id of the first item on the page it opens, which is what live
// Notion hands out (a row, a block, a user) and what a client resumes from, so
// an offset could not resume a cursor a live recording carries. One Notion does
// not recognize is refused in its own words (probed 2026-09-22 on users, block
// children and search), never read as the first page.
export function pageOf(
  items: Json[],
  startCursor: string | null,
  pageSize: number,
  type: string,
): Reply {
  const start = startCursor === null ? 0 : items.findIndex((item) => item.id === startCursor)
  if (start === -1) {
    return apiError(
      400,
      'validation_error',
      `The start_cursor provided is invalid: ${String(startCursor)}`,
    )
  }
  const size = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)
  const next = items[start + size]
  const body = listJson(
    items.slice(start, start + size),
    next === undefined ? null : String(next.id),
    type,
  )
  return { status: 200, body }
}

export function apiError(status: number, code: string, message: string): Reply {
  return { status, body: { object: 'error', status, code, message } }
}

export function notFound(kind: string, id: string): Reply {
  return apiError(
    404,
    'object_not_found',
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  )
}

// Created ids are a per-workspace counter rather than a random uuid so the
// battery can pin them in a golden; the leading group says what was minted.
// The kit's Minter is configured `global`, which is the same single counter
// the fake this replaces kept per workspace: creating a page advances the
// number the next block would get.
export function idAt(prefix: string, seq: number): string {
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

export function mintId(minter: Minter, prefix: string): string {
  return idAt(prefix, minter.next(prefix))
}

export function defaultUrl(meta: MetaRow, id: string): string {
  return `${meta.urlBase}${id.replaceAll('-', '')}`
}

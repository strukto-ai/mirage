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

import type { JsonObject } from '../../types.ts'
import { asObject } from '../../utils/records.ts'
import { cursorItems, cursorPages } from '../api/paginate.ts'
import { NotionAPIError, type NotionTransport } from './client.ts'
import { MAX_PAGE_SIZE } from './constants.ts'

/** Refuse a list response Notion marked incomplete. */
function completePage(page: JsonObject): JsonObject {
  const status = asObject(page.request_status)
  if (status.type === 'incomplete') {
    const reason =
      typeof status.incomplete_reason === 'string' ? status.incomplete_reason : 'unknown'
    throw new NotionAPIError(`Notion query incomplete: ${reason}`, null, reason)
  }
  return page
}

async function paginateTool(
  transport: NotionTransport,
  toolName: string,
  baseArgs: Record<string, unknown>,
  maxResults?: number,
): Promise<JsonObject[]> {
  const items = await cursorItems(
    async (cursor) =>
      completePage(
        await transport.callTool(
          toolName,
          cursor === null ? { ...baseArgs } : { ...baseArgs, start_cursor: cursor },
        ),
      ),
    maxResults,
  )
  return items.map(asObject)
}

export async function searchDataSources(transport: NotionTransport): Promise<JsonObject[]> {
  const baseArgs = { filter: { value: 'data_source', property: 'object' }, page_size: 100 }
  return paginateTool(transport, 'API-post-search', baseArgs)
}

export async function getDatabase(
  transport: NotionTransport,
  databaseId: string,
): Promise<JsonObject> {
  return transport.callTool('API-retrieve-a-database', { database_id: databaseId })
}

export async function getDataSource(
  transport: NotionTransport,
  dataSourceId: string,
): Promise<JsonObject> {
  return transport.callTool('API-retrieve-a-data-source', { data_source_id: dataSourceId })
}

/**
 * Yield query pages only as the caller requests them. Each page is checked
 * for an incomplete response before yielding its rows. Closing the iterator
 * prevents further requests; the shared cursor walker retains its
 * repeated-cursor and terminal-page rules. Query options are never mutated.
 */
export async function* queryDataSourcePages(
  transport: NotionTransport,
  dataSourceId: string,
  body: JsonObject = {},
): AsyncGenerator<JsonObject[], void> {
  const baseArgs = { ...body, page_size: MAX_PAGE_SIZE }
  for await (const page of cursorPages((cursor) =>
    queryDataSourcePage(
      transport,
      dataSourceId,
      cursor === null ? { ...baseArgs } : { ...baseArgs, start_cursor: cursor },
    ),
  )) {
    yield page.map(asObject)
  }
}

export async function getPage(transport: NotionTransport, pageId: string): Promise<JsonObject> {
  return transport.callTool('API-retrieve-a-page', { page_id: pageId })
}

export async function getSelf(transport: NotionTransport): Promise<JsonObject> {
  return transport.callTool('API-get-self', {})
}

export async function getPageMarkdown(
  transport: NotionTransport,
  pageId: string,
): Promise<JsonObject> {
  return transport.callTool('API-retrieve-page-markdown', { page_id: pageId })
}

export async function replacePageMarkdown(
  transport: NotionTransport,
  pageId: string,
  markdown: string,
): Promise<JsonObject> {
  return transport.callTool('API-patch-page-markdown', {
    page_id: pageId,
    type: 'replace_content',
    replace_content: { new_str: markdown },
  })
}

// `ntn datasources query` is explicitly one page at a time: it honors
// --limit, reports has_more and hands the caller the cursor, so it cannot
// use the paginating helper the mount uses. An incomplete page still
// refuses, so a truncated result never prints as a successful query.
export async function queryDataSourcePage(
  transport: NotionTransport,
  dataSourceId: string,
  body: JsonObject,
): Promise<JsonObject> {
  return completePage(
    await transport.callTool('API-post-data-source-query', {
      ...body,
      data_source_id: dataSourceId,
    }),
  )
}

export async function listBlockChildren(
  transport: NotionTransport,
  blockId: string,
): Promise<JsonObject[]> {
  return paginateTool(transport, 'API-retrieve-block-children', {
    block_id: blockId,
    page_size: 100,
  })
}

const MAX_BLOCK_DEPTH = 10

export async function listBlockTree(
  transport: NotionTransport,
  blockId: string,
  depth = 0,
): Promise<JsonObject[]> {
  const blocks = await listBlockChildren(transport, blockId)
  if (depth >= MAX_BLOCK_DEPTH) return blocks
  for (const block of blocks) {
    const btype = block.type
    if (btype === 'child_page' || btype === 'child_database') continue
    if (block.has_children === true && typeof block.id === 'string') {
      block.children = await listBlockTree(transport, block.id, depth + 1)
    }
  }
  return blocks
}

export interface ChildPageRef {
  id: string
  title: string
  lastEditedTime: string
}

export async function getChildPages(
  transport: NotionTransport,
  parentBlockId: string,
): Promise<ChildPageRef[]> {
  const blocks = await listBlockChildren(transport, parentBlockId)
  const refs: ChildPageRef[] = []
  for (const block of blocks) {
    if (block.type !== 'child_page') continue
    const id = block.id
    if (typeof id !== 'string') continue
    const childPage = asObject(block.child_page)
    const title = childPage.title
    const lastEditedTime = block.last_edited_time
    refs.push({
      id,
      title: typeof title === 'string' ? title : 'untitled',
      lastEditedTime: typeof lastEditedTime === 'string' ? lastEditedTime : '',
    })
  }
  return refs
}

export async function searchPages(
  transport: NotionTransport,
  query = '',
  pageSize = 100,
  maxResults?: number,
): Promise<JsonObject[]> {
  const baseArgs: JsonObject = {
    filter: { value: 'page', property: 'object' },
    page_size: Math.min(pageSize, MAX_PAGE_SIZE),
  }
  if (query !== '') baseArgs.query = query
  return paginateTool(transport, 'API-post-search', baseArgs, maxResults)
}

export interface CreatePageInput {
  parent: { type: 'workspace' } | { type: 'page_id'; page_id: string }
  title: string
}

export async function createPage(
  transport: NotionTransport,
  input: CreatePageInput,
): Promise<JsonObject> {
  const parentBody: JsonObject =
    input.parent.type === 'workspace'
      ? { type: 'workspace', workspace: true }
      : { type: 'page_id', page_id: input.parent.page_id }
  const body: JsonObject = {
    parent: parentBody,
    properties: {
      title: { title: [{ type: 'text', text: { content: input.title } }] },
    },
  }
  return transport.callTool('API-post-page', body)
}

export async function createPageRaw(
  transport: NotionTransport,
  body: JsonObject,
): Promise<JsonObject> {
  return transport.callTool('API-post-page', body)
}

export async function updatePage(
  transport: NotionTransport,
  pageId: string,
  body: JsonObject,
): Promise<JsonObject> {
  return transport.callTool('API-patch-page', { ...body, page_id: pageId })
}

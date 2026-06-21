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

import type { NotionTransport } from './_client.ts'

type Json = Record<string, unknown>

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

async function paginateTool(
  transport: NotionTransport,
  toolName: string,
  baseArgs: Record<string, unknown>,
): Promise<Json[]> {
  const collected: Json[] = []
  let cursor: string | null = null
  for (;;) {
    const args: Record<string, unknown> =
      cursor === null ? { ...baseArgs } : { ...baseArgs, start_cursor: cursor }
    const response = await transport.callTool(toolName, args)
    const results = asArray(response.results)
    for (const item of results) {
      collected.push(asObject(item))
    }
    const hasMore = response.has_more === true
    const next = response.next_cursor
    if (!hasMore || typeof next !== 'string' || next === '') {
      return collected
    }
    cursor = next
  }
}

export async function searchTopLevelPages(transport: NotionTransport): Promise<Json[]> {
  const baseArgs = { filter: { value: 'page', property: 'object' }, page_size: 100 }
  const all = await paginateTool(transport, 'API-post-search', baseArgs)
  const filtered: Json[] = []
  for (const page of all) {
    const parent = asObject(page.parent)
    if (parent.type === 'workspace') filtered.push(page)
  }
  return filtered
}

export async function getPage(transport: NotionTransport, pageId: string): Promise<Json> {
  return transport.callTool('API-retrieve-a-page', { page_id: pageId })
}

export async function getChildBlocks(transport: NotionTransport, blockId: string): Promise<Json[]> {
  return paginateTool(transport, 'API-retrieve-block-children', {
    block_id: blockId,
    page_size: 100,
  })
}

const MAX_BLOCK_DEPTH = 10

export async function getBlockTree(
  transport: NotionTransport,
  blockId: string,
  depth = 0,
): Promise<Json[]> {
  const blocks = await getChildBlocks(transport, blockId)
  if (depth >= MAX_BLOCK_DEPTH) return blocks
  for (const block of blocks) {
    const btype = block.type
    if (btype === 'child_page' || btype === 'child_database') continue
    if (block.has_children === true && typeof block.id === 'string') {
      block.children = await getBlockTree(transport, block.id, depth + 1)
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
  const blocks = await getChildBlocks(transport, parentBlockId)
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
  query: string,
  pageSize: number,
): Promise<Json[]> {
  const baseArgs: Json = {
    filter: { value: 'page', property: 'object' },
    page_size: pageSize,
  }
  if (query !== '') baseArgs.query = query
  return paginateTool(transport, 'API-post-search', baseArgs)
}

export async function appendBlocks(
  transport: NotionTransport,
  blockId: string,
  body: Json,
): Promise<Json> {
  return transport.callTool('API-patch-block-children', { ...body, block_id: blockId })
}

export async function createComment(transport: NotionTransport, body: Json): Promise<Json> {
  return transport.callTool('API-create-a-comment', body)
}

export interface CreatePageInput {
  parent: { type: 'workspace' } | { type: 'page_id'; page_id: string }
  title: string
}

export async function createPage(
  transport: NotionTransport,
  input: CreatePageInput,
): Promise<Json> {
  const parentBody: Json =
    input.parent.type === 'workspace'
      ? { type: 'workspace', workspace: true }
      : { type: 'page_id', page_id: input.parent.page_id }
  const body: Json = {
    parent: parentBody,
    properties: {
      title: { title: [{ type: 'text', text: { content: input.title } }] },
    },
  }
  return transport.callTool('API-post-page', body)
}

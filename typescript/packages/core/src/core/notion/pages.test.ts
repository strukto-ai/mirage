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

import { describe, expect, it } from 'vitest'
import type { NotionTransport } from './_client.ts'
import {
  appendBlocks,
  createComment,
  createPage,
  getChildBlocks,
  getChildPages,
  getPage,
  searchPages,
  searchTopLevelPages,
} from './pages.ts'

class FakeTransport implements NotionTransport {
  invocations: { name: string; args: Record<string, unknown> }[] = []
  responses: unknown[] = []
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.invocations.push({ name, args })
    if (this.responses.length === 0) return Promise.reject(new Error('no canned response'))
    return Promise.resolve(this.responses.shift() as Record<string, unknown>)
  }
}

describe('searchTopLevelPages', () => {
  it('invokes API-post-search with the right filter args and keeps workspace-rooted pages', async () => {
    const transport = new FakeTransport()
    transport.responses.push({
      results: [
        { id: 'page-1', parent: { type: 'workspace', workspace: true } },
        { id: 'page-2', parent: { type: 'page_id', page_id: 'other' } },
        { id: 'page-3', parent: { type: 'workspace', workspace: true } },
      ],
      has_more: false,
      next_cursor: null,
    })
    const pages = await searchTopLevelPages(transport)
    expect(transport.invocations).toEqual([
      {
        name: 'API-post-search',
        args: { filter: { value: 'page', property: 'object' }, page_size: 100 },
      },
    ])
    expect(pages).toEqual([
      { id: 'page-1', parent: { type: 'workspace', workspace: true } },
      { id: 'page-3', parent: { type: 'workspace', workspace: true } },
    ])
  })

  it('paginates when has_more is true with a next_cursor', async () => {
    const transport = new FakeTransport()
    transport.responses.push({
      results: [{ id: 'p1', parent: { type: 'workspace', workspace: true } }],
      has_more: true,
      next_cursor: 'cursor-a',
    })
    transport.responses.push({
      results: [{ id: 'p2', parent: { type: 'workspace', workspace: true } }],
      has_more: false,
      next_cursor: null,
    })
    const pages = await searchTopLevelPages(transport)
    expect(transport.invocations).toHaveLength(2)
    expect(transport.invocations[0]?.args).toEqual({
      filter: { value: 'page', property: 'object' },
      page_size: 100,
    })
    expect(transport.invocations[1]?.args).toEqual({
      filter: { value: 'page', property: 'object' },
      page_size: 100,
      start_cursor: 'cursor-a',
    })
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2'])
  })
})

describe('getPage', () => {
  it('invokes API-retrieve-a-page with the page id and returns the result', async () => {
    const transport = new FakeTransport()
    const page = { id: 'abc', object: 'page' }
    transport.responses.push(page)
    const result = await getPage(transport, 'abc')
    expect(transport.invocations).toEqual([
      { name: 'API-retrieve-a-page', args: { page_id: 'abc' } },
    ])
    expect(result).toEqual(page)
  })
})

describe('getChildBlocks', () => {
  it('paginates API-retrieve-block-children using start_cursor', async () => {
    const transport = new FakeTransport()
    transport.responses.push({
      results: [{ id: 'b1', type: 'paragraph' }],
      has_more: true,
      next_cursor: 'cursor-x',
    })
    transport.responses.push({
      results: [{ id: 'b2', type: 'paragraph' }],
      has_more: false,
      next_cursor: null,
    })
    const blocks = await getChildBlocks(transport, 'block-root')
    expect(transport.invocations).toHaveLength(2)
    expect(transport.invocations[0]).toEqual({
      name: 'API-retrieve-block-children',
      args: { block_id: 'block-root', page_size: 100 },
    })
    expect(transport.invocations[1]).toEqual({
      name: 'API-retrieve-block-children',
      args: { block_id: 'block-root', page_size: 100, start_cursor: 'cursor-x' },
    })
    expect(blocks.map((b) => b.id)).toEqual(['b1', 'b2'])
  })
})

describe('getChildPages', () => {
  it('filters child_page blocks and returns raw ids and titles', async () => {
    const transport = new FakeTransport()
    transport.responses.push({
      results: [
        {
          id: 'aaaa1111-2222-3333-4444-555566667777',
          type: 'child_page',
          last_edited_time: '2024-01-03T00:00:00Z',
          child_page: { title: 'First' },
        },
        { id: 'block-paragraph', type: 'paragraph' },
        {
          id: 'bbbb1111-2222-3333-4444-555566667777',
          type: 'child_page',
          child_page: { title: 'Second' },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const pages = await getChildPages(transport, 'parent-block')
    expect(pages).toEqual([
      {
        id: 'aaaa1111-2222-3333-4444-555566667777',
        title: 'First',
        lastEditedTime: '2024-01-03T00:00:00Z',
      },
      { id: 'bbbb1111-2222-3333-4444-555566667777', title: 'Second', lastEditedTime: '' },
    ])
  })
})

describe('createPage', () => {
  it('sends workspace parent body to API-post-page', async () => {
    const transport = new FakeTransport()
    const created = { id: 'new-page-id', object: 'page' }
    transport.responses.push(created)
    const result = await createPage(transport, { parent: { type: 'workspace' }, title: 'New Page' })
    expect(transport.invocations).toEqual([
      {
        name: 'API-post-page',
        args: {
          parent: { type: 'workspace', workspace: true },
          properties: {
            title: { title: [{ type: 'text', text: { content: 'New Page' } }] },
          },
        },
      },
    ])
    expect(result).toEqual(created)
  })

  it('sends page_id parent body to API-post-page', async () => {
    const transport = new FakeTransport()
    const created = { id: 'child-page-id', object: 'page' }
    transport.responses.push(created)
    const result = await createPage(transport, {
      parent: { type: 'page_id', page_id: 'parent-id' },
      title: 'Child Page',
    })
    expect(transport.invocations).toEqual([
      {
        name: 'API-post-page',
        args: {
          parent: { type: 'page_id', page_id: 'parent-id' },
          properties: {
            title: { title: [{ type: 'text', text: { content: 'Child Page' } }] },
          },
        },
      },
    ])
    expect(result).toEqual(created)
  })
})

describe('searchPages', () => {
  it('invokes API-post-search with query, filter, and page_size, paginating to the end', async () => {
    const transport = new FakeTransport()
    transport.responses.push({
      results: [{ id: 'p1' }],
      has_more: true,
      next_cursor: 'cursor-a',
    })
    transport.responses.push({ results: [{ id: 'p2' }], has_more: false, next_cursor: null })
    const pages = await searchPages(transport, 'Roadmap', 20)
    expect(transport.invocations[0]).toEqual({
      name: 'API-post-search',
      args: {
        filter: { value: 'page', property: 'object' },
        page_size: 20,
        query: 'Roadmap',
      },
    })
    expect(transport.invocations[1]?.args.start_cursor).toBe('cursor-a')
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('omits the query arg when the query is empty', async () => {
    const transport = new FakeTransport()
    transport.responses.push({ results: [], has_more: false })
    await searchPages(transport, '', 100)
    expect(transport.invocations[0]?.args).toEqual({
      filter: { value: 'page', property: 'object' },
      page_size: 100,
    })
  })
})

describe('appendBlocks', () => {
  it('invokes API-patch-block-children with the block id merged into the body', async () => {
    const transport = new FakeTransport()
    const response = { results: [{ id: 'b1' }] }
    transport.responses.push(response)
    const children = [{ type: 'paragraph', paragraph: { rich_text: [] } }]
    const result = await appendBlocks(transport, 'block-1', { children })
    expect(transport.invocations).toEqual([
      { name: 'API-patch-block-children', args: { block_id: 'block-1', children } },
    ])
    expect(result).toEqual(response)
  })
})

describe('createComment', () => {
  it('invokes API-create-a-comment with the body and returns the comment', async () => {
    const transport = new FakeTransport()
    const comment = { id: 'c1', object: 'comment' }
    transport.responses.push(comment)
    const body = { parent: { page_id: 'p1' }, rich_text: [{ text: { content: 'hi' } }] }
    const result = await createComment(transport, body)
    expect(transport.invocations).toEqual([{ name: 'API-create-a-comment', args: body }])
    expect(result).toEqual(comment)
  })
})

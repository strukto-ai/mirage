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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { read, type NotionReadAccessor } from './read.ts'

class FakeTransport implements NotionTransport {
  public readonly invocations: { name: string; args: Record<string, unknown> }[] = []
  private readonly responses = new Map<string, Record<string, unknown>[]>()

  enqueue(toolName: string, response: Record<string, unknown>): void {
    const list = this.responses.get(toolName)
    if (list === undefined) {
      this.responses.set(toolName, [response])
    } else {
      list.push(response)
    }
  }

  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.invocations.push({ name, args })
    const list = this.responses.get(name) ?? []
    if (list.length === 0) return Promise.reject(new Error(`no canned response for ${name}`))
    const response = list.shift()
    if (response === undefined) return Promise.reject(new Error(`no canned response for ${name}`))
    return Promise.resolve(response)
  }
}

function makeAccessor(transport: NotionTransport): NotionReadAccessor {
  return { transport }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

const PAGE_ID_DASHED = 'aaaa1111-2222-3333-4444-555566667777'
const CHILD_ID_DASHED = 'cccc1111-2222-3333-4444-555566667777'

function pageBody(id: string, title: string): Record<string, unknown> {
  return {
    id,
    object: 'page',
    url: 'https://notion.so/Some-Page',
    created_time: '2024-01-01T00:00:00Z',
    last_edited_time: '2024-01-02T00:00:00Z',
    archived: false,
    parent: { type: 'workspace', workspace: true },
    properties: {
      title: { type: 'title', title: [{ plain_text: title }] },
    },
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('notion read', () => {
  it('returns JSON bytes containing normalized database metadata and schema, not rows', async () => {
    const transport = new FakeTransport()
    const dbIdDashed = 'bbbb1111-2222-3333-4444-555566667777'
    const dbId = 'bbbb1111222233334444555566667777'
    transport.enqueue('API-retrieve-a-database', {
      id: dbIdDashed,
      object: 'database',
      title: [{ plain_text: 'Tasks' }],
      properties: { Name: { type: 'title' } },
      last_edited_time: '2024-02-03T00:00:00Z',
    })
    const path = `/databases/Tasks__${dbId}/database.json`
    const bytes = await read(makeAccessor(transport), spec(path), undefined)
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.database_id).toBe(dbIdDashed)
    expect(decoded.title).toBe('Tasks')
    expect(decoded.properties).toEqual({ Name: { type: 'title' } })
    expect(decoded.is_inline).toBe(false)
    expect(decoded.rows).toBeUndefined()
    expect(decoded.row_count).toBeUndefined()
    expect(transport.invocations).toEqual([
      { name: 'API-retrieve-a-database', args: { database_id: dbId } },
    ])
  })

  it('returns JSON bytes containing the normalized page and its blocks', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', pageBody(PAGE_ID_DASHED, 'My Page'))
    transport.enqueue('API-retrieve-block-children', {
      results: [
        { id: 'block-1', type: 'paragraph' },
        {
          id: CHILD_ID_DASHED,
          type: 'child_page',
          child_page: { title: 'Child' },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const path = `/pages/My_Page__${PAGE_ID_DASHED}/page.json`
    const bytes = await read(makeAccessor(transport), spec(path), undefined)
    expect(bytes).toBeInstanceOf(Uint8Array)
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.page_id).toBe(PAGE_ID_DASHED)
    expect(decoded.title).toBe('My Page')
    expect(decoded.last_edited_time).toBe('2024-01-02T00:00:00Z')
    expect(decoded.created_time).toBe('2024-01-01T00:00:00Z')
    expect(decoded.archived).toBe(false)
    expect(decoded.parent_type).toBe('workspace')
    expect(decoded.parent_id).toBe('')
    expect(typeof decoded.markdown).toBe('string')
    expect(Array.isArray(decoded.blocks)).toBe(true)
    const blocks = decoded.blocks as { id: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.id).toBe('block-1')
    const calls = transport.invocations
    expect(calls).toHaveLength(2)
    const pageCall = calls.find((c) => c.name === 'API-retrieve-a-page')
    expect(pageCall?.args).toEqual({ page_id: PAGE_ID_DASHED })
    const blockCall = calls.find((c) => c.name === 'API-retrieve-block-children')
    expect(blockCall?.args).toEqual({ block_id: PAGE_ID_DASHED, page_size: 100 })
  })

  it('honors a path prefix', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', pageBody(PAGE_ID_DASHED, 'Prefixed'))
    transport.enqueue('API-retrieve-block-children', {
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const virtual = `/notion/pages/Prefixed__${PAGE_ID_DASHED}/page.json`
    const bytes = await read(
      makeAccessor(transport),
      new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, '/notion') }),
      undefined,
    )
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.page_id).toBe(PAGE_ID_DASHED)
    expect(decoded.title).toBe('Prefixed')
    expect(decoded.blocks).toEqual([])
  })

  it('throws ENOENT when the path does not end in page.json', async () => {
    const transport = new FakeTransport()
    const cases = [
      `/pages/My_Page__${PAGE_ID_DASHED}/`,
      `/pages/My_Page__${PAGE_ID_DASHED}/foo.txt`,
      `/pages/My_Page__${PAGE_ID_DASHED}/SubPage__${CHILD_ID_DASHED}/`,
    ]
    for (const original of cases) {
      let captured: unknown = null
      try {
        await read(makeAccessor(transport), spec(original), undefined)
      } catch (err) {
        captured = err
      }
      expect(captured).toBeInstanceOf(Error)
      expect((captured as { code?: string }).code).toBe('ENOENT')
    }
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT when reading /page.json with no parent segment', async () => {
    const transport = new FakeTransport()
    let captured: unknown = null
    try {
      await read(makeAccessor(transport), spec('/page.json'), undefined)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT when the parent segment is not a valid notion segment', async () => {
    const transport = new FakeTransport()
    let captured: unknown = null
    try {
      await read(makeAccessor(transport), spec('/pages/no-id/page.json'), undefined)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })
})

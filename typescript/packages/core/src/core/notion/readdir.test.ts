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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { readdir, type NotionReaddirAccessor } from './readdir.ts'

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

function makeAccessor(transport: NotionTransport): NotionReaddirAccessor {
  return { transport }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

const TOP1_ID = 'aaaa1111-2222-3333-4444-555566667777'
const TOP2_ID = 'bbbb2222-3333-4444-5555-666677778888'
const CHILD1_ID = 'cccc1111-2222-3333-4444-555566667777'
const CHILD2_ID = 'dddd2222-3333-4444-5555-666677778888'
const DB_ID = 'ffff1111-2222-3333-4444-555566667777'

function topPage(id: string, title: string): Record<string, unknown> {
  return {
    id,
    object: 'page',
    parent: { type: 'workspace', workspace: true },
    last_edited_time: '2024-01-02T00:00:00Z',
    properties: {
      title: { type: 'title', title: [{ plain_text: title }] },
    },
  }
}

describe('notion readdir root', () => {
  it('lists the pages and databases virtual roots without any API call', async () => {
    const transport = new FakeTransport()
    const out = await readdir(makeAccessor(transport), spec('/'), undefined)
    expect(out).toEqual(['/pages', '/databases'])
    expect(transport.invocations).toHaveLength(0)
  })

  it('honors prefix for the virtual root', async () => {
    const transport = new FakeTransport()
    const out = await readdir(
      makeAccessor(transport),
      new PathSpec({
        virtual: '/notion',
        directory: '/notion',
        resourcePath: mountKey('/notion', '/notion'),
      }),
      undefined,
    )
    expect(out).toEqual(['/notion/pages', '/notion/databases'])
  })

  it('returns an empty list for an unknown top-level dir', async () => {
    const transport = new FakeTransport()
    const out = await readdir(makeAccessor(transport), spec('/no-id-here/'), undefined)
    expect(out).toEqual([])
    expect(transport.invocations).toHaveLength(0)
  })
})

describe('notion readdir pages', () => {
  it('lists top-level pages with workspace parents under /pages', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [
        topPage(TOP1_ID, 'Top1'),
        topPage(TOP2_ID, 'Top2'),
        {
          id: 'eeee3333-4444-5555-6666-777788889999',
          object: 'page',
          parent: { type: 'page_id', page_id: 'other' },
          properties: { title: { type: 'title', title: [{ plain_text: 'NestedNotShown' }] } },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const out = await readdir(makeAccessor(transport), spec('/pages'), undefined)
    expect(out).toEqual([`/pages/Top1__${TOP1_ID}`, `/pages/Top2__${TOP2_ID}`])
  })

  it('honors prefix when listing pages', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [topPage(TOP1_ID, 'Top1'), topPage(TOP2_ID, 'Top2')],
      has_more: false,
      next_cursor: null,
    })
    const out = await readdir(
      makeAccessor(transport),
      new PathSpec({
        virtual: '/notion/pages',
        directory: '/notion/pages',
        resourcePath: mountKey('/notion/pages', '/notion'),
      }),
      undefined,
    )
    expect(out).toEqual([`/notion/pages/Top1__${TOP1_ID}`, `/notion/pages/Top2__${TOP2_ID}`])
  })

  it('returns prefixed entries from the index cache when present', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [topPage(TOP1_ID, 'Top1')],
      has_more: false,
      next_cursor: null,
    })
    const idx = new RAMIndexCacheStore()
    await readdir(makeAccessor(transport), spec('/pages'), idx)
    expect(transport.invocations).toHaveLength(1)
    const out = await readdir(makeAccessor(transport), spec('/pages'), idx)
    expect([...out].sort()).toEqual([`/pages/Top1__${TOP1_ID}`])
    expect(transport.invocations).toHaveLength(1)
  })

  it('keeps the mount prefix on warm index-cache hits', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [topPage(TOP1_ID, 'Top1')],
      has_more: false,
      next_cursor: null,
    })
    const idx = new RAMIndexCacheStore()
    const p = spec('/notion/pages', '/notion')
    const cold = await readdir(makeAccessor(transport), p, idx)
    const warm = await readdir(makeAccessor(transport), p, idx)
    expect(warm).toEqual(cold)
    expect(warm).toEqual([`/notion/pages/Top1__${TOP1_ID}`])
    expect(transport.invocations).toHaveLength(1)
  })
})

describe('notion readdir databases', () => {
  it('lists databases under the /databases virtual root', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [
        {
          id: DB_ID,
          object: 'database',
          title: [{ plain_text: 'Tasks' }],
          last_edited_time: '2024-02-03T00:00:00Z',
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const out = await readdir(makeAccessor(transport), spec('/databases'), undefined)
    expect(out).toEqual([`/databases/Tasks__${DB_ID}`])
    expect(transport.invocations[0]?.args).toEqual({
      filter: { value: 'database', property: 'object' },
      page_size: 100,
    })
  })

  it('lists database row pages under a database directory', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-database-query', {
      results: [topPage(TOP1_ID, 'Row A'), { id: 'x', object: 'database' }],
      has_more: false,
      next_cursor: null,
    })
    const dirPath = `/databases/Tasks__${DB_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath), undefined)
    expect(out).toEqual([`${dirPath}/database.json`, `${dirPath}/Row_A__${TOP1_ID}`])
    expect(transport.invocations[0]?.args).toEqual({ database_id: DB_ID, page_size: 100 })
  })
})

describe('notion readdir subtree', () => {
  it('lists page.json first followed by child pages, ignoring non-page blocks', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-block-children', {
      results: [
        {
          id: CHILD1_ID,
          type: 'child_page',
          child_page: { title: 'ChildA' },
        },
        { id: 'block-x', type: 'paragraph' },
        {
          id: CHILD2_ID,
          type: 'child_page',
          child_page: { title: 'ChildB' },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const dirPath = `/pages/Top1__${TOP1_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath), undefined)
    expect(out).toEqual([
      `${dirPath}/page.json`,
      `${dirPath}/ChildA__${CHILD1_ID}`,
      `${dirPath}/ChildB__${CHILD2_ID}`,
    ])
    expect(transport.invocations).toHaveLength(1)
    expect(transport.invocations[0]?.args).toEqual({
      block_id: TOP1_ID,
      page_size: 100,
    })
  })

  it('uses the index cache on the second call without invoking the transport', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-block-children', {
      results: [{ id: CHILD1_ID, type: 'child_page', child_page: { title: 'ChildA' } }],
      has_more: false,
      next_cursor: null,
    })
    const idx = new RAMIndexCacheStore()
    const dirPath = `/pages/Top1__${TOP1_ID}`
    const first = await readdir(makeAccessor(transport), spec(dirPath), idx)
    expect(first).toEqual([`${dirPath}/page.json`, `${dirPath}/ChildA__${CHILD1_ID}`])
    expect(transport.invocations).toHaveLength(1)
    const second = await readdir(makeAccessor(transport), spec(dirPath), idx)
    expect(transport.invocations).toHaveLength(1)
    expect([...second].sort()).toEqual([...first].sort())
  })

  it('throws ENOENT when the last segment is not a valid notion segment', async () => {
    const transport = new FakeTransport()
    let captured: unknown = null
    try {
      await readdir(makeAccessor(transport), spec('/pages/no-id-here/'), undefined)
    } catch (err) {
      captured = err
    }
    expect(captured).not.toBeNull()
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })

  it('honors prefix when listing a subtree', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-block-children', {
      results: [{ id: CHILD1_ID, type: 'child_page', child_page: { title: 'ChildA' } }],
      has_more: false,
      next_cursor: null,
    })
    const dirPath = `/notion/pages/Top1__${TOP1_ID}`
    const out = await readdir(
      makeAccessor(transport),
      new PathSpec({
        virtual: dirPath,
        directory: dirPath,
        resourcePath: mountKey(dirPath, '/notion'),
      }),
      undefined,
    )
    expect(out).toEqual([`${dirPath}/page.json`, `${dirPath}/ChildA__${CHILD1_ID}`])
  })
})

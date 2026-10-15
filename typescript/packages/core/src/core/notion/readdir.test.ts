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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { NotionTransport } from './client.ts'
import { normalizeDatabase, toJsonBytes } from './normalize.ts'
import type { NotionAccessor } from '../../accessor/notion.ts'
import { readdir as rawOperation } from './readdir.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { NotionVFSBase } from '../../vfs/notion/notion.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { formatSegment } from './pathing.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

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

function makeAccessor(transport: NotionTransport): NotionAccessor {
  return { transport }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
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
    const out = await readdir(makeAccessor(transport), spec('/'))
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
        vfsPath: mountKey('/notion', '/notion'),
      }),
    )
    expect(out).toEqual(['/notion/pages', '/notion/databases'])
  })

  it('throws ENOENT for an unknown top-level dir', async () => {
    // Returning [] made `ls` and `tree` report a bogus path as
    // real-but-empty, and left `rg` without a message.
    const transport = new FakeTransport()
    await expect(readdir(makeAccessor(transport), spec('/no-id-here/'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
    const out = await readdir(makeAccessor(transport), spec('/pages'))
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
        vfsPath: mountKey('/notion/pages', '/notion'),
      }),
    )
    expect(out).toEqual([`/notion/pages/Top1__${TOP1_ID}`, `/notion/pages/Top2__${TOP2_ID}`])
  })
})

const DS_ID = 'cccc1111222233334444555566667777'

function database(): Record<string, unknown> {
  return {
    id: DB_ID,
    object: 'database',
    title: [{ plain_text: 'Tasks' }],
    url: 'https://notion.test/db',
    created_time: '2024-01-01T00:00:00Z',
    last_edited_time: '2024-02-03T00:00:00Z',
    parent: { type: 'workspace' },
    data_sources: [{ id: DS_ID, name: 'Tasks' }],
  }
}

function dataSource(): Record<string, unknown> {
  return {
    id: DS_ID,
    object: 'data_source',
    title: [{ plain_text: 'Tasks' }],
    parent: { type: 'database_id', database_id: DB_ID },
    properties: { Name: { type: 'title' } },
  }
}

describe('notion readdir databases', () => {
  // Search answers with data sources since 2025-09-03, so the set of databases
  // is their distinct parents and each one costs a retrieve for its title.
  it('lists databases as the distinct parents of the searched data sources', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [
        {
          id: DS_ID,
          object: 'data_source',
          title: [{ plain_text: 'Tasks' }],
          parent: { type: 'database_id', database_id: DB_ID },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    transport.enqueue('API-retrieve-a-database', database())
    const out = await readdir(makeAccessor(transport), spec('/databases'))
    expect(out).toEqual([`/databases/Tasks__${DB_ID}`])
    expect(transport.invocations[0]?.args).toEqual({
      filter: { value: 'data_source', property: 'object' },
      page_size: 100,
    })
    expect(transport.invocations[1]).toEqual({
      name: 'API-retrieve-a-database',
      args: { database_id: DB_ID },
    })
  })

  it('lists a database directory as its data sources beside database.json', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-database', database())
    const dirPath = `/databases/Tasks__${DB_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath))
    expect(out).toEqual([`${dirPath}/database.json`, `${dirPath}/Tasks__${DS_ID}`])
  })

  it('lists the schema and rows.jsonl under a data source, never the rows', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-data-source', dataSource())
    const dirPath = `/databases/Tasks__${DB_ID}/Tasks__${DS_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath))
    expect(out).toEqual([`${dirPath}/data_source.json`, `${dirPath}/rows.jsonl`])
    expect(transport.invocations.map((call) => call.name)).toEqual(['API-retrieve-a-data-source'])
  })

  it('lists a row by its path, as any page', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', {
      ...topPage(TOP1_ID, 'Row A'),
      parent: { data_source_id: DS_ID },
    })
    transport.enqueue('API-retrieve-block-children', {
      results: [
        {
          id: CHILD1_ID,
          type: 'child_page',
          child_page: { title: 'Notes' },
          last_edited_time: '2024-01-05T00:00:00Z',
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const dirPath = `/databases/Tasks__${DB_ID}/Tasks__${DS_ID}/Row_A__${TOP1_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath))
    expect(out).toEqual([`${dirPath}/page.json`, `${dirPath}/Notes__${CHILD1_ID}`])
    expect(transport.invocations[1]?.args).toEqual({ block_id: TOP1_ID, page_size: 100 })
  })

  it('sizes database.json from the retrieved database', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [
        {
          id: DS_ID,
          object: 'data_source',
          parent: { type: 'database_id', database_id: DB_ID },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    transport.enqueue('API-retrieve-a-database', database())
    transport.enqueue('API-retrieve-a-database', database())
    const vfs = new NotionVFSBase({ accessor: makeAccessor(transport) })
    const ws = new Workspace({ '/': vfs })
    const dirPath = `/databases/Tasks__${DB_ID}`
    await ws.dispatch('readdir', dirPath)
    const row = (await ws.dispatch('stat', `${dirPath}/database.json`)) as FileStat
    expect(row.size).toBe(toJsonBytes(normalizeDatabase(database())).byteLength)
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
    const out = await readdir(makeAccessor(transport), spec(dirPath))
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

  it('throws ENOENT when the last segment is not a valid notion segment', async () => {
    const transport = new FakeTransport()
    let captured: unknown = null
    try {
      await readdir(makeAccessor(transport), spec('/pages/no-id-here/'))
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
        vfsPath: mountKey(dirPath, '/notion'),
      }),
    )
    expect(out).toEqual([`${dirPath}/page.json`, `${dirPath}/ChildA__${CHILD1_ID}`])
  })
})

describe('notion readdir long child titles', () => {
  it('budgets a CJK child page title instead of composing it inline', async () => {
    const title = '会議'.repeat(100)
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-block-children', {
      results: [{ id: CHILD1_ID, type: 'child_page', child_page: { title } }],
      has_more: false,
      next_cursor: null,
    })
    const dirPath = `/pages/Top1__${TOP1_ID}`
    const out = await readdir(makeAccessor(transport), spec(dirPath))
    const child = out.find((p) => !p.endsWith('page.json'))?.slice(dirPath.length + 1)

    expect(child).toBe(formatSegment({ id: CHILD1_ID, title }))
    expect(byteLength(child ?? '')).toBeLessThanOrEqual(NAME_MAX_BYTES)
  })
})

// A directory's children, as a command walks them, handed the rows the mount
// would hand: the directory's and its folder's, as the listings above them
// name them, for a directory an id names.
async function readdir(accessor: NotionAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  const pieces = base.split('/')
  const row = (name: string) =>
    name.includes('__') ? new FileStat({ name, type: FileType.DIRECTORY }) : null
  const listed = await rawOperation(
    accessor,
    path,
    row(pieces.at(-1) ?? ''),
    row(pieces.at(-2) ?? ''),
  )
  return rowsOf(listed).map((child) => `${base}/${child.name}`)
}

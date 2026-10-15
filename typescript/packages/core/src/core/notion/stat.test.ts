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
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import type { NotionAccessor } from '../../accessor/notion.ts'
import { NotionVFSBase } from '../../vfs/notion/notion.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { NotionAPIError, type NotionTransport } from './client.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

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
    const response = list.shift()
    if (response === undefined) return Promise.reject(new Error(`unexpected tool call: ${name}`))
    return Promise.resolve(response)
  }
}

function makeAccessor(transport: NotionTransport): NotionAccessor {
  return { transport }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

// `path`'s stat through a mount at the root, which lists each folder above it
// to hand the backend the rows there.
function mountedStat(transport: NotionTransport, path: string): Promise<FileStat> {
  const vfs = new NotionVFSBase({ accessor: makeAccessor(transport) })
  return new Workspace({ '/': vfs }).dispatch('stat', path) as Promise<FileStat>
}

const PAGE_ID = 'aaaa1111-2222-3333-4444-555566667777'
const DB_ID = 'bbbb1111-2222-3333-4444-555566667777'

function databaseBody(id: string, title: string, lastEdited: string): Record<string, unknown> {
  return {
    id,
    object: 'database',
    title: [{ plain_text: title }],
    last_edited_time: lastEdited,
  }
}

describe('notion stat', () => {
  it('returns a directory stat for the root', async () => {
    const transport = new FakeTransport()
    const result = await stat(makeAccessor(transport), spec('/'))
    expect(result.name).toBe('/')
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(transport.invocations).toHaveLength(0)
  })

  it('returns a directory stat for virtual roots', async () => {
    const transport = new FakeTransport()
    for (const root of ['/', '/pages', '/databases']) {
      const result = await stat(makeAccessor(transport), spec(root))
      expect(result.type).toBe(FileType.DIRECTORY)
    }
    expect(transport.invocations).toHaveLength(0)
  })

  it('answers a database dir with the row its listing names', async () => {
    const transport = new FakeTransport()
    const segment = `Tasks__${DB_ID}`
    const row = new FileStat({
      name: segment,
      type: FileType.DIRECTORY,
      modified: '2024-02-03T00:00:00Z',
      extra: { database_id: DB_ID },
    })
    const result = await stat(makeAccessor(transport), spec(`/databases/${segment}/`), row)
    expect(result).toBe(row)
    expect(transport.invocations).toHaveLength(0)
  })

  it('resolves a database dir through the databases listing', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [{ id: 'ds1', object: 'data_source', parent: { database_id: DB_ID } }],
      has_more: false,
      next_cursor: null,
    })
    transport.enqueue(
      'API-retrieve-a-database',
      databaseBody(DB_ID, 'Tasks', '2024-04-05T00:00:00Z'),
    )
    const result = await mountedStat(transport, `/databases/Tasks__${DB_ID}`)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.modified).toBe('2024-04-05T00:00:00Z')
    expect(result.extra.database_id).toBe(DB_ID)
  })

  it('returns a directory stat for the pages root', async () => {
    const transport = new FakeTransport()
    const result = await stat(makeAccessor(transport), spec('/pages/'))
    expect(result.name).toBe('pages')
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT for a page dir the pages listing does not carry', async () => {
    // A well-shaped page dir is no proof: the mount resolves it through the
    // parent listing, so an unlisted one is absent.
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', { results: [], has_more: false, next_cursor: null })
    await expect(mountedStat(transport, `/pages/Page__${PAGE_ID}`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a page no listing names', async () => {
    const transport = new FakeTransport()
    await expect(
      stat(makeAccessor(transport), spec(`/pages/Page__${PAGE_ID}/`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT for a top-level dir that is not pages', async () => {
    const transport = new FakeTransport()
    await expect(stat(makeAccessor(transport), spec('/no-id-here/'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT for an unknown leaf inside a page dir', async () => {
    const transport = new FakeTransport()
    const segment = `Page__${PAGE_ID}`
    await expect(
      stat(makeAccessor(transport), spec(`/pages/${segment}/foo.txt`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport.invocations).toHaveLength(0)
  })

  it('honors a path prefix', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [
        {
          id: PAGE_ID,
          object: 'page',
          parent: { type: 'workspace' },
          properties: { title: { type: 'title', title: [{ plain_text: 'Page' }] } },
        },
      ],
      has_more: false,
      next_cursor: null,
    })
    const [page] = rowsOf(await readdir(makeAccessor(transport), spec('/notion/pages', '/notion')))
    const virtual = `/notion/pages/Page__${PAGE_ID}/`
    const result = await stat(makeAccessor(transport), spec(virtual, '/notion'), page ?? null)
    expect(result.name).toBe(`Page__${PAGE_ID}`)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.extra.page_id).toBe(PAGE_ID)
  })
})

const DS_ID = 'cccc1111-2222-3333-4444-555566667777'
const DS_DIR = `/databases/Tasks__${DB_ID}/Tasks__${DS_ID}`

function rowBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAGE_ID,
    object: 'page',
    last_edited_time: '2024-03-04T00:00:00Z',
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: DS_ID, database_id: DB_ID },
    properties: { Name: { type: 'title', title: [{ plain_text: 'Row A' }] } },
    ...overrides,
  }
}

// The data source a row sits in, as the mount hands it.
const DS_ROW = new FileStat({
  name: `Tasks__${DS_ID}`,
  type: FileType.DIRECTORY,
  extra: { data_source_id: DS_ID },
})

describe('notion stat rows', () => {
  // A data source lists rows.jsonl rather than its rows, so a row directory
  // proves itself with one retrieve instead of through a listing.
  it('returns a directory stat for a row of this data source', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', rowBody())
    const segment = `Row_A__${PAGE_ID}`
    const result = await stat(makeAccessor(transport), spec(`${DS_DIR}/${segment}`), null, DS_ROW)
    expect(result.name).toBe(segment)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.modified).toBe('2024-03-04T00:00:00Z')
    expect(result.extra.page_id).toBe(PAGE_ID)
    expect(transport.invocations).toEqual([
      { name: 'API-retrieve-a-page', args: { page_id: PAGE_ID } },
    ])
  })

  it('throws ENOENT for a row of a data source no listing names', async () => {
    const transport = new FakeTransport()
    await expect(
      stat(makeAccessor(transport), spec(`${DS_DIR}/Row_A__${PAGE_ID}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport.invocations).toEqual([])
  })

  it('throws ENOENT for a row of another data source', async () => {
    const transport = new FakeTransport()
    transport.enqueue(
      'API-retrieve-a-page',
      rowBody({
        parent: { type: 'data_source_id', data_source_id: 'eeee1111-2222-3333-4444-555566667777' },
      }),
    )
    await expect(
      stat(makeAccessor(transport), spec(`${DS_DIR}/Row_A__${PAGE_ID}`), null, DS_ROW),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for a row spelled with another title', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', rowBody())
    await expect(
      stat(makeAccessor(transport), spec(`${DS_DIR}/Row_B__${PAGE_ID}`), null, DS_ROW),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for a row in the trash', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', rowBody({ in_trash: true }))
    await expect(
      stat(makeAccessor(transport), spec(`${DS_DIR}/Row_A__${PAGE_ID}`), null, DS_ROW),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for a row Notion does not know', async () => {
    const transport: NotionTransport = {
      callTool: () =>
        Promise.reject(new NotionAPIError('Could not find page', 404, 'object_not_found')),
    }
    await expect(
      stat(makeAccessor(transport), spec(`${DS_DIR}/Row_A__${PAGE_ID}`), null, DS_ROW),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists rows.jsonl as text in the data source listing', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-data-source', {
      id: DS_ID,
      object: 'data_source',
      title: [{ plain_text: 'Tasks' }],
      parent: { type: 'database_id', database_id: DB_ID },
      properties: {},
    })
    const listed = rowsOf(await readdir(makeAccessor(transport), spec(DS_DIR), DS_ROW))
    const rows = listed.find((row) => row.name === 'rows.jsonl')
    expect(rows?.type).toBe(FileType.FILE)
    expect(rows?.content).toBe(ContentType.TEXT)
    expect(rows?.size).toBeNull()
    expect(rows?.extra.data_source_id).toBe(DS_ID)
  })

  it('answers a row page.json from its row without a call', async () => {
    // The mount proves the row before it hands it as the parent.
    const transport = new FakeTransport()
    const row = new FileStat({ name: `Row_A__${PAGE_ID}`, type: FileType.DIRECTORY })
    const result = await stat(
      makeAccessor(transport),
      spec(`${DS_DIR}/Row_A__${PAGE_ID}/page.json`),
      null,
      row,
    )
    expect(result.type).toBe(FileType.FILE)
    expect(result.content).toBe(ContentType.JSON)
    expect(transport.invocations).toEqual([])
  })
})

it.each(['Wrong__db123', 'Tasks__db123/Wrong__ds789', 'Tasks__db123/Other__foreign'])(
  'rejects an unlisted ancestor %s before reading its leaf',
  async (directory) => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [{ id: 'ds789', object: 'data_source', parent: { database_id: 'db123' } }],
      has_more: false,
      next_cursor: null,
    })
    const database = {
      id: 'db123',
      title: [{ plain_text: 'Tasks' }],
      data_sources: [{ id: 'ds789', name: 'Tasks' }],
    }
    transport.enqueue('API-retrieve-a-database', database)
    transport.enqueue('API-retrieve-a-database', database)
    const leaf = directory.includes('/') ? 'rows.jsonl' : 'database.json'
    await expect(mountedStat(transport, `/databases/${directory}/${leaf}`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(transport.invocations.some((call) => call.name === 'API-retrieve-a-data-source')).toBe(
      false,
    )
  },
)

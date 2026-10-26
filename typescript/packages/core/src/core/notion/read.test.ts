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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { readFileSync } from 'node:fs'
import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { NotionAPIError, type NotionTransport } from './client.ts'
import { NotionAccessor } from '../../accessor/notion.ts'
import { firstLines, readStream, read as rawOperation } from './read.ts'
import { normalizeRow } from './normalize.ts'
import { jsonlBytes } from '../render/json.ts'
import { materialize } from '../../io/types.ts'
import { NotionVFSBase } from '../../vfs/notion/notion.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { concat } from '../../utils/bytes.ts'

class FakeTransport implements NotionTransport {
  public readonly invocations: { name: string; args: Record<string, unknown> }[] = []
  private readonly responses = new Map<string, (Record<string, unknown> | Error)[]>()

  enqueue(toolName: string, response: Record<string, unknown> | Error): void {
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
    if (response instanceof Error) return Promise.reject(response)
    return Promise.resolve(response)
  }
}

function makeAccessor(transport: NotionTransport): NotionAccessor {
  return { transport }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
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
  // Since 2025-09-03 the database object is a container: it lists its data
  // sources and carries no schema, so `properties` must be absent here and
  // present on data_source.json instead.
  it('returns JSON bytes containing the database container, not a schema or rows', async () => {
    const transport = new FakeTransport()
    const dbIdDashed = 'bbbb1111-2222-3333-4444-555566667777'
    const dbId = 'bbbb1111222233334444555566667777'
    transport.enqueue('API-retrieve-a-database', {
      id: dbIdDashed,
      object: 'database',
      title: [{ plain_text: 'Tasks' }],
      data_sources: [{ id: 'ds-1', name: 'Tasks' }],
      last_edited_time: '2024-02-03T00:00:00Z',
    })
    const path = `/databases/Tasks__${dbId}/database.json`
    const bytes = await read(makeAccessor(transport), spec(path))
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.database_id).toBe(dbIdDashed)
    expect(decoded.title).toBe('Tasks')
    expect(decoded.data_sources).toEqual([{ id: 'ds-1', name: 'Tasks' }])
    expect(decoded.properties).toBeUndefined()
    expect(decoded.is_inline).toBe(false)
    expect(decoded.rows).toBeUndefined()
    expect(decoded.row_count).toBeUndefined()
    expect(transport.invocations).toEqual([
      { name: 'API-retrieve-a-database', args: { database_id: dbId } },
    ])
  })

  it('returns the schema from data_source.json', async () => {
    const transport = new FakeTransport()
    const dbId = 'bbbb1111222233334444555566667777'
    const dsId = 'cccc1111222233334444555566667777'
    transport.enqueue('API-retrieve-a-data-source', {
      id: 'cccc1111-2222-3333-4444-555566667777',
      object: 'data_source',
      title: [{ plain_text: 'Tasks' }],
      parent: { type: 'database_id', database_id: 'bbbb1111-2222-3333-4444-555566667777' },
      properties: { Name: { type: 'title' } },
    })
    const path = `/databases/Tasks__${dbId}/Tasks__${dsId}/data_source.json`
    const bytes = await read(makeAccessor(transport), spec(path))
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.data_source_id).toBe('cccc1111-2222-3333-4444-555566667777')
    expect(decoded.database_id).toBe('bbbb1111-2222-3333-4444-555566667777')
    expect(decoded.properties).toEqual({ Name: { type: 'title' } })
  })

  it('renders rows.jsonl as one line per row: the page.json fields but the body, and its path', async () => {
    const transport = new FakeTransport()
    const dbId = 'bbbb1111222233334444555566667777'
    const dsId = 'cccc1111222233334444555566667777'
    const row = {
      ...pageBody(PAGE_ID_DASHED, 'Row A'),
      parent: { type: 'data_source_id', data_source_id: 'cccc1111-2222-3333-4444-555566667777' },
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Row A' }] },
        Priority: { type: 'number', number: 2 },
      },
    }
    transport.enqueue('API-post-data-source-query', {
      results: [row, { id: 'x', object: 'database' }],
      has_more: false,
      next_cursor: null,
    })
    const path = `/databases/Tasks__${dbId}/Tasks__${dsId}/rows.jsonl`
    const bytes = await read(makeAccessor(transport), spec(path))
    const lines = new TextDecoder().decode(bytes).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('')
    const decoded = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(Object.keys(decoded)).toEqual([
      'page_id',
      'title',
      'path',
      'url',
      'created_time',
      'last_edited_time',
      'parent_type',
      'parent_id',
      'archived',
      'created_by',
      'last_edited_by',
      'properties',
    ])
    expect(decoded.path).toBe(`Row_A__${PAGE_ID_DASHED}/page.json`)
    expect(decoded.parent_id).toBe('cccc1111-2222-3333-4444-555566667777')
    expect(decoded.properties).toEqual(row.properties)
    expect(transport.invocations).toEqual([
      { name: 'API-post-data-source-query', args: { data_source_id: dsId, page_size: 100 } },
    ])
  })

  it('renders a data source with no rows as an empty rows.jsonl', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-data-source-query', {
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const path = `/databases/Tasks__bbbb1111222233334444555566667777/Tasks__cccc1111222233334444555566667777/rows.jsonl`
    const bytes = await read(makeAccessor(transport), spec(path))
    expect(bytes.byteLength).toBe(0)
  })

  it('reads a row page.json as any page', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-a-page', {
      ...pageBody(PAGE_ID_DASHED, 'Row A'),
      parent: { data_source_id: 'cccc1111222233334444555566667777' },
    })
    transport.enqueue('API-retrieve-a-page', {
      ...pageBody(PAGE_ID_DASHED, 'Row A'),
      parent: { data_source_id: 'cccc1111222233334444555566667777' },
    })
    transport.enqueue('API-retrieve-block-children', {
      results: [],
      has_more: false,
      next_cursor: null,
    })
    const path = `/databases/Tasks__bbbb1111222233334444555566667777/Tasks__cccc1111222233334444555566667777/Row_A__${PAGE_ID_DASHED}/page.json`
    const decoded = decodeJson(await read(makeAccessor(transport), spec(path))) as Record<
      string,
      unknown
    >
    expect(decoded.page_id).toBe(PAGE_ID_DASHED)
    expect(decoded.markdown).toBe('')
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
    const bytes = await read(makeAccessor(transport), spec(path))
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
      new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/notion') }),
    )
    const decoded = decodeJson(bytes) as Record<string, unknown>
    expect(decoded.page_id).toBe(PAGE_ID_DASHED)
    expect(decoded.title).toBe('Prefixed')
    expect(decoded.blocks).toEqual([])
  })

  it('throws ENOENT when the path does not end in page.json', async () => {
    const transport = new FakeTransport()
    // A probed directory shape is no proof the node exists, so a page
    // dir read reports absence; only the roots, which exist by
    // construction, answer EISDIR.
    await expect(read(makeAccessor(transport), spec('/pages'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    const cases = [
      `/pages/My_Page__${PAGE_ID_DASHED}/`,
      `/pages/My_Page__${PAGE_ID_DASHED}/SubPage__${CHILD_ID_DASHED}/`,
      `/pages/My_Page__${PAGE_ID_DASHED}/foo.txt`,
    ]
    for (const original of cases) {
      let captured: unknown = null
      try {
        await read(makeAccessor(transport), spec(original))
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
      await read(makeAccessor(transport), spec('/page.json'))
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
      await read(makeAccessor(transport), spec('/pages/no-id/page.json'))
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })
})

it.each([
  [100000000000000000000, '100000000000000000000'],
  [1e-5, '0.00001'],
  [1e-7, '1e-7'],
  [1.0, '1'],
  [-0.0, '0'],
] as const)('spells numeric cells as %s -> %s', async (number, spelling) => {
  const transport = new FakeTransport()
  transport.enqueue('API-post-data-source-query', {
    results: [
      {
        ...pageBody(PAGE_ID_DASHED, 'Row A'),
        properties: { Amount: { type: 'number', number } },
      },
    ],
    has_more: false,
    next_cursor: null,
  })
  const data = await read(makeAccessor(transport), spec('/databases/DB__db/DS__ds/rows.jsonl'))
  const row = JSON.parse(new TextDecoder().decode(data)) as {
    properties: { Amount: { number: number } }
  }
  expect(row.properties.Amount.number === number).toBe(true)
  expect(new TextDecoder().decode(data)).toContain(`"number":${spelling}}`)
})

function parentFor(path: PathSpec): FileStat | null {
  const folder = path.virtual.split('/').at(-2) ?? ''
  return folder.includes('__') ? new FileStat({ name: folder, type: FileType.DIRECTORY }) : null
}

async function read(accessor: NotionAccessor, path: PathSpec) {
  return rawOperation(accessor, path, null, parentFor(path))
}

async function indexFor(path: PathSpec, cache: IndexCacheStore) {
  const pieces = path.virtual.split('/')
  const count = pieces.length - 1
  for (let i = 1; i < count; i++) {
    const key = pieces.slice(0, i + 1).join('/')
    const name = pieces[i] ?? ''
    if (name.includes('__') && (await cache.get(key)).entry == null)
      await cache.setPartialDir(key.slice(0, key.lastIndexOf('/')) || '/', [
        [name, new FileStat({ name, type: FileType.DIRECTORY })],
      ])
  }
  await cache.setDir(path.virtual.slice(0, path.virtual.lastIndexOf('/')), [
    ['rows.jsonl', new FileStat({ name: 'rows.jsonl', type: FileType.FILE })],
  ])
  return cache
}

type Json = Record<string, unknown>
interface StreamFixture {
  responses: Json[]
  prefixes: { n: number; requests: number; rows: number }[]
}
interface PaginationCase {
  name: string
  responses: Json[]
  cursors: (string | null)[]
  error?: { message: string }
}

const FIXTURE = new URL('../../../../../../integ/fixtures/notion/', import.meta.url)
const STREAM = JSON.parse(readFileSync(new URL('streaming.json', FIXTURE), 'utf8')) as StreamFixture
const PAGINATION = JSON.parse(
  readFileSync(new URL('pagination.json', FIXTURE), 'utf8'),
) as PaginationCase[]
const VIRTUAL = '/notion/databases/DB__db/DS__ds/rows.jsonl'
const ROWS = STREAM.responses.flatMap((reply) =>
  (reply.results as Json[]).filter((row) => row.object === 'page'),
)
const EXPECTED = jsonlBytes(ROWS.map(normalizeRow))
const QUERY = 'API-post-data-source-query'

function streamTransport(responses: Json[] = STREAM.responses): FakeTransport {
  const transport = new FakeTransport()
  for (const response of responses) {
    const error = response.raise as { message: string; status: number; code: string } | undefined
    transport.enqueue(
      QUERY,
      error === undefined
        ? {
            ...response,
            ...(Array.isArray(response.results)
              ? { results: (response.results as Json[]).map((row) => ({ object: 'page', ...row })) }
              : {}),
          }
        : new NotionAPIError(error.message, error.status, error.code),
    )
  }
  return transport
}

class StreamingVFS extends NotionVFSBase {
  override readonly name = 'notion'
  override readonly cachesReads = true
  override readonly accessor: NotionAccessor
  constructor(transport: NotionTransport) {
    super()
    this.accessor = new NotionAccessor(transport)
  }
}

describe('Notion streaming rows', () => {
  it('preserves the full rendered bytes and skips empty query pages', async () => {
    const transport = streamTransport()
    const path = spec(VIRTUAL, '/notion')
    const parent = parentFor(path)
    const parts: Uint8Array[] = []
    for await (const chunk of readStream(makeAccessor(transport), path, parent)) parts.push(chunk)
    expect(concat(parts)).toEqual(EXPECTED)
    expect(parts).toHaveLength(2)
    expect(transport.invocations).toHaveLength(3)
    expect(await read(makeAccessor(streamTransport()), path)).toEqual(EXPECTED)
  })

  it.each(STREAM.prefixes)('first $n lines fetch $requests pages', async (prefix) => {
    const transport = streamTransport()
    const path = spec(VIRTUAL, '/notion')
    const result = await firstLines(makeAccessor(transport), path, prefix.n, parentFor(path))
    expect(result).toEqual(jsonlBytes(ROWS.slice(0, prefix.n).map(normalizeRow)))
    expect(transport.invocations).toHaveLength(prefix.requests)
  })

  it('closes before requesting another page', async () => {
    const transport = streamTransport()
    const path = spec(VIRTUAL, '/notion')
    const stream = readStream(makeAccessor(transport), path, parentFor(path))
    try {
      expect((await stream.next()).value).toEqual(jsonlBytes(ROWS.slice(0, 2).map(normalizeRow)))
    } finally {
      await stream.return()
    }
    expect(transport.invocations).toHaveLength(1)
  })

  it.each(PAGINATION.filter((testCase) => testCase.error !== undefined))(
    'propagates $name',
    async (testCase) => {
      const transport = streamTransport(testCase.responses)
      const path = spec(VIRTUAL, '/notion')
      await expect(
        materialize(readStream(makeAccessor(transport), path, parentFor(path))),
      ).rejects.toThrow(testCase.error?.message)
      expect(transport.invocations).toHaveLength(testCase.cursors.length)
      const prefixTransport = streamTransport(testCase.responses)
      await expect(
        firstLines(makeAccessor(prefixTransport), path, 100, parentFor(path)),
      ).rejects.toThrow(testCase.error?.message)
      expect(prefixTransport.invocations).toHaveLength(testCase.cursors.length)
    },
  )

  it('streams an empty data source without bytes', async () => {
    const transport = streamTransport([{ results: [], has_more: false }])
    const path = spec(VIRTUAL, '/notion')
    expect(await materialize(readStream(makeAccessor(transport), path, parentFor(path)))).toEqual(
      new Uint8Array(),
    )
    expect(transport.invocations).toHaveLength(1)
  })

  it('reads metadata whole and declines the first-lines optimization', async () => {
    const transport = new FakeTransport()
    const response = { id: 'ds', title: [], properties: {} }
    transport.enqueue('API-retrieve-a-data-source', response)
    transport.enqueue('API-retrieve-a-data-source', response)
    const path = spec(VIRTUAL.replace('rows.jsonl', 'data_source.json'), '/notion')
    const parent = parentFor(path)
    const accessor = makeAccessor(transport)
    expect(await firstLines(accessor, path, 1, parent)).toBeNull()
    expect(await materialize(readStream(accessor, path, parent))).toEqual(
      await rawOperation(accessor, path, null, parent),
    )
    expect(transport.invocations).toHaveLength(2)
  })

  it.each([`head -n 1 ${VIRTUAL}`, `grep -l EARLY_MATCH ${VIRTUAL}`])(
    'does not cache an early shell read: %s',
    async (command) => {
      const transport = streamTransport([STREAM.responses[0] ?? {}, ...STREAM.responses])
      const vfs = new StreamingVFS(transport)
      const ws = new Workspace({ '/notion': vfs })
      const mount = ws.mounts().find((mount) => mount.vfs === vfs)
      if (mount === undefined) throw new Error('missing Notion mount')
      await indexFor(spec(VIRTUAL, '/notion'), mount.index)
      try {
        const result = await ws.shell(command, { cwd: '/' })
        expect(result.exitCode).toBe(0)
        expect(transport.invocations).toHaveLength(1)
        expect(await ws.cache.get(VIRTUAL)).toBeNull()
        const full = await ws.shell(`cat ${VIRTUAL}`, { cwd: '/' })
        expect(full.stdout).toEqual(EXPECTED)
        expect(full.exitCode).toBe(0)
        expect(transport.invocations).toHaveLength(4)
        expect(await ws.cache.get(VIRTUAL)).toEqual(EXPECTED)
      } finally {
        await ws.close()
      }
    },
  )

  it('does not cache a failed stream', async () => {
    const transport = streamTransport([
      STREAM.responses[0] ?? {},
      { raise: { message: 'access revoked', status: 403, code: 'restricted_resource' } },
    ])
    const vfs = new StreamingVFS(transport)
    const ws = new Workspace({ '/notion': vfs })
    const mount = ws.mounts().find((mount) => mount.vfs === vfs)
    if (mount === undefined) throw new Error('missing Notion mount')
    await indexFor(spec(VIRTUAL, '/notion'), mount.index)
    try {
      const result = await ws.shell(`cat ${VIRTUAL}`, { cwd: '/' })
      expect(result.exitCode).not.toBe(0)
      expect(await ws.cache.get(VIRTUAL)).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('refuses an unlisted parent before fetching rows', async () => {
    const transport = streamTransport()
    const path = spec(VIRTUAL, '/notion')
    await expect(materialize(readStream(makeAccessor(transport), path))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(firstLines(makeAccessor(transport), path, 1)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(transport.invocations).toHaveLength(0)
  })
})

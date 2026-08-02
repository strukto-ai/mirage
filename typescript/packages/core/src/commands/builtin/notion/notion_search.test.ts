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
import { NotionAccessor, type NotionResourceLike } from '../../../accessor/notion.ts'
import type { NotionTransport } from '../../../core/notion/_client.ts'
import { materialize } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { NOTION_SEARCH } from './notion_search.ts'

const DEC = new TextDecoder()

class FakeTransport implements NotionTransport {
  invocations: { name: string; args: Record<string, unknown> }[] = []
  responses: Record<string, unknown>[] = []
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.invocations.push({ name, args })
    if (this.responses.length === 0) return Promise.reject(new Error('no canned response'))
    const response = this.responses.shift()
    if (response === undefined) return Promise.reject(new Error('no canned response'))
    return Promise.resolve(response)
  }
}

function makeFakeResource(transport: NotionTransport): NotionResourceLike {
  const accessor = new NotionAccessor(transport)
  const resource: Resource & { accessor: NotionAccessor } = {
    kind: 'notion',
    accessor,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  return resource as NotionResourceLike
}

function makePage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'abc123def4567890123456789012345a',
    url: 'https://www.notion.so/abc123def4567890123456789012345a',
    last_edited_time: '2026-01-01T00:00:00.000Z',
    parent: { type: 'workspace', workspace: true },
    properties: { title: { type: 'title', title: [{ plain_text: 'Roadmap' }] } },
    ...overrides,
  }
}

interface RunOpts {
  flags: Record<string, string | boolean | number | string[]>
  responses: Record<string, unknown>[]
}

async function runSearch(opts: RunOpts): Promise<{ out: string; transport: FakeTransport }> {
  const cmd = NOTION_SEARCH[0]
  if (cmd === undefined) throw new Error('notion-search not registered')
  const transport = new FakeTransport()
  transport.responses.push(...opts.responses)
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, [], [], {
    stdin: null,
    flags: opts.flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', transport }
  const [bs] = result
  if (bs === null) return { out: '', transport }
  const buf = bs instanceof Uint8Array ? bs : await materialize(bs as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), transport }
}

describe('notion-search command', () => {
  it('searches pages and prints normalized result rows', async () => {
    const { out, transport } = await runSearch({
      flags: { query: 'Roadmap' },
      responses: [{ results: [makePage({})], has_more: false }],
    })
    expect(transport.invocations).toHaveLength(1)
    const call = transport.invocations[0]
    expect(call?.name).toBe('API-post-search')
    expect(call?.args.query).toBe('Roadmap')
    expect(call?.args.filter).toEqual({ value: 'page', property: 'object' })
    expect(call?.args.page_size).toBe(20)
    expect(JSON.parse(out)).toEqual([
      {
        title: 'Roadmap',
        page_id: 'abc123def4567890123456789012345a',
        url: 'https://www.notion.so/abc123def4567890123456789012345a',
        last_edited: '2026-01-01T00:00:00.000Z',
        parent_type: 'workspace',
      },
    ])
  })

  it('falls back to Untitled when the page has no title property', async () => {
    const { out } = await runSearch({
      flags: { query: 'x' },
      responses: [{ results: [makePage({ properties: {} })], has_more: false }],
    })
    const parsed = JSON.parse(out) as { title: string }[]
    expect(parsed[0]?.title).toBe('Untitled')
  })

  it('caps the result list at --limit', async () => {
    const { out, transport } = await runSearch({
      flags: { query: 'x', limit: '1' },
      responses: [
        {
          results: [makePage({}), makePage({ id: 'abc123def4567890123456789012345b' })],
          has_more: false,
        },
      ],
    })
    expect(transport.invocations[0]?.args.page_size).toBe(1)
    expect(JSON.parse(out)).toHaveLength(1)
  })

  it('paginates until has_more is false', async () => {
    const { out, transport } = await runSearch({
      flags: { query: 'x' },
      responses: [
        { results: [makePage({})], has_more: true, next_cursor: 'cur1' },
        {
          results: [makePage({ id: 'abc123def4567890123456789012345b' })],
          has_more: false,
        },
      ],
    })
    expect(transport.invocations).toHaveLength(2)
    expect(transport.invocations[1]?.args.start_cursor).toBe('cur1')
    expect(JSON.parse(out)).toHaveLength(2)
  })

  it('throws when --query is missing', async () => {
    await expect(runSearch({ flags: {}, responses: [] })).rejects.toThrow(/query is required/)
  })

  it('throws when --limit is not a number', async () => {
    await expect(runSearch({ flags: { query: 'x', limit: 'abc' }, responses: [] })).rejects.toThrow(
      /invalid --limit/,
    )
  })

  it('is registered as a read command', () => {
    const cmd = NOTION_SEARCH[0]
    expect(cmd?.write).toBe(false)
  })
})

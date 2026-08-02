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
import { NOTION_BLOCK_APPEND } from './notion_block_append.ts'

const DEC = new TextDecoder()
const PAGE_ID = 'abc123def4567890123456789012345a'

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

interface RunOpts {
  flags: Record<string, string | boolean | number | string[]>
  responses?: Record<string, unknown>[]
}

async function runAppend(opts: RunOpts): Promise<{ out: string; transport: FakeTransport }> {
  const cmd = NOTION_BLOCK_APPEND[0]
  if (cmd === undefined) throw new Error('notion-block-append not registered')
  const transport = new FakeTransport()
  transport.responses.push(
    ...(opts.responses ?? [
      { results: [] },
      {
        id: PAGE_ID,
        object: 'page',
        parent: { type: 'workspace', workspace: true },
        properties: { title: { type: 'title', title: [{ plain_text: 'Doc' }] } },
      },
      {
        results: [
          {
            id: 'b1',
            type: 'paragraph',
            paragraph: { rich_text: [{ plain_text: 'hello' }] },
          },
        ],
        has_more: false,
      },
    ]),
  )
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

describe('notion-block-append command', () => {
  it('appends blocks then returns the refreshed normalized page', async () => {
    const children = [{ type: 'paragraph', paragraph: { rich_text: [] } }]
    const { out, transport } = await runAppend({
      flags: {
        params: JSON.stringify({ block_id: PAGE_ID }),
        json: JSON.stringify({ children }),
      },
    })
    expect(transport.invocations.map((c) => c.name)).toEqual([
      'API-patch-block-children',
      'API-retrieve-a-page',
      'API-retrieve-block-children',
    ])
    expect(transport.invocations[0]?.args).toEqual({ block_id: PAGE_ID, children })
    expect(transport.invocations[1]?.args).toEqual({ page_id: PAGE_ID })
    expect(JSON.parse(out)).toMatchObject({
      page_id: PAGE_ID,
      title: 'Doc',
      parent_type: 'workspace',
      blocks: [{ id: 'b1', type: 'paragraph' }],
    })
  })

  it('throws when --params is missing', async () => {
    await expect(runAppend({ flags: { json: '{}' } })).rejects.toThrow(/--params is required/)
  })

  it('throws when --json is missing', async () => {
    await expect(
      runAppend({ flags: { params: JSON.stringify({ block_id: PAGE_ID }) } }),
    ).rejects.toThrow(/--json is required/)
  })

  it('throws when --params lacks block_id', async () => {
    await expect(runAppend({ flags: { params: '{}', json: '{}' } })).rejects.toThrow(
      /--params must contain block_id/,
    )
  })

  it('is registered as a write command', () => {
    const cmd = NOTION_BLOCK_APPEND[0]
    expect(cmd?.write).toBe(true)
  })
})

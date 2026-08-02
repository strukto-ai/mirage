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
import { NOTION_PAGE_CREATE } from './notion_page_create.ts'

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

interface RunOpts {
  flags: Record<string, string | boolean | number | string[]>
  mountPrefix?: string
  response?: Record<string, unknown>
}

async function runCreate(opts: RunOpts): Promise<{ out: string; transport: FakeTransport }> {
  const cmd = NOTION_PAGE_CREATE[0]
  if (cmd === undefined) throw new Error('notion-page-create not registered')
  const transport = new FakeTransport()
  const response = opts.response ?? {
    id: 'abc123def4567890123456789012345b',
    object: 'page',
    properties: {
      title: { title: [{ plain_text: 'Created' }] },
    },
  }
  transport.responses.push(response)
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, [], [], {
    stdin: null,
    flags: opts.flags,
    filetypeFns: null,
    cwd: '/',
    resource,
    ...(opts.mountPrefix !== undefined ? { mountPrefix: opts.mountPrefix } : {}),
  })
  if (result === null) return { out: '', transport }
  const [bs] = result
  if (bs === null) return { out: '', transport }
  const buf = bs instanceof Uint8Array ? bs : await materialize(bs as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), transport }
}

describe('notion-page-create command', () => {
  it('creates a page at workspace root when parent is /', async () => {
    const { out, transport } = await runCreate({
      flags: { parent: '/', title: 'My New Page' },
    })
    expect(transport.invocations).toHaveLength(1)
    const call = transport.invocations[0]
    expect(call?.name).toBe('API-post-page')
    expect(call?.args.parent).toEqual({ type: 'workspace', workspace: true })
    expect(call?.args.properties).toEqual({
      title: { title: [{ type: 'text', text: { content: 'My New Page' } }] },
    })
    expect(JSON.parse(out)).toMatchObject({ blocks: [] })
  })

  it('creates a page under an existing parent page', async () => {
    const { transport } = await runCreate({
      flags: {
        parent: '/Existing__abc123def4567890123456789012345a/',
        title: 'Sub Page',
      },
    })
    expect(transport.invocations[0]?.args.parent).toEqual({
      type: 'page_id',
      page_id: 'abc123def4567890123456789012345a',
    })
  })

  it('strips the mount prefix from the parent path', async () => {
    const { transport } = await runCreate({
      flags: {
        parent: '/notion/Existing__abc123def4567890123456789012345a/',
        title: 'X',
      },
      mountPrefix: '/notion',
    })
    expect(transport.invocations[0]?.args.parent).toEqual({
      type: 'page_id',
      page_id: 'abc123def4567890123456789012345a',
    })
  })

  it('throws when --title is missing', async () => {
    await expect(runCreate({ flags: { parent: '/' } })).rejects.toThrow(/title is required/)
  })

  it('throws when --parent is missing', async () => {
    await expect(runCreate({ flags: { title: 'X' } })).rejects.toThrow(/parent is required/)
  })

  it('throws when the parent segment is not a valid notion segment', async () => {
    await expect(runCreate({ flags: { parent: '/no-id-here/', title: 'X' } })).rejects.toThrow(
      /invalid parent path/,
    )
  })

  it('is registered as a write command', () => {
    const cmd = NOTION_PAGE_CREATE[0]
    expect(cmd?.write).toBe(true)
  })
})

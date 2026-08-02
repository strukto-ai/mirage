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
import { NOTION_COMMENT_ADD } from './notion_comment_add.ts'

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
  response?: Record<string, unknown>
}

async function runCommentAdd(opts: RunOpts): Promise<{ out: string; transport: FakeTransport }> {
  const cmd = NOTION_COMMENT_ADD[0]
  if (cmd === undefined) throw new Error('notion-comment-add not registered')
  const transport = new FakeTransport()
  transport.responses.push(
    opts.response ?? {
      id: 'comment-1',
      object: 'comment',
      parent: { type: 'page_id', page_id: PAGE_ID },
    },
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

describe('notion-comment-add command', () => {
  it('creates a comment and prints the API response', async () => {
    const body = {
      parent: { page_id: PAGE_ID },
      rich_text: [{ text: { content: 'Nice page' } }],
    }
    const { out, transport } = await runCommentAdd({
      flags: { json: JSON.stringify(body) },
    })
    expect(transport.invocations).toHaveLength(1)
    expect(transport.invocations[0]?.name).toBe('API-create-a-comment')
    expect(transport.invocations[0]?.args).toEqual(body)
    expect(JSON.parse(out)).toEqual({
      id: 'comment-1',
      object: 'comment',
      parent: { type: 'page_id', page_id: PAGE_ID },
    })
  })

  it('throws a usage error when --json is missing', async () => {
    await expect(runCommentAdd({ flags: {} })).rejects.toThrow(/Usage: notion-comment-add/)
  })

  it("throws when the JSON body lacks 'parent'", async () => {
    await expect(
      runCommentAdd({ flags: { json: JSON.stringify({ rich_text: [] }) } }),
    ).rejects.toThrow(/JSON must contain 'parent'/)
  })

  it('is registered as a write command', () => {
    const cmd = NOTION_COMMENT_ADD[0]
    expect(cmd?.write).toBe(true)
  })
})

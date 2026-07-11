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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { resolveNotionGlob, type NotionGlobAccessor } from './glob.ts'

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

function makeAccessor(transport: NotionTransport): NotionGlobAccessor {
  return { transport }
}

const TOP1_ID = 'aaaa1111-2222-3333-4444-555566667777'
const TOP2_ID = 'bbbb2222-3333-4444-5555-666677778888'
const OTHER_ID = 'eeee3333-4444-5555-6666-777788889999'
const SUB1_ID = 'cccc1111-2222-3333-4444-555566667777'
const SUB2_ID = 'dddd2222-3333-4444-5555-666677778888'
const PARENT_ID = 'aaaa1111-2222-3333-4444-555566667777'

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

describe('resolveNotionGlob', () => {
  it('passes a resolved PathSpec through unchanged', async () => {
    const transport = new FakeTransport()
    const resolved = new PathSpec({
      virtual: `/pages/Page__${TOP1_ID}/`,
      directory: `/pages/Page__${TOP1_ID}/`,
      resolved: true,
      resourcePath: mountKey(`/pages/Page__${TOP1_ID}/`, ''),
    })
    const out = await resolveNotionGlob(makeAccessor(transport), [resolved])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(transport.invocations).toHaveLength(0)
  })

  it('passes an unresolved PathSpec without a pattern through unchanged', async () => {
    const transport = new FakeTransport()
    const spec = new PathSpec({
      virtual: `/pages/Page__${TOP1_ID}/`,
      directory: `/pages/Page__${TOP1_ID}/`,
      pattern: null,
      resolved: false,
      resourcePath: mountKey(`/pages/Page__${TOP1_ID}/`, ''),
    })
    const out = await resolveNotionGlob(makeAccessor(transport), [spec])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(spec)
    expect(transport.invocations).toHaveLength(0)
  })

  it('matches root segments by glob pattern', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [topPage(TOP1_ID, 'Top1'), topPage(TOP2_ID, 'Top2'), topPage(OTHER_ID, 'Other')],
      has_more: false,
      next_cursor: null,
    })
    const spec = new PathSpec({
      virtual: '/pages/Top*',
      directory: '/pages',
      pattern: 'Top*',
      resolved: false,
      resourcePath: 'pages/Top*',
    })
    const out = await resolveNotionGlob(makeAccessor(transport), [spec])
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual([`/pages/Top1__${TOP1_ID}`, `/pages/Top2__${TOP2_ID}`])
    for (const p of out) expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('')
  })

  it('matches subtree segments by glob pattern', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-retrieve-block-children', {
      results: [
        { id: SUB1_ID, type: 'child_page', child_page: { title: 'SubA' } },
        { id: SUB2_ID, type: 'child_page', child_page: { title: 'SubB' } },
        { id: OTHER_ID, type: 'child_page', child_page: { title: 'Other' } },
      ],
      has_more: false,
      next_cursor: null,
    })
    const dir = `/pages/Top1__${PARENT_ID}/`
    const spec = new PathSpec({
      virtual: `${dir}Sub*`,
      directory: dir,
      pattern: 'Sub*',
      resolved: false,
      resourcePath: mountKey(`${dir}Sub*`, ''),
    })
    const out = await resolveNotionGlob(makeAccessor(transport), [spec])
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual([
      `/pages/Top1__${PARENT_ID}/SubA__${SUB1_ID}`,
      `/pages/Top1__${PARENT_ID}/SubB__${SUB2_ID}`,
    ])
  })

  it('keeps the literal word when the pattern matches nothing', async () => {
    const transport = new FakeTransport()
    transport.enqueue('API-post-search', {
      results: [topPage(TOP1_ID, 'Top1'), topPage(TOP2_ID, 'Top2')],
      has_more: false,
      next_cursor: null,
    })
    const spec = new PathSpec({
      virtual: '/NoSuchPrefix*',
      directory: '/pages',
      pattern: 'NoSuchPrefix*',
      resolved: false,
      resourcePath: 'NoSuchPrefix*',
    })
    const out = await resolveNotionGlob(makeAccessor(transport), [spec])
    // bash nullglob off: an unmatched glob word stays the literal so the
    // command errors on it like GNU.
    expect(out).toHaveLength(1)
    expect(out[0]?.virtual).toBe('/NoSuchPrefix*')
    expect(out[0]?.pattern).toBeNull()
    expect(out[0]?.resolved).toBe(true)
  })
})

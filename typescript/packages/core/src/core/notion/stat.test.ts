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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { stat, type NotionStatAccessor } from './stat.ts'

class FakeTransport implements NotionTransport {
  public readonly invocations: { name: string; args: Record<string, unknown> }[] = []

  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.invocations.push({ name, args })
    return Promise.reject(new Error(`unexpected tool call: ${name}`))
  }
}

function makeAccessor(transport: NotionTransport): NotionStatAccessor {
  return { transport }
}

function spec(original: string, prefix = ''): PathSpec {
  return new PathSpec({ original, directory: original, prefix })
}

const PAGE_ID = 'aaaa1111-2222-3333-4444-555566667777'

describe('notion stat', () => {
  it('returns a directory stat for the root', async () => {
    const transport = new FakeTransport()
    const result = await stat(makeAccessor(transport), spec('/'), undefined)
    expect(result.name).toBe('/')
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(transport.invocations).toHaveLength(0)
  })

  it('returns a directory stat for the pages root', async () => {
    const transport = new FakeTransport()
    const result = await stat(makeAccessor(transport), spec('/pages/'), undefined)
    expect(result.name).toBe('pages')
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(transport.invocations).toHaveLength(0)
  })

  it('returns a directory stat for a page dir without any API call', async () => {
    const transport = new FakeTransport()
    const segment = `Page__${PAGE_ID}`
    const result = await stat(makeAccessor(transport), spec(`/pages/${segment}/`), undefined)
    expect(result.name).toBe(segment)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.extra.page_id).toBe(PAGE_ID)
    expect(transport.invocations).toHaveLength(0)
  })

  it('uses the cached index entry name for a page dir', async () => {
    const transport = new FakeTransport()
    const idx = new RAMIndexCacheStore()
    const segment = `Page__${PAGE_ID}`
    await idx.put(
      `/pages/${segment}`,
      new IndexEntry({
        id: PAGE_ID,
        name: segment,
        resourceType: 'notion/page',
        remoteTime: '2024-01-02T00:00:00Z',
        vfsName: segment,
      }),
    )
    const result = await stat(makeAccessor(transport), spec(`/pages/${segment}/`), idx)
    expect(result.name).toBe(segment)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.modified).toBe('2024-01-02T00:00:00Z')
    expect(result.extra.page_id).toBe(PAGE_ID)
    expect(transport.invocations).toHaveLength(0)
  })

  it('returns a json stat for page.json without any API call', async () => {
    const transport = new FakeTransport()
    const segment = `Page__${PAGE_ID}`
    const result = await stat(
      makeAccessor(transport),
      spec(`/pages/${segment}/page.json`),
      undefined,
    )
    expect(result.name).toBe('page.json')
    expect(result.type).toBe(FileType.JSON)
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT for a top-level dir that is not pages', async () => {
    const transport = new FakeTransport()
    let captured: unknown = null
    try {
      await stat(makeAccessor(transport), spec('/no-id-here/'), undefined)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })

  it('throws ENOENT for an unknown leaf inside a page dir', async () => {
    const transport = new FakeTransport()
    const segment = `Page__${PAGE_ID}`
    let captured: unknown = null
    try {
      await stat(makeAccessor(transport), spec(`/pages/${segment}/foo.txt`), undefined)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(Error)
    expect((captured as { code?: string }).code).toBe('ENOENT')
    expect(transport.invocations).toHaveLength(0)
  })

  it('honors a path prefix', async () => {
    const transport = new FakeTransport()
    const segment = `Page__${PAGE_ID}`
    const original = `/notion/pages/${segment}/`
    const result = await stat(
      makeAccessor(transport),
      new PathSpec({ original, directory: original, prefix: '/notion' }),
      undefined,
    )
    expect(result.name).toBe(segment)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.extra.page_id).toBe(PAGE_ID)
  })
})

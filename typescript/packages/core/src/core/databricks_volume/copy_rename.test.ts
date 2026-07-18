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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from './copy.ts'
import { rename } from './rename.ts'
import { resolveGlobOf } from '../../commands/builtin/generic_bind/index.ts'
import { DATABRICKS_VOLUME_IO } from '../../commands/builtin/databricks_volume/io.ts'
import { PathSpec } from '../../types.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  spec,
  TEST_ROOT,
  type FetchCall,
} from './_test_util.ts'

const resolveGlob = resolveGlobOf(DATABRICKS_VOLUME_IO)

afterEach(() => {
  vi.unstubAllGlobals()
})

function fileRoutes(call: FetchCall): Response {
  if (call.method === 'HEAD' && call.url.includes('/fs/files/')) {
    return new Response(null, { status: 200, headers: { 'Content-Length': '5' } })
  }
  if (call.method === 'HEAD') return new Response(null, { status: 200 })
  if (call.method === 'GET') return new Response('hello', { status: 200 })
  return new Response(null, { status: 200 })
}

describe('copy', () => {
  it('downloads then uploads file contents', async () => {
    const { fetch, calls } = routedFetch(fileRoutes)
    vi.stubGlobal('fetch', fetch)
    await copy(makeAccessor(), spec('/volume/a.txt'), spec('/volume/b.txt'))
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toContain('b.txt')
    expect(put?.url).toContain('overwrite=true')
  })

  it('is a no-op for the same backend path', async () => {
    const { fetch, calls } = routedFetch(fileRoutes)
    vi.stubGlobal('fetch', fetch)
    await copy(makeAccessor(), spec('/volume/a.txt'), spec('/volume/a.txt'))
    expect(calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE')).toHaveLength(0)
  })

  it('still raises for a missing source on same-path copy', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await copy(
      makeAccessor(),
      spec('/volume/gone.txt'),
      spec('/volume/gone.txt'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('refuses directories without recursive', async () => {
    const { fetch } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await copy(makeAccessor(), spec('/volume/dir'), spec('/volume/dir2')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('EISDIR')
  })

  it('copies trees recursively', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      if (call.method === 'HEAD') return new Response(null, { status: 200 })
      if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
        return jsonResponse({ contents: [{ path: `${TEST_ROOT}/dir/a.txt` }] })
      }
      if (call.method === 'GET') return new Response('data', { status: 200 })
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    await copy(makeAccessor(), spec('/volume/dir'), spec('/volume/dir2'), undefined, true)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.some((c) => c.url.includes('/fs/directories/') && c.url.includes('dir2'))).toBe(
      true,
    )
    expect(puts.some((c) => c.url.includes('dir2/a.txt'))).toBe(true)
  })

  it('refuses copying a directory into its own subtree before any write', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await copy(
      makeAccessor(),
      spec('/volume/dir'),
      spec('/volume/dir/sub'),
      undefined,
      true,
    ).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('into itself')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })
})

describe('rename', () => {
  it('same-path rename is a no-op and never deletes (PR 142 guard)', async () => {
    const { fetch, calls } = routedFetch(fileRoutes)
    vi.stubGlobal('fetch', fetch)
    await rename(makeAccessor(), spec('/volume/a.txt'), spec('/volume/a.txt'))
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('copies then unlinks for distinct paths', async () => {
    const { fetch, calls } = routedFetch(fileRoutes)
    vi.stubGlobal('fetch', fetch)
    await rename(makeAccessor(), spec('/volume/a.txt'), spec('/volume/b.txt'))
    const methods = calls.map((c) => c.method)
    expect(methods).toContain('PUT')
    expect(methods).toContain('DELETE')
    expect(calls.findIndex((c) => c.method === 'DELETE')).toBeGreaterThan(
      calls.findIndex((c) => c.method === 'PUT'),
    )
  })

  it('raises for a missing source', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await rename(
      makeAccessor(),
      spec('/volume/gone.txt'),
      spec('/volume/gone.txt'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('refuses moving a directory into its own subtree and never deletes', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await rename(makeAccessor(), spec('/volume/dir'), spec('/volume/dir/sub')).catch(
      (e: unknown) => e,
    )) as Error
    expect(err.message).toContain('subdirectory of itself')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('resolveGlob', () => {
  it('expands patterns against readdir output', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/a.md` },
          { path: `${TEST_ROOT}/b.txt` },
          { path: `${TEST_ROOT}/c.md` },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const pattern = new PathSpec({
      virtual: '/volume/*.md',
      directory: '/volume/',
      pattern: '*.md',
      resolved: false,
      resourcePath: mountKey('/volume/*.md', '/volume'),
    })
    const resolved = await resolveGlob(makeAccessor(), [pattern])
    expect(resolved.map((p) => p.virtual)).toEqual(['/volume/a.md', '/volume/c.md'])
  })

  it('passes through resolved paths untouched', async () => {
    const { fetch, calls } = routedFetch(() => jsonResponse({ contents: [] }))
    vi.stubGlobal('fetch', fetch)
    const plain = spec('/volume/a.txt')
    const resolved = await resolveGlob(makeAccessor(), [plain])
    expect(resolved).toEqual([plain])
    expect(calls).toHaveLength(0)
  })
})

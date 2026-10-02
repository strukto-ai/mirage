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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { rmRecursive } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { writeBytes } from './write.ts'
import { settling } from '../../cache/_test_util.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  spec,
  TEST_ROOT,
  type FetchCall,
} from './_test_util.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ENC = new TextEncoder()

function isDirHead(call: FetchCall): boolean {
  return call.method === 'HEAD' && call.url.includes('/fs/directories/')
}

describe('writeBytes', () => {
  it('PUTs with overwrite=true after checking the parent directory', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (isDirHead(call)) return new Response(null, { status: 200 })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    await writeBytes(makeAccessor(), spec('/volume/reports/a.txt'), ENC.encode('hi'))
    const put = calls.find((c) => c.method === 'PUT')
    expect(put).toBeDefined()
    expect(put?.url).toContain('/fs/files/')
    expect(put?.url).toContain('overwrite=true')
    expect(put?.body).toEqual(ENC.encode('hi'))
  })

  it('raises ENOENT when the parent directory is missing', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await writeBytes(
      makeAccessor(),
      spec('/volume/missing/a.txt'),
      ENC.encode('x'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('raises ENOTDIR when the parent is a file', async () => {
    const { fetch } = routedFetch((call) => {
      if (isDirHead(call)) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await writeBytes(
      makeAccessor(),
      spec('/volume/file.txt/a.txt'),
      ENC.encode('x'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
  })
})

describe('create', () => {
  it('writes empty bytes', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (isDirHead(call)) return new Response(null, { status: 200 })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    await create(makeAccessor(), spec('/volume/new.txt'))
    const put = calls.find((c) => c.method === 'PUT')
    expect((put?.body as Uint8Array).byteLength).toBe(0)
  })
})

describe('mkdir', () => {
  it('rejects existing targets without parents', async () => {
    const { fetch } = routedFetch(() => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const err = (await mkdir(makeAccessor(), spec('/volume/exists')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('EEXIST')
  })

  it('creates directories via PUT when parents=true', async () => {
    const { fetch, calls } = routedFetch(() => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await mkdir(makeAccessor(), spec('/volume/a/b'), undefined, true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toContain('/fs/directories/')
  })

  it('creates after parent check when target is missing', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'PUT') return new Response(null, { status: 200 })
      if (call.url.includes('/newdir')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    await mkdir(makeAccessor(), spec('/volume/newdir'))
    expect(calls.at(-1)?.method).toBe('PUT')
  })
})

describe('unlink', () => {
  it('deletes files', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Length': '1' } })
      }
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    await unlink(makeAccessor(), spec('/volume/a.txt'))
    expect(calls.at(-1)?.method).toBe('DELETE')
    expect(calls.at(-1)?.url).toContain('/fs/files/')
  })

  it('refuses to delete directories', async () => {
    const { fetch } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await unlink(makeAccessor(), spec('/volume/dir')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('EISDIR')
  })
})

describe('rmdir', () => {
  it('rejects non-empty directories', async () => {
    const { fetch } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      if (call.method === 'HEAD') return new Response(null, { status: 200 })
      return jsonResponse({ contents: [{ path: `${TEST_ROOT}/dir/x.txt` }] })
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await rmdir(makeAccessor(), spec('/volume/dir')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTEMPTY')
  })

  it('deletes empty directories', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      if (call.method === 'HEAD') return new Response(null, { status: 200 })
      if (call.method === 'GET') return jsonResponse({ contents: [] })
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    await rmdir(makeAccessor(), spec('/volume/empty'))
    expect(calls.at(-1)?.method).toBe('DELETE')
    expect(calls.at(-1)?.url).toContain('/fs/directories/')
  })
})

describe('rmRecursive', () => {
  it('removes children before parents and returns virtual paths', async () => {
    const deletes: string[] = []
    const { fetch } = routedFetch((call) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) return notFoundResponse()
      if (call.method === 'HEAD') return new Response(null, { status: 200 })
      if (call.method === 'DELETE') {
        deletes.push(call.url)
        return new Response(null, { status: 200 })
      }
      if (call.url.includes('sub')) {
        return jsonResponse({ contents: [{ path: `${TEST_ROOT}/dir/sub/b.txt` }] })
      }
      return jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/dir/a.txt` },
          { path: `${TEST_ROOT}/dir/sub`, is_directory: true },
        ],
      })
    })
    vi.stubGlobal('fetch', fetch)
    const removed = await rmRecursive(makeAccessor(), spec('/volume/dir'))
    expect(removed).toEqual(['/dir/a.txt', '/dir/sub/b.txt', '/dir/sub', '/dir'])
    expect(deletes).toHaveLength(4)
    expect(deletes.at(-1)).toContain('/fs/directories/')
  })

  it('unlinks plain files', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Length': '5' } })
      }
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const removed = await rmRecursive(makeAccessor(), spec('/volume/a.txt'))
    expect(removed).toEqual(['/a.txt'])
    expect(calls.at(-1)?.method).toBe('DELETE')
  })
})

describe('writeBytes settles', () => {
  it('settles its bytes without a receipt', async () => {
    const { fetch } = routedFetch((call) => {
      if (isDirHead(call)) return new Response(null, { status: 200 })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    const manager = await settling(() =>
      writeBytes(makeAccessor(), spec('/volume/reports/a.txt'), ENC.encode('hi')),
    )
    expect(manager.settled.map((s) => [s.data, s.receipt, s.generation])).toEqual([['hi', null, 5]])
    expect(manager.writes).toEqual([])
  })
})

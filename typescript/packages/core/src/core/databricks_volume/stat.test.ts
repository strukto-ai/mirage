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
import { FileType } from '../../types.ts'
import { exists } from './exists.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  spec,
  TEST_ROOT,
} from '../../../tests/core/databricks_volume/_test_util.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

// The mount answers a stat from the row the listing names, so a row and the
// backend's own stat of the path must agree. Mirrors Python's
// test_a_listed_*_row_matches_its_stat.
describe('a listed row', () => {
  it('matches the stat of a file', async () => {
    const { fetch } = routedFetch((call) => {
      if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
        return jsonResponse({
          contents: [
            { path: `${TEST_ROOT}/reports/a.txt`, file_size: 6, last_modified: 1_700_000_000_000 },
          ],
        })
      }
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': '6', 'Last-Modified': 'Tue, 14 Nov 2023 22:13:20 GMT' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const [row] = await readdir(makeAccessor(), spec('/volume/reports'))
    expect(row).toEqual(await stat(makeAccessor(), spec('/volume/reports/a.txt')))
  })

  it('matches the stat of a directory', async () => {
    const { fetch } = routedFetch((call) => {
      if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
        return jsonResponse({
          contents: [{ path: `${TEST_ROOT}/reports/sub`, is_directory: true }],
        })
      }
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) {
        return notFoundResponse()
      }
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const [row] = await readdir(makeAccessor(), spec('/volume/reports'))
    expect(row?.type).toBe(FileType.DIRECTORY)
    expect(row).toEqual(await stat(makeAccessor(), spec('/volume/reports/sub')))
  })
})

describe('stat', () => {
  it('returns file metadata from HEAD headers', async () => {
    const { fetch, calls } = routedFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'Content-Length': '42',
            'Last-Modified': 'Wed, 10 Jun 2026 01:02:03 GMT',
          },
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const st = await stat(makeAccessor(), spec('/volume/reports/a.txt'))
    expect(st.name).toBe('a.txt')
    expect(st.size).toBe(42)
    expect(st.modified).toBe('2026-06-10T01:02:03Z')
    expect(st.type).not.toBe(FileType.DIRECTORY)
    expect(calls[0]?.method).toBe('HEAD')
    expect(calls[0]?.url).toContain('/fs/files/')
  })

  it('falls back to directory metadata on file 404', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.url.includes('/fs/files/')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const st = await stat(makeAccessor(), spec('/volume/reports'))
    expect(st.name).toBe('reports')
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD'])
    expect(calls[1]?.url).toContain('/fs/directories/')
  })

  it('raises ENOENT when neither file nor directory exists', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await stat(makeAccessor(), spec('/volume/gone')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('returns a directory stat for the mount root without any request', async () => {
    const { fetch, calls } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const st = await stat(makeAccessor(), spec('/volume/'))
    expect(st.name).toBe('/')
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(calls).toHaveLength(0)
  })
})

describe('exists', () => {
  it('maps stat success and ENOENT to booleans', async () => {
    const { fetch } = routedFetch((call) =>
      call.url.includes('a.txt')
        ? new Response(null, { status: 200, headers: { 'Content-Length': '1' } })
        : notFoundResponse(),
    )
    vi.stubGlobal('fetch', fetch)
    expect(await exists(makeAccessor(), spec('/volume/a.txt'))).toBe(true)
    expect(await exists(makeAccessor(), spec('/volume/gone.txt'))).toBe(false)
  })
})

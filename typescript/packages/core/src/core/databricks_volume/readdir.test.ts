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
import { DirListing, type FileStat, FileType } from '../../types.ts'
import { readdir } from './readdir.ts'
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

describe('readdir', () => {
  it('lists sorted rows named without trailing slashes', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/b.txt`, is_directory: false, file_size: 2 },
          { path: `${TEST_ROOT}/a`, is_directory: true },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const rows = (await readdir(makeAccessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.type])).toEqual([
      ['a', FileType.DIRECTORY],
      ['b.txt', FileType.FILE],
    ])
  })

  it('follows next_page_token pagination', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.url.includes('page_token=next')) {
        return jsonResponse({ contents: [{ path: `${TEST_ROOT}/b.txt`, file_size: 1 }] })
      }
      return jsonResponse({
        contents: [{ path: `${TEST_ROOT}/a.txt`, file_size: 1 }],
        next_page_token: 'next',
      })
    })
    vi.stubGlobal('fetch', fetch)
    const rows = (await readdir(makeAccessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => row.name)).toEqual(['a.txt', 'b.txt'])
    expect(calls).toHaveLength(2)
  })

  it('pages no further than a limit and marks the listing partial', async () => {
    const { fetch, calls } = routedFetch(() =>
      jsonResponse({
        contents: [{ path: `${TEST_ROOT}/a.txt`, file_size: 1 }],
        next_page_token: 'next',
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const cut = await readdir(makeAccessor(), spec('/volume/'), 1)
    expect(cut).toBeInstanceOf(DirListing)
    expect((cut as DirListing).partial).toBe(true)
    expect((cut as DirListing).entries.map((row) => row.name)).toEqual(['a.txt'])
    expect(calls).toHaveLength(1)
  })

  it('raises ENOENT for missing directories', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await readdir(makeAccessor(), spec('/volume/missing')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('reports ENOTDIR for an operand under a file', async () => {
    // The Files API 404s `/a.txt/x` exactly as it does a name that is simply
    // absent, so only the ancestor walk can tell GNU's "Not a directory"
    // from "No such file or directory".
    const { fetch } = routedFetch((call) => {
      // The two probes differ only by endpoint, so the route has to read it:
      // both URLs end in the same volume path.
      if (call.url.includes('/fs/files') && call.url.endsWith(`${TEST_ROOT}/a.txt`)) {
        return jsonResponse({})
      }
      return notFoundResponse()
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await readdir(makeAccessor(), spec('/volume/a.txt/x')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
  })

  it('settles a file operand on one probe, without walking its ancestors', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD') return jsonResponse({})
      return notFoundResponse()
    })
    vi.stubGlobal('fetch', fetch)
    const err = (await readdir(makeAccessor(), spec('/volume/docs/a.txt')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
    expect(calls.filter((c) => c.method === 'HEAD')).toHaveLength(1)
  })

  it('answers each child with its size, type and modified time', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [
          { path: `${TEST_ROOT}/a.txt`, file_size: 6, last_modified: 1_700_000_000_000 },
          { path: `${TEST_ROOT}/d`, is_directory: true },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const [file, dir] = (await readdir(makeAccessor(), spec('/volume/'))) as FileStat[]
    expect([file?.type, file?.size, file?.modified]).toEqual([
      FileType.FILE,
      6,
      '2023-11-14T22:13:20Z',
    ])
    expect(dir?.type).toBe(FileType.DIRECTORY)
  })

  it('backfills a lister-omitted size with one HEAD', async () => {
    const { fetch, calls } = routedFetch((call) => {
      if (call.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': '7' } })
      }
      return jsonResponse({
        contents: [{ path: `${TEST_ROOT}/a.txt` }, { path: `${TEST_ROOT}/b.txt`, file_size: 3 }],
      })
    })
    vi.stubGlobal('fetch', fetch)
    const rows = (await readdir(makeAccessor(), spec('/volume/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.size])).toEqual([
      ['a.txt', 7],
      ['b.txt', 3],
    ])
    expect(calls.filter((c) => c.method === 'HEAD')).toHaveLength(1)
  })
  it('interprets early-epoch listing timestamps as milliseconds', async () => {
    const { fetch } = routedFetch(() =>
      jsonResponse({
        contents: [{ path: `${TEST_ROOT}/early.txt`, file_size: 1, last_modified: 1000 }],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const [file] = (await readdir(makeAccessor(), spec('/volume/'))) as FileStat[]
    expect(file?.modified).toBe('1970-01-01T00:00:01Z')
  })
})

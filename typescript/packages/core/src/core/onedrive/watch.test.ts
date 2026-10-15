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

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { FileChangeKind, PathSpec } from '../../types.ts'
import { buildDeltaHook } from './watch.ts'

const API = 'https://graph.microsoft.com/v1.0'
const NEW = '2026-10-01T00:00:00Z'
const OLD = '2020-01-01T00:00:00Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

// A drive whose /delta answers, after token n, the n-th page of `feeds`.
function graph(feeds: Record<string, unknown>[][]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | RequestInfo) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      const path = decodeURIComponent(url.pathname)
      const link = (n: number): string => `${API}/me/drive/root/delta?token=${String(n)}`
      let body: unknown
      if (path === '/v1.0/me/drive/root') body = { id: 'me:/' }
      else if (path === '/v1.0/me/drive/root/delta') {
        const token = url.searchParams.get('token')
        const n = token === 'latest' ? -1 : Number(token)
        body = { value: n < 0 ? [] : feeds[n], '@odata.deltaLink': link(n + 1) }
      } else throw new Error(`unrouted ${path}`)
      return Promise.resolve(new Response(JSON.stringify(body)))
    }),
  )
}

// Twin of test_the_feed_places_items_by_their_parents.
describe('the onedrive delta feed', () => {
  it('places items by their parents', async () => {
    graph([
      [
        { id: 'me:/', name: 'root', root: {}, folder: {} },
        {
          id: 'me:sub/',
          name: 'sub',
          folder: {},
          parentReference: { id: 'me:/' },
          createdDateTime: NEW,
          lastModifiedDateTime: NEW,
        },
        {
          id: 'me:sub/b.txt',
          name: 'b.txt',
          file: {},
          parentReference: { id: 'me:sub/' },
          createdDateTime: NEW,
          lastModifiedDateTime: NEW,
        },
        {
          id: 'me:a.txt',
          name: 'a.txt',
          file: {},
          parentReference: { id: 'me:/' },
          createdDateTime: OLD,
          lastModifiedDateTime: NEW,
        },
      ],
      [{ id: 'me:a.txt', deleted: {} }],
    ])
    const hook = buildDeltaHook(new OneDriveAccessor({ accessToken: 'token' }))
    const root = PathSpec.fromStrPath('/', '')
    const baseline = await hook.pull(root, null)
    const first = await hook.pull(root, baseline.checkpoint)
    const second = await hook.pull(root, first.checkpoint)
    expect(baseline.changes).toEqual([])
    expect(first.changes.map((e) => [e.kind, e.path.virtual])).toEqual([
      [FileChangeKind.CREATE, '/sub'],
      [FileChangeKind.CREATE, '/sub/b.txt'],
      [FileChangeKind.UPDATE, '/a.txt'],
    ])
    expect(second.changes.map((e) => [e.kind, e.path.virtual])).toEqual([
      [FileChangeKind.DELETE, '/a.txt'],
    ])
  })
})

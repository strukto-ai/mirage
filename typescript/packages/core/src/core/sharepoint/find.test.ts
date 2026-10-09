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

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { PathSpec } from '../../types.ts'
import type { FindOptions } from '../../vfs/types.ts'
import { find } from './find.ts'

// One site with one library holding `a.txt` and an empty `sub`; the site
// and library levels of an unscoped mount carry no driveId, so find has to
// walk them itself.
function namespaceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input)
      let value: unknown[] = []
      if (url.includes('/sites?')) value = [{ id: 'site-id', displayName: 'Team', name: 'team' }]
      else if (url.includes('/drives?')) value = [{ id: 'drive-id', name: 'Documents' }]
      else if (url.includes('/root/children')) {
        value = [
          { id: '1', name: 'a.txt', size: 10 },
          { id: '2', name: 'sub', folder: { childCount: 0 } },
        ]
      }
      return Promise.resolve(new Response(JSON.stringify({ value }), { status: 200 }))
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint unscoped find', () => {
  const root = PathSpec.fromStrPath('/sp', '')
  const site = PathSpec.fromStrPath('/sp/Team', 'Team')

  it.each<[string, PathSpec, FindOptions, string[]]>([
    [
      'walks sites and libraries from the mount root',
      root,
      {},
      ['/', '/Team', '/Team/Documents', '/Team/Documents/a.txt', '/Team/Documents/sub'],
    ],
    ['counts depth from the real start path', root, { maxDepth: 1 }, ['/', '/Team']],
    ['walks libraries from a site directory', site, { type: 'f' }, ['/Team/Documents/a.txt']],
  ])('%s', async (_case, path, options, rows) => {
    namespaceFetch()
    expect(await find(new SharePointAccessor({ accessToken: 'token' }), path, options)).toEqual(
      rows,
    )
  })
})

describe('SharePoint find in a library', () => {
  // The start-row probe answers whether the start is a directory, so a
  // start gone by the time it asks is "no", not an error.
  it.each([
    [{ id: 'gone', name: 'gone', folder: { childCount: 0 } }, ['/gone']],
    [undefined, []],
  ])('emits an empty start only while it still exists (%o)', async (item, rows) => {
    const api = 'https://graph.microsoft.com/v1.0'
    const routes: Record<string, unknown> = {
      [`${api}/sites`]: { value: [{ id: 'site-id', displayName: 'Team' }] },
      [`${api}/sites/site-id/drives`]: { value: [{ id: 'drive-id', name: 'Documents' }] },
      [`${api}/drives/drive-id/root:/gone:/children`]: { value: [] },
      [`${api}/drives/drive-id/root:/gone`]: item,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const body = routes[String(input).split('?')[0] ?? '']
        return Promise.resolve(
          body === undefined
            ? new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 })
            : new Response(JSON.stringify(body), { status: 200 }),
        )
      }),
    )
    const accessor = new SharePointAccessor({
      accessToken: 'token',
      site: 'Team',
      drive: 'Documents',
    })
    expect(await find(accessor, PathSpec.fromStrPath('/sp/gone', 'gone'))).toEqual(rows)
  })
})

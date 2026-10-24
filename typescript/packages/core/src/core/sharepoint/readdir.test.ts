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
import { type FileStat, PathSpec } from '../../types.ts'
import { readdir, tree } from './readdir.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint namespace listings', () => {
  it('lists the sites, then the libraries of a site, as directories', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const value = String(input).includes('/sites?')
          ? [{ id: 'site-id', displayName: 'Team', name: 'team' }]
          : [{ id: 'drive-id', name: 'Documents' }]
        return Promise.resolve(new Response(JSON.stringify({ value }), { status: 200 }))
      }),
    )
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    const sites = (await readdir(accessor, PathSpec.fromStrPath('/sp', ''))) as FileStat[]
    expect(sites.map((row) => [row.name, row.type])).toEqual([['Team', 'directory']])
    const libraries = (await readdir(
      accessor,
      PathSpec.fromStrPath('/sp/Team', 'Team'),
    )) as FileStat[]
    expect(libraries.map((row) => [row.name, row.type])).toEqual([['Documents', 'directory']])
  })
})

// Sites, then a site's libraries, then a library's listings; any other request
// fails the test. Each JSON body sent is kept in `sent`.
function library(sent: unknown[] = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (typeof init?.body === 'string') sent.push(JSON.parse(init.body))
      let body: unknown
      if (url.includes('/sites?')) {
        body = { value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }
      } else if (url.includes('/drives?')) {
        body = { value: [{ id: 'drive-id', name: 'Documents' }] }
      } else if (url.endsWith('/root/children')) {
        body = {
          value: [
            { id: '1', name: 'readme.md', size: 3, file: {} },
            { id: '2', name: 'src', folder: { childCount: 1 } },
          ],
        }
      } else if (url.endsWith('/$batch')) {
        body = {
          responses: [
            {
              id: '0',
              status: 200,
              body: { value: [{ id: '3', name: 'main.py', size: 5, file: {} }] },
            },
          ],
        }
      } else {
        throw new Error(`unstubbed request: ${url}`)
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }),
  )
}

describe('SharePoint tree', () => {
  it("leaves the sites and a site's libraries to the walk", async () => {
    library()
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await tree(accessor, PathSpec.fromStrPath('/sp', ''))).toBeNull()
    expect(await tree(accessor, PathSpec.fromStrPath('/sp/Team', 'Team'))).toBeNull()
  })

  it('batches the folders of a library', async () => {
    const sent: unknown[] = []
    library(sent)
    const found = await tree(
      new SharePointAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/sp/Team/Documents', 'Team/Documents'),
    )
    expect([...(found?.keys() ?? [])].sort()).toEqual(['readme.md', 'src', 'src/main.py'])
    expect(sent).toEqual([
      { requests: [{ id: '0', method: 'GET', url: '/drives/drive-id/root:/src:/children' }] },
    ])
  })
})

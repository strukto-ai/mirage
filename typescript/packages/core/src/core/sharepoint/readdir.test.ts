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
import { readdir } from './readdir.ts'

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
    const sites = await readdir(accessor, PathSpec.fromStrPath('/sp', ''))
    expect(sites.map((row) => [row.name, row.type])).toEqual([['Team', 'directory']])
    const libraries = await readdir(accessor, PathSpec.fromStrPath('/sp/Team', 'Team'))
    expect(libraries.map((row) => [row.name, row.type])).toEqual([['Documents', 'directory']])
  })
})

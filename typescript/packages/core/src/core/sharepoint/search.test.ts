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
import { filesContaining } from './search.ts'

const DRIVE = 'https://graph.microsoft.com/v1.0/drives/drive-id'

afterEach(() => {
  vi.unstubAllGlobals()
})

function accessor(): SharePointAccessor {
  const out = new SharePointAccessor({ accessToken: 'tok' })
  out.siteCache.set('Team', 'site-id')
  out.driveCache.set('site-id\0Documents', 'drive-id')
  return out
}

function scope(vfsPath: string): PathSpec {
  const virtual = vfsPath === '' ? '/sp' : `/sp/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

describe('sharepoint filesContaining', () => {
  it('searches a library scope from the library root', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = decodeURIComponent(String(input)).split('?')[0]
        const value =
          url === `${DRIVE}/root/children`
            ? [
                { id: '1', name: 'a.txt', size: 7, file: {} },
                { id: '2', name: 'b.txt', size: 7, file: {} },
              ]
            : url === `${DRIVE}/root/search(q='wombat')`
              ? [{ id: '2' }]
              : null
        return Promise.resolve(
          value === null
            ? new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 })
            : new Response(JSON.stringify({ value }), { status: 200 }),
        )
      }),
    )
    const out = await filesContaining(accessor(), 'wombat', [scope('Team/Documents')])
    expect(out?.map((p) => p.virtual)).toEqual(['/sp/Team/Documents/b.txt'])
  })

  it('answers null for a scope above a library', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const vfsPath of ['', 'Team']) {
      expect(await filesContaining(accessor(), 'wombat', [scope(vfsPath)])).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

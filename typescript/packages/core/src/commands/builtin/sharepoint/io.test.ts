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

import { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { PathSpec } from '../../../types.ts'
import { ioFor } from '../../../test-utils.ts'
import { SharePointVFS } from '../../../vfs/sharepoint/sharepoint.ts'

const API = 'https://graph.microsoft.com/v1.0'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint du', () => {
  // An unscoped mount's root and site levels are directories like any
  // other, so du sums every library under them.
  it.each(['', 'Team', 'Team/Documents'])('walks the namespace from %j', async (key) => {
    const routes: Record<string, unknown> = {
      [`${API}/sites`]: { value: [{ id: 'site-id', displayName: 'Team' }] },
      [`${API}/sites/site-id/drives`]: { value: [{ id: 'drive-id', name: 'Documents' }] },
      [`${API}/drives/drive-id/root/children`]: {
        value: [
          { id: '1', name: 'a.txt', size: 3, file: {} },
          { id: '2', name: 'b.txt', size: 4, file: {} },
        ],
      },
    }
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input).split('?')[0] ?? ''
        seen.push(url)
        return Promise.resolve(new Response(JSON.stringify(routes[url] ?? { value: [] })))
      }),
    )
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    const path = PathSpec.fromStrPath(key === '' ? '/sp' : `/sp/${key}`, key)
    expect(
      await ioFor(SharePointVFS, accessor).du?.size(accessor, path, new RAMIndexCacheStore()),
    ).toBe(7)
    expect(seen).toEqual([
      `${API}/sites`,
      `${API}/sites/site-id/drives`,
      `${API}/drives/drive-id/root/children`,
    ])
  })
})

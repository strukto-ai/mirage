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
import { FileChangeKind, PathSpec } from '../../types.ts'
import { buildDeltaHook } from './events.ts'

const API = 'https://graph.microsoft.com/v1.0'

afterEach(() => {
  vi.unstubAllGlobals()
})

// One tenant with one site and one library, whose /delta lists `a.txt`
// after the first token.
function tenant(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | RequestInfo) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      const path = decodeURIComponent(url.pathname)
      const link = (n: number): string => `${API}/drives/b!drive/root/delta?token=${String(n)}`
      let body: unknown
      if (path === '/v1.0/sites')
        body = { value: [{ id: 'site', name: 'main', displayName: 'Main' }] }
      else if (path === '/v1.0/sites/site/drives')
        body = { value: [{ id: 'b!drive', name: 'Documents' }] }
      else if (path === '/v1.0/drives/b!drive/root') body = { id: 'b!drive:/' }
      else if (path === '/v1.0/drives/b!drive/root/delta') {
        const token = url.searchParams.get('token')
        body =
          token === 'latest'
            ? { value: [], '@odata.deltaLink': link(0) }
            : {
                value: [
                  {
                    id: 'b!drive:a.txt',
                    name: 'a.txt',
                    file: {},
                    parentReference: { id: 'b!drive:/' },
                    createdDateTime: '2020-01-01T00:00:00Z',
                  },
                ],
                '@odata.deltaLink': link(1),
              }
      } else throw new Error(`unrouted ${path}`)
      return Promise.resolve(new Response(JSON.stringify(body)))
    }),
  )
}

// Twin of test_an_unscoped_root_reads_every_library.
describe('the sharepoint delta feed', () => {
  it('reads every library under an unscoped root', async () => {
    tenant()
    const hook = buildDeltaHook(new SharePointAccessor({ accessToken: 'token' }))
    const root = PathSpec.fromStrPath('/', '')
    const baseline = await hook.pull(root, null)
    const changed = await hook.pull(root, baseline.checkpoint)
    expect(baseline.changes).toEqual([])
    expect(changed.changes.map((e) => [e.kind, e.path.virtual])).toEqual([
      [FileChangeKind.UPDATE, '/Main/Documents/a.txt'],
    ])
  })
})

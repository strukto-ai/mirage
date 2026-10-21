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

import { SharePointAccessor, type SharePointConfig } from '../../accessor/sharepoint.ts'
import { PathSpec } from '../../types.ts'
import { resolve, siteEntries } from './resolve.ts'

const API = 'https://graph.microsoft.com/v1.0'

// Answers /sites with `sites` and every /drives listing with one library.
function graph(sites: Record<string, unknown>[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input)
    const value = url.startsWith(`${API}/sites?`) ? sites : [{ id: 'drive-id', name: 'Documents' }]
    return Promise.resolve(new Response(JSON.stringify({ value }), { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const TEAM = { id: 'site-id', displayName: 'Team', name: 'team', webUrl: 'https://a.test/sites/t' }

function accessor(config: Partial<SharePointConfig> = {}): SharePointAccessor {
  return new SharePointAccessor({ accessToken: 'token', ...config })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint resolution', () => {
  it.each([
    ['', {}, { level: 'root' }],
    ['Team', {}, { level: 'site', siteId: 'site-id' }],
    ['team', {}, { level: 'site', siteId: 'site-id' }],
    ['Team/Documents', {}, { level: 'drive', driveId: 'drive-id', itemPath: null }],
    ['Team/Documents/a/b.txt', {}, { level: 'item', itemPath: 'a/b.txt' }],
    ['Nope/Documents', {}, { level: 'site', siteId: null }],
    ['Team/Nope', {}, { level: 'drive', siteId: 'site-id', driveId: null }],
    ['', { site: 'Team', drive: 'Documents' }, { level: 'drive', driveId: 'drive-id' }],
    [
      '2026/q1.txt',
      { site: 'Team', drive: 'Documents' },
      { level: 'item', itemPath: '2026/q1.txt' },
    ],
    ['', { site: 'Team', drive: 'Documents', keyPrefix: 'Reports' }, { itemPath: 'Reports' }],
    [
      '2026/q1.txt',
      { site: 'Team', drive: 'Documents', keyPrefix: 'Reports' },
      { level: 'item', itemPath: 'Reports/2026/q1.txt' },
    ],
  ])('resolves %j under %o', async (key, config, expected) => {
    graph([TEAM])
    const path = PathSpec.fromStrPath(`/sp/${key}`, key)
    expect(await resolve(accessor(config), path)).toMatchObject(expected)
  })

  // A drop while Graph answered may be for the very change the reply
  // predates: the lookup still gets its answer, and the reply is not kept.
  it('keeps no reply that lands after the mount dropped its caches', async () => {
    const sp = accessor()
    vi.stubGlobal('fetch', () => {
      sp.forget()
      return Promise.resolve(new Response(JSON.stringify({ value: [TEAM] }), { status: 200 }))
    })
    const path = PathSpec.fromStrPath('/sp/Team', 'Team')
    expect(await resolve(sp, path)).toMatchObject({ level: 'site', siteId: 'site-id' })
    expect(sp.siteCache.size).toBe(0)
  })

  it('looks a site up once, then answers from the cache', async () => {
    const fetchMock = graph([TEAM])
    const sp = accessor()
    await resolve(sp, PathSpec.fromStrPath('/sp/Team/Documents/a', 'Team/Documents/a'))
    await resolve(sp, PathSpec.fromStrPath('/sp/team/Documents/b', 'team/Documents/b'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('SharePoint site entries', () => {
  it('skips a site nothing could address', async () => {
    graph([TEAM, { displayName: 'No id' }, { id: 'nameless' }])
    expect(await siteEntries(accessor())).toEqual([['Team', 'site-id']])
  })

  it.each([
    [undefined, ['Other', 'Team']],
    ['a.test', ['Team']],
    ['A.TEST', ['Team']],
  ])('keeps the sites on tenant host %s', async (tenantHost, names) => {
    graph([TEAM, { id: 'o', displayName: 'Other', webUrl: 'https://b.test/sites/o' }])
    const entries = await siteEntries(accessor(tenantHost === undefined ? {} : { tenantHost }))
    expect(entries.map(([name]) => name)).toEqual(names)
  })
})

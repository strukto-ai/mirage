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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { driveLoc } from '../onedrive/client.ts'
import { readdir } from '../onedrive/readdir.ts'
import { filesContaining } from './search.ts'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'
const DOCS = [{ id: '3', name: 'b.txt', size: 7, file: {} }]
const ACCESSOR = new OneDriveAccessor({ accessToken: 'tok' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

// Answers each Graph URL from a table keyed by its decoded path; any search
// URL takes the 'search' route. Returns every URL asked, decoded.
function graph(routes: Record<string, () => Promise<Response>>): string[] {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = decodeURIComponent(String(input instanceof Request ? input.url : input))
      seen.push(url)
      const path = url.split('?')[0] ?? ''
      const route = routes[path.includes('/search(') ? 'search' : path]
      return route === undefined ? Promise.resolve(json({ error: { code: 'x' } }, 404)) : route()
    }),
  )
  return seen
}

const ok = (body: unknown) => (): Promise<Response> => Promise.resolve(json(body))

function ask(text: string, vfsPath = '', index?: IndexCacheStore): Promise<PathSpec[] | null> {
  const virtual = vfsPath === '' ? '/od' : `/od/${vfsPath}`
  const scope = new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
  const scopes = [[scope, driveLoc(ACCESSOR.config, vfsPath)] as const]
  return filesContaining(
    ACCESSOR.config,
    readdir,
    ACCESSOR,
    scopes,
    text,
    index ?? new RAMIndexCacheStore(),
  )
}

describe('msgraph filesContaining', () => {
  it('answers the walked files Graph names', async () => {
    graph({
      [`${BASE}/root/children`]: ok({
        value: [
          { id: '1', name: 'a.txt', size: 7, file: {} },
          { id: '2', name: 'c.txt', size: 7, file: {} },
          { id: '9', name: 'Docs', folder: { childCount: 1 } },
        ],
      }),
      [`${BASE}/root:/Docs:/children`]: ok({ value: DOCS }),
      search: ok({ value: [{ id: '3' }, { id: '1' }, { id: '9' }] }),
    })
    const out = await ask('wombat')
    expect(out?.map((p) => p.virtual).sort()).toEqual(['/od/Docs/b.txt', '/od/a.txt'])
  })

  it('quotes the text and searches from the scope', async () => {
    const seen = graph({
      [`${BASE}/root:/Docs:/children`]: ok({ value: DOCS }),
      search: ok({ value: [{ id: '3' }] }),
    })
    expect((await ask("it's", 'Docs'))?.map((p) => p.vfsPath)).toEqual(['Docs/b.txt'])
    expect(seen.some((u) => u.startsWith(`${BASE}/root:/Docs:/search(q='it''s')`))).toBe(true)
  })

  it('answers null when a listed file has no id', async () => {
    const index = new RAMIndexCacheStore()
    graph({
      [`${BASE}/root:/Docs:/children`]: ok({
        value: [...DOCS, { id: '4', name: 'd.txt', file: {} }],
      }),
      search: ok({ value: [{ id: '3' }] }),
    })
    await readdir(ACCESSOR, PathSpec.fromStrPath('/od/Docs', 'Docs'), index)
    const entry = (await index.get('/od/Docs/d.txt')).entry
    if (entry === null || entry === undefined) throw new Error('d.txt not indexed')
    delete entry.extra.id
    await index.put('/od/Docs/d.txt', entry)
    expect(await ask('wombat', 'Docs', index)).toBeNull()
  })

  it.each([
    ['no hit', ok({ value: DOCS }), ok({ value: [] })],
    ['a failed search', ok({ value: DOCS }), () => Promise.resolve(json({ error: {} }, 400))],
    [
      'a timed-out search',
      ok({ value: DOCS }),
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    ],
    [
      'a failed listing',
      () => Promise.reject(new TypeError('fetch failed')),
      ok({ value: [{ id: '3' }] }),
    ],
  ])('answers null for %s', async (_case, listing, search) => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    graph({ [`${BASE}/root:/Docs:/children`]: listing, search })
    expect(await ask('wombat', 'Docs')).toBeNull()
  })
})

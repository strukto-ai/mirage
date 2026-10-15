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
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'

const API = 'https://graph.microsoft.com/v1.0'
const DRIVE = `${API}/drives/b!drive`
const DOWNLOAD = 'https://download.test/a.bin'

// A scoped mount resolves its site and drive once, then addresses the item.
// Routes by URL without its query and logs each call's URL, Authorization and
// Range; an unrouted URL throws, so a request the read should not make fails.
function routed(routes: Record<string, () => Response>) {
  const calls: [string, string | undefined, string | undefined][] = []
  const all: Record<string, () => Response> = {
    [`${API}/sites`]: () =>
      new Response(JSON.stringify({ value: [{ id: 'site', name: 'team', displayName: 'Team' }] })),
    [`${API}/sites/site/drives`]: () =>
      new Response(JSON.stringify({ value: [{ id: 'b!drive', name: 'Documents' }] })),
    ...routes,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input).split('?')[0] ?? ''
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push([url, headers.Authorization, headers.Range])
      const route = all[url]
      if (route === undefined) throw new Error(`unrouted ${url}`)
      return Promise.resolve(route())
    }),
  )
  return calls
}

function itemJson(item: string, download: string | null = DOWNLOAD): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: item,
        cTag: 'ctag-1',
        versions: [{ id: 'v1', lastModifiedDateTime: '2026-01-01T00:00:00Z' }],
        ...(download === null ? {} : { '@microsoft.graph.downloadUrl': download }),
      }),
    )
}

const scoped = (): SharePointAccessor =>
  new SharePointAccessor({ accessToken: 'token', site: 'Team', drive: 'Documents' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an unrecorded SharePoint read', () => {
  const ITEM = `${DRIVE}/root:/a.bin`
  const path = new PathSpec({ virtual: '/sp/a.bin', directory: '/sp/', vfsPath: 'a.bin' })

  it('fetches the item, then its download URL without the bearer token', async () => {
    const calls = routed({
      [ITEM]: itemJson('i'),
      [DOWNLOAD]: () => new Response(new Uint8Array([1, 2, 3])),
    })
    expect([...(await read(scoped(), path))]).toEqual([1, 2, 3])
    expect(calls.slice(2).map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [DOWNLOAD, undefined],
    ])
  })

  it('falls back to /content when Graph omits the download URL', async () => {
    const content = `${ITEM}:/content`
    const calls = routed({
      [ITEM]: itemJson('i', null),
      [content]: () => new Response(new Uint8Array([4, 5])),
    })
    expect([...(await read(scoped(), path))]).toEqual([4, 5])
    expect(calls.slice(2).map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [content, 'Bearer token'],
    ])
  })

  it('reports ENOENT with the virtual path when the item is missing', async () => {
    routed({
      [ITEM]: () =>
        new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
          status: 404,
        }),
    })
    const error: unknown = await read(scoped(), path).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'ENOENT' })
    expect((error as Error).message).toContain('/sp/a.bin')
  })

  it('sends a window to the download URL', async () => {
    const calls = routed({
      [ITEM]: itemJson('i'),
      [DOWNLOAD]: () => new Response(new TextEncoder().encode('llo'), { status: 206 }),
    })
    const data = await read(scoped(), path, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(data)).toBe('llo')
    expect(calls.at(-1)).toEqual([DOWNLOAD, undefined, 'bytes=2-4'])
  })
})

describe('a recorded SharePoint read', () => {
  it('records the virtual path of a key named like its mount', async () => {
    routed({
      [`${DRIVE}/root:/m/k.txt`]: itemJson('i'),
      [DOWNLOAD]: () => new Response(new Uint8Array([1, 2, 3])),
    })
    const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    const [data, records] = await runWithRecording(() => read(scoped(), spec))
    expect([...data]).toEqual([1, 2, 3])
    expect(records).toMatchObject([{ op: 'read', path: '/m/m/k.txt', source: 'sharepoint' }])
  })
})

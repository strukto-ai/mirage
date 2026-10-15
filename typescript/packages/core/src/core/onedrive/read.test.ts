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
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'

const ITEM = 'https://graph.microsoft.com/v1.0/me/drive/root:/a.bin'
const DOWNLOAD = 'https://download.test/a.bin'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

// Routes by URL without its query and logs each call's URL, Authorization and
// Range; an unrouted URL throws, so a request the read should not make fails.
function routed(routes: Record<string, () => Response>) {
  const calls: [string, string | undefined, string | undefined][] = []
  const fetchMock = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
    const url = requestUrl(input).split('?')[0] ?? ''
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push([url, headers.Authorization, headers.Range])
    const route = routes[url]
    if (route === undefined) throw new Error(`unrouted ${url}`)
    return Promise.resolve(route())
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function itemJson(download: string | null = DOWNLOAD): Response {
  return new Response(
    JSON.stringify({
      id: 'item',
      cTag: 'ctag-1',
      versions: [{ id: 'v1', lastModifiedDateTime: '2026-01-01T00:00:00Z' }],
      ...(download === null ? {} : { '@microsoft.graph.downloadUrl': download }),
    }),
    { status: 200 },
  )
}

const bytes =
  (...values: number[]) =>
  (): Response =>
    new Response(new Uint8Array(values), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an unrecorded OneDrive read', () => {
  const path = PathSpec.fromStrPath('/od/a.bin', 'a.bin')
  const accessor = (): OneDriveAccessor => new OneDriveAccessor({ accessToken: 'token' })

  it('fetches the item, then its download URL without the bearer token', async () => {
    const calls = routed({ [ITEM]: () => itemJson(), [DOWNLOAD]: bytes(1, 2, 3) })
    expect([...(await read(accessor(), path))]).toEqual([1, 2, 3])
    // The token comes first, so a write between the two requests can only
    // make the cached bytes look stale.
    expect(calls.map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [DOWNLOAD, undefined],
    ])
  })

  it('falls back to /content when Graph omits the download URL', async () => {
    const calls = routed({ [ITEM]: () => itemJson(null), [`${ITEM}:/content`]: bytes(4, 5) })
    expect([...(await read(accessor(), path))]).toEqual([4, 5])
    expect(calls.map(([url, auth]) => [url, auth])).toEqual([
      [ITEM, 'Bearer token'],
      [`${ITEM}:/content`, 'Bearer token'],
    ])
  })

  it('reports ENOENT with the virtual path when the item is missing', async () => {
    routed({
      [ITEM]: () =>
        new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
          status: 404,
        }),
    })
    const error: unknown = await read(accessor(), path).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'ENOENT' })
    expect((error as Error).message).toContain('/od/a.bin')
  })

  it('sends a window to the download URL and slices a 200 answer locally', async () => {
    const calls = routed({
      [ITEM]: () => itemJson(),
      [DOWNLOAD]: () => new Response(new TextEncoder().encode('hello'), { status: 200 }),
    })
    const data = await read(accessor(), path, { offset: 2, size: 3 })
    expect(new TextDecoder().decode(data)).toBe('llo')
    expect(calls[1]).toEqual([DOWNLOAD, undefined, 'bytes=2-4'])
  })
})

describe('a recorded OneDrive read', () => {
  it('records the version the bytes came from, under the virtual path', async () => {
    // A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
    const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
    routed({
      'https://graph.microsoft.com/v1.0/me/drive/root:/m/k.txt': () => itemJson(),
      [DOWNLOAD]: bytes(1, 2, 3),
    })
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [data, records] = await runWithRecording(() => read(accessor, spec))
    expect([...data]).toEqual([1, 2, 3])
    expect(records).toMatchObject([
      { op: 'read', path: '/m/m/k.txt', source: 'onedrive', fingerprint: 'ctag-1', revision: 'v1' },
    ])
  })
})

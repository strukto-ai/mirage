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
import { liveIdentity } from './identity.ts'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function accessor(): SharePointAccessor {
  return new SharePointAccessor({ accessToken: 'tok' })
}

// The site and drive lookups always land on the same two entries; only
// the eventual item GET differs per test.
function namespaceFetch(itemResponse: () => Response): ReturnType<typeof vi.fn> {
  return vi.fn((input: URL | RequestInfo) => {
    const url = requestUrl(input)
    if (url.includes('/sites?')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: [{ id: 'site-id', displayName: 'Engineering', name: 'eng' }] }),
          { status: 200 },
        ),
      )
    }
    if (url.includes('/drives?') || url.endsWith('/drives')) {
      return Promise.resolve(
        new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
          status: 200,
        }),
      )
    }
    return Promise.resolve(itemResponse())
  })
}

describe('SharePoint identity', () => {
  it('returns the cTag fingerprint with no revision', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(
        () =>
          new Response(
            JSON.stringify({ id: '01ITEM', name: 'report.docx', cTag: 'ctag-abc', file: {} }),
            { status: 200 },
          ),
      ),
    )
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath(
        '/sp/Engineering/Documents/report.docx',
        'Engineering/Documents/report.docx',
      ),
    )
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-abc')
    expect(result.revision).toBeNull()
  })

  it('reports exists false on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(
        () =>
          new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
            status: 404,
          }),
      ),
    )
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/sp/Engineering/Documents/nope.txt', 'Engineering/Documents/nope.txt'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('raises EISDIR for a folder item', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(
        () =>
          new Response(JSON.stringify({ id: '02FOLDER', name: 'src', folder: { childCount: 2 } }), {
            status: 200,
          }),
      ),
    )
    await expect(
      liveIdentity(
        accessor(),
        PathSpec.fromStrPath('/sp/Engineering/Documents/src', 'Engineering/Documents/src'),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR at the site level', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(() => new Response('{}', { status: 200 })),
    )
    await expect(
      liveIdentity(accessor(), PathSpec.fromStrPath('/sp/Engineering', 'Engineering')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR at the drive level', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(() => new Response('{}', { status: 200 })),
    )
    await expect(
      liveIdentity(
        accessor(),
        PathSpec.fromStrPath('/sp/Engineering/Documents', 'Engineering/Documents'),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR for a folder spelled with a trailing slash', async () => {
    // Graph is item-addressed off the slashless resourcePath, so the
    // hint costs nothing: the folder facet on the answer is what refuses
    // it, the same as without the slash.
    vi.stubGlobal(
      'fetch',
      namespaceFetch(
        () =>
          new Response(JSON.stringify({ id: '02FOLDER', name: 'src', folder: { childCount: 2 } }), {
            status: 200,
          }),
      ),
    )
    await expect(
      liveIdentity(
        accessor(),
        PathSpec.fromStrPath('/sp/Engineering/Documents/src/', 'Engineering/Documents/src'),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reports exists false for an absent path spelled with a trailing slash', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(
        () =>
          new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
            status: 404,
          }),
      ),
    )
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/sp/Engineering/Documents/nope/', 'Engineering/Documents/nope'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })
})

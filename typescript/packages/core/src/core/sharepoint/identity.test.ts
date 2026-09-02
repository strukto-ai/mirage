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

interface NamespaceRows {
  sites?: Record<string, unknown>[]
  drives?: Record<string, unknown>[]
}

// The site and drive lookups always land on the same two entries unless
// a test says otherwise; only the eventual item GET differs per test.
function namespaceFetch(
  itemResponse: (url: string) => Response,
  rows: NamespaceRows = {},
): ReturnType<typeof vi.fn> {
  const sites = rows.sites ?? [{ id: 'site-id', displayName: 'Engineering', name: 'eng' }]
  const drives = rows.drives ?? [{ id: 'drive-id', name: 'Documents' }]
  return vi.fn((input: URL | RequestInfo) => {
    const url = requestUrl(input)
    if (url.includes('/sites?')) {
      return Promise.resolve(new Response(JSON.stringify({ value: sites }), { status: 200 }))
    }
    if (url.includes('/drives?') || url.endsWith('/drives')) {
      return Promise.resolve(new Response(JSON.stringify({ value: drives }), { status: 200 }))
    }
    return Promise.resolve(itemResponse(url))
  })
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
    status: 404,
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

  it('reports exists false when the site is gone', async () => {
    // Absence is a value the caller branches on, so which component of
    // the path went missing must not change the shape of the answer.
    vi.stubGlobal(
      'fetch',
      namespaceFetch(() => notFound(), { sites: [] }),
    )
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/sp/Gone/Documents/report.docx', 'Gone/Documents/report.docx'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('reports exists false when the drive is gone', async () => {
    vi.stubGlobal(
      'fetch',
      namespaceFetch(() => notFound(), { drives: [] }),
    )
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/sp/Engineering/Gone/report.docx', 'Engineering/Gone/report.docx'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('ignores a memoized drive id after a delete and recreate', async () => {
    // The memo is what freshness has to defeat here: an ordinary read
    // warms `Documents` -> the old drive id, the drive is then deleted
    // and recreated under the same name, and a memoized resolve would
    // GET the drive that is gone and report exists=false for a file
    // that is there.
    const path = PathSpec.fromStrPath(
      '/sp/Engineering/Documents/report.docx',
      'Engineering/Documents/report.docx',
    )
    const sp = accessor()
    vi.stubGlobal(
      'fetch',
      namespaceFetch(() => notFound(), { drives: [{ id: 'drive-old', name: 'Documents' }] }),
    )
    expect((await sp.resolve(path.resourcePath)).driveId).toBe('drive-old')

    vi.stubGlobal(
      'fetch',
      namespaceFetch((url) =>
        url.includes('drive-old')
          ? notFound()
          : new Response(
              JSON.stringify({ id: '01ITEM', name: 'report.docx', cTag: 'ctag-new', file: {} }),
              { status: 200 },
            ),
      ),
    )
    const result = await liveIdentity(sp, path)
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-new')
  })

  it('reports a site that vanished from the listing, memo or not', async () => {
    // A relist that merges into the memo is not enough on its own: the
    // entry for a name that is gone survives the merge, so the answer
    // has to come from the listing rather than from the memo.
    const path = PathSpec.fromStrPath(
      '/sp/Engineering/Documents/report.docx',
      'Engineering/Documents/report.docx',
    )
    const sp = accessor()
    const item = (): Response =>
      new Response(
        JSON.stringify({ id: '01ITEM', name: 'report.docx', cTag: 'ctag-abc', file: {} }),
        { status: 200 },
      )
    vi.stubGlobal('fetch', namespaceFetch(item))
    expect((await sp.resolve(path.resourcePath)).siteId).toBe('site-id')

    // The item still answers, so a memo-served resolve would report the
    // file as present: only reading the live listing gets this right.
    vi.stubGlobal('fetch', namespaceFetch(item, { sites: [] }))
    expect((await liveIdentity(sp, path)).exists).toBe(false)
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

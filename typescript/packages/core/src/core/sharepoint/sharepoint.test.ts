import { afterEach, describe, expect, it, vi } from 'vitest'

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { find, read, readdir } from './index.ts'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint namespace listings', () => {
  it('stamps site and drive entries with the mount prefix in output and index keys', async () => {
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      const url = requestUrl(input)
      if (url.includes('/sites?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
          status: 200,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/sp', '')
    const site = PathSpec.fromStrPath('/sp/Team', 'Team')

    expect(await readdir(accessor, root, index)).toEqual(['/sp/Team'])
    expect((await index.listDir('/sp')).entries).toEqual(['/sp/Team'])
    expect(await readdir(accessor, site, index)).toEqual(['/sp/Team/Documents'])
    expect((await index.listDir('/sp/Team')).entries).toEqual(['/sp/Team/Documents'])
  })
})

// The site and library levels of an unscoped mount carry no driveId, so find
// has to walk them itself; delegating straight to findItems returned nothing
// for the whole tree.
function namespaceFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: URL | RequestInfo) => {
    const url = requestUrl(input)
    if (url.includes('/sites?')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
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
    if (url.includes('/root/children') || url.includes('/root:/')) {
      const nested = url.includes('sub')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            value: nested
              ? []
              : [
                  { id: '1', name: 'a.txt', size: 10 },
                  { id: '2', name: 'sub', folder: { childCount: 0 } },
                ],
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

describe('SharePoint unscoped find', () => {
  it('walks sites and libraries from the mount root', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp', ''))).toEqual([
      '/',
      '/Team',
      '/Team/Documents',
      '/Team/Documents/a.txt',
      '/Team/Documents/sub',
    ])
  })

  it('counts depth from the real start path', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp', ''), { maxDepth: 1 })).toEqual([
      '/',
      '/Team',
    ])
  })

  it('walks libraries from a site directory', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp/Team', 'Team'), { type: 'f' })).toEqual([
      '/Team/Documents/a.txt',
    ])
  })
})

// The dispatcher's fresh substitute empties the index, but the site and
// drive ids are remembered on the accessor, not in the index. After a
// delete-and-recreate the memo names a drive that is gone, so a read
// that trusted it would answer ENOENT for a file that is there. The
// marked store is what tells the read to relist.
function driveFetch(driveId: string, body: string | null): ReturnType<typeof vi.fn> {
  return vi.fn((input: URL | RequestInfo) => {
    const url = requestUrl(input)
    if (url.includes('/sites?')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
          { status: 200 },
        ),
      )
    }
    if (url.includes('/drives?') || url.endsWith('/drives')) {
      return Promise.resolve(
        new Response(JSON.stringify({ value: [{ id: driveId, name: 'Documents' }] }), {
          status: 200,
        }),
      )
    }
    if (body !== null && url.includes(driveId)) {
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'no' } }), {
        status: 404,
      }),
    )
  })
}

describe('SharePoint read freshness', () => {
  const path = PathSpec.fromStrPath('/sp/Team/Documents/a.txt', 'Team/Documents/a.txt')

  it('relists the drive when the index is marked fresh', async () => {
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    vi.stubGlobal('fetch', driveFetch('drive-old', null))
    expect((await accessor.resolve(path.resourcePath)).driveId).toBe('drive-old')

    vi.stubGlobal('fetch', driveFetch('drive-new', 'new content'))
    const data = await read(accessor, path, new RAMIndexCacheStore({ fresh: true }))
    expect(new TextDecoder().decode(data)).toBe('new content')
  })

  it('still answers from the memo on an ordinary read', async () => {
    // The relist is the fresh path's price, not everyone's: an
    // ordinary read makes no namespace call at all.
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    vi.stubGlobal('fetch', driveFetch('drive-old', 'old content'))
    expect((await accessor.resolve(path.resourcePath)).driveId).toBe('drive-old')

    const fetchMock = driveFetch('drive-old', 'old content')
    vi.stubGlobal('fetch', fetchMock)
    const data = await read(accessor, path, new RAMIndexCacheStore())
    expect(new TextDecoder().decode(data)).toBe('old content')
    const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0] as RequestInfo))
    expect(urls.some((u) => u.includes('/sites?') || u.endsWith('/drives'))).toBe(false)
  })
})

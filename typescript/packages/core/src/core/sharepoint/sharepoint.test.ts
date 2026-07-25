import { afterEach, describe, expect, it, vi } from 'vitest'

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { find, readdir } from './index.ts'

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

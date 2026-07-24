import { afterEach, describe, expect, it, vi } from 'vitest'

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { readdir } from './index.ts'

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

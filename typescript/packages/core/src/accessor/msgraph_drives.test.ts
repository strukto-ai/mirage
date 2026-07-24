import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor, oneDriveItemUrl } from './onedrive.ts'
import { SharePointAccessor } from './sharepoint.ts'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive addressing', () => {
  it('applies keyPrefix to root and nested item URLs', () => {
    const accessor = new OneDriveAccessor({
      accessToken: 'token',
      driveId: 'drive',
      keyPrefix: '/team docs/',
    })

    expect(oneDriveItemUrl(accessor.config, '')).toBe(
      'https://graph.microsoft.com/v1.0/drives/drive/root:/team%20docs',
    )
    expect(oneDriveItemUrl(accessor.config, 'a b.txt', '/content')).toBe(
      'https://graph.microsoft.com/v1.0/drives/drive/root:/team%20docs/a%20b.txt:/content',
    )
  })
})

describe('SharePoint resolution', () => {
  it('resolves site and drive namespace levels before drive items', async () => {
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

    expect(await accessor.resolve('')).toMatchObject({ level: 'root' })
    expect(await accessor.resolve('Team')).toMatchObject({ level: 'site', siteId: 'site-id' })
    expect(await accessor.resolve('Team/Documents')).toMatchObject({
      level: 'drive',
      driveId: 'drive-id',
    })
    expect(await accessor.resolve('Team/Documents/report.txt')).toMatchObject({
      level: 'item',
      driveId: 'drive-id',
      itemPath: 'report.txt',
    })
  })

  it('scopes a configured site, drive, and keyPrefix out of the virtual path', async () => {
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
    const accessor = new SharePointAccessor({
      accessToken: 'token',
      site: 'Team',
      drive: 'Documents',
      keyPrefix: 'Reports',
    })

    expect(await accessor.resolve('2026/q1.txt')).toMatchObject({
      level: 'item',
      itemPath: 'Reports/2026/q1.txt',
    })
  })
})

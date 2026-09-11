import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizeOneDriveConfig,
  OneDriveAccessor,
  oneDriveBase,
  oneDriveItemUrl,
  oneDriveRefPath,
  redactOneDriveConfig,
} from './onedrive.ts'
import {
  normalizeSharePointConfig,
  redactSharePointConfig,
  SharePointAccessor,
} from './sharepoint.ts'

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

  it('addresses a group drive and a user drive', () => {
    const group = new OneDriveAccessor({ accessToken: 'token', groupId: 'grp123' })
    expect(oneDriveBase(group.config)).toBe('https://graph.microsoft.com/v1.0/groups/grp123/drive')
    const user = new OneDriveAccessor({ accessToken: 'token', userId: 'usr@example.com' })
    expect(oneDriveBase(user.config)).toBe(
      'https://graph.microsoft.com/v1.0/users/usr%40example.com/drive',
    )
  })

  it('lets graphBaseUrl replace the service root', () => {
    // How a mount reaches a sovereign cloud, a private endpoint, or a test
    // server. The trailing slash must not survive into the URL.
    const accessor = new OneDriveAccessor({
      accessToken: 'token',
      graphBaseUrl: 'http://127.0.0.1:8080/v1.0/',
    })
    expect(oneDriveBase(accessor.config)).toBe('http://127.0.0.1:8080/v1.0/me/drive')
    // ref paths are Graph-root-relative, so they must be the base stripped
    // off, never a hardcoded host stripped off.
    const scoped = new OneDriveAccessor({
      accessToken: 'token',
      driveId: 'drive',
      graphBaseUrl: 'http://127.0.0.1:8080/v1.0',
    })
    expect(oneDriveRefPath(scoped.config, 'sub/dir')).toBe('/drives/drive/root:/sub/dir')
  })

  it('rejects two drive targets', () => {
    // A fixed precedence would silently address one and ignore the other.
    expect(() => new OneDriveAccessor({ accessToken: 'token', driveId: 'd', siteId: 's' })).toThrow(
      /names 2 drives \(driveId, siteId\)/,
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

describe('Microsoft Graph config schema', () => {
  it('accepts a provider callable for accessToken and keeps it secret', () => {
    const provider = () => 'minted'
    const config = normalizeOneDriveConfig({ access_token: provider, drive_id: 'drive' })

    expect(config.accessToken).toBe(provider)
    expect(redactOneDriveConfig(config)).toEqual({
      accessToken: '<REDACTED>',
      driveId: 'drive',
    })
  })

  it('camelCases snake_case input and rejects a wrong-typed field', () => {
    expect(normalizeSharePointConfig({ access_token: 't', site_filter: 'Team' })).toEqual({
      accessToken: 't',
      siteFilter: 'Team',
    })
    expect(() => normalizeSharePointConfig({ access_token: 't', max_retries: 'many' })).toThrow()
    expect(() => normalizeSharePointConfig({ site: 'Team' })).toThrow()
  })

  it('redacts the token whether it is a literal or a provider', () => {
    expect(redactSharePointConfig({ accessToken: 'literal', site: 'Team' })).toEqual({
      accessToken: '<REDACTED>',
      site: 'Team',
    })
    expect(redactSharePointConfig({ accessToken: () => 'minted' })).toEqual({
      accessToken: '<REDACTED>',
    })
  })
})

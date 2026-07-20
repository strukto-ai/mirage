import { PathSpec } from '@struktoai/mirage-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { searchFiles, supportsQuery } from './search/index.ts'
import { SEARCH_PAGE_SIZE } from './search/constants.ts'
import { globToLike, requestBody } from './search/query.ts'
import { relativePath, searchTarget } from './search/target.ts'

function multistatus(paths: { href: string; directory?: boolean }[]): string {
  const responses = paths
    .map(({ href, directory }) => {
      const name = href.replace(/\/+$/, '').split('/').pop() ?? ''
      const resourceType = directory === true ? '<d:collection/>' : ''
      return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype>${resourceType}</d:resourcetype><d:getcontentlength>42</d:getcontentlength><oc:size>42</oc:size><d:getlastmodified>Sat, 11 Jul 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    })
    .join('')
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses}</d:multistatus>`
}

function accessor(): NextcloudAccessor {
  return new NextcloudAccessor({
    url: 'https://cloud.example/remote.php/dav/files/user/',
    username: 'alice',
    password: 'secret',
  })
}

function requiredTarget(url: string) {
  const target = searchTarget(url)
  if (target === null) throw new Error(`expected a Nextcloud Files Search target for ${url}`)
  return target
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Nextcloud Files Search query', () => {
  it('preserves a webroot and configured subroot', () => {
    expect(
      searchTarget('https://cloud.example/nextcloud/remote.php/dav/files/alice/team%20docs/'),
    ).toEqual({
      endpoint: 'https://cloud.example/nextcloud/remote.php/dav/',
      resourceScope: '/files/alice/team docs',
    })
    expect(searchTarget('https://cloud.example/webdav/')).toBeNull()
  })

  it('preserves literal percent signs when rebasing results', () => {
    const target = requiredTarget(
      'https://cloud.example/nextcloud/remote.php/dav/files/alice/team%2520docs/',
    )
    expect(
      relativePath('/nextcloud/remote.php/dav/files/alice/team%2520docs/report.pdf', target),
    ).toBe('/report.pdf')
  })

  it('escapes scopes and compiles only fully representable predicates', () => {
    const target = requiredTarget('https://cloud.example/remote.php/dav/files/alice/team%20docs/')
    const body = requestBody(
      target,
      PathSpec.fromStrPath('/My Documents/税 & VAT'),
      { tree: { op: 'name', pattern: 'Invoices', icase: false } },
      0,
    )
    expect(body).toContain('/files/alice/team docs/My Documents/税 &amp; VAT')
    expect(
      supportsQuery({
        tree: {
          op: 'or',
          kids: [
            { op: 'name', pattern: '*.pdf', icase: false },
            { op: 'path', pattern: '*/deep/*' },
          ],
        },
      }),
    ).toBe(false)
    expect(
      supportsQuery({
        tree: {
          op: 'or',
          kids: [
            { op: 'name', pattern: '*.pdf', icase: false },
            { op: 'not', kid: { op: 'type', kind: 'd' } },
          ],
        },
      }),
    ).toBe(true)
  })

  it('broadens SQL wildcard and backslash literals safely', () => {
    expect(globToLike('a_b%\\c?*')).toBe('a_b%%c_%')
  })
})

describe('Nextcloud Files Search transport', () => {
  it('authenticates, paginates, and parses metadata', async () => {
    const first = Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) => ({
      href: `/remote.php/dav/files/user/Accounting/item-${String(index)}.pdf`,
    }))
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(multistatus(first), { status: 207 }))
      .mockResolvedValueOnce(
        new Response(
          multistatus([{ href: '/files/user/Accounting/final%20invoice.pdf', directory: true }]),
          { status: 207 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const entries = await searchFiles(accessor(), PathSpec.fromStrPath('/Accounting'), {
      tree: {
        op: 'and',
        kids: [
          { op: 'name', pattern: '*.pdf', icase: false },
          { op: 'type', kind: 'd' },
        ],
      },
      size: { lower: 10, upper: 100 },
      modified: { lower: 1000.75, upper: 2000.25 },
    })

    expect(entries).toHaveLength(SEARCH_PAGE_SIZE + 1)
    expect(entries?.at(-1)).toMatchObject({
      key: '/Accounting/final invoice.pdf',
      kind: 'd',
      size: 42,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstInit = fetchMock.mock.calls[0]?.[1]
    const secondInit = fetchMock.mock.calls[1]?.[1]
    const firstBody = firstInit?.body
    const secondBody = secondInit?.body
    if (typeof firstBody !== 'string' || typeof secondBody !== 'string') {
      throw new TypeError('SEARCH request body must be a string')
    }
    expect(firstInit?.method).toBe('SEARCH')
    expect((firstInit?.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    expect(firstBody).toContain('<sd:firstresult>0</sd:firstresult>')
    expect(secondBody).toContain(`<sd:firstresult>${String(SEARCH_PAGE_SIZE)}</sd:firstresult>`)
  })

  it.each([404, 405, 501])('falls back when SEARCH returns HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })))
    await expect(
      searchFiles(accessor(), PathSpec.fromStrPath('/Documents'), {
        tree: { op: 'name', pattern: 'Invoices', icase: false },
      }),
    ).resolves.toBeNull()
  })

  it('accepts an empty multistatus page', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 })),
    )
    await expect(
      searchFiles(accessor(), PathSpec.fromStrPath('/Documents'), {
        tree: { op: 'name', pattern: 'Documents', icase: false },
      }),
    ).resolves.toEqual([])
  })

  it('rejects malformed and out-of-scope responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<not-xml', { status: 207 }))
      .mockResolvedValueOnce(
        new Response(multistatus([{ href: '/files/other/Documents/Invoices' }]), { status: 207 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const query = { tree: { op: 'name', pattern: 'Invoices', icase: false } as const }
    await expect(
      searchFiles(accessor(), PathSpec.fromStrPath('/Documents'), query),
    ).rejects.toThrow('invalid Nextcloud Files Search XML')
    await expect(
      searchFiles(accessor(), PathSpec.fromStrPath('/Documents'), query),
    ).rejects.toThrow('out-of-scope href')
  })
})

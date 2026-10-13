import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { searchFiles } from './search/index.ts'
import { SEARCH_PAGE_SIZE } from './search/constants.ts'
import { requestBody } from './search/query.ts'
import { relativePath, searchTarget } from './search/target.ts'

function multistatus(paths: { href: string; directory?: boolean }[]): string {
  const responses = paths
    .map(({ href, directory }) => {
      const folder = directory === true
      const resourceType = folder ? '<d:collection/>' : ''
      const length = folder ? '' : '<d:getcontentlength>42</d:getcontentlength>'
      return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${resourceType}</d:resourcetype>${length}<d:getlastmodified>Sat, 11 Jul 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
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

describe('Nextcloud Files Search request', () => {
  it('preserves a webroot and configured subroot', () => {
    expect(
      searchTarget('https://cloud.example/nextcloud/remote.php/dav/files/alice/team%20docs/'),
    ).toEqual({
      endpoint: 'https://cloud.example/nextcloud/remote.php/dav/',
      vfsScope: '/files/alice/team docs',
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

  it('escapes the scope and asks for every entry under it', () => {
    const target = requiredTarget('https://cloud.example/remote.php/dav/files/alice/team%20docs/')
    const body = requestBody(target, PathSpec.fromStrPath('/My Documents/税 & VAT'), 0)
    expect(body).toContain('/files/alice/team docs/My Documents/税 &amp; VAT')
    expect(body).toContain(
      '<d:where><d:or><d:is-collection/><d:not><d:is-collection/></d:not></d:or></d:where>',
    )
    expect(body).toContain(`<d:nresults>${String(SEARCH_PAGE_SIZE)}</d:nresults>`)
  })
})

describe('Nextcloud Files Search transport', () => {
  // Mirrors test_search_files_lists_every_entry_a_page_at_a_time.
  it('lists every entry a page at a time', async () => {
    const first = Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) => ({
      href: `/remote.php/dav/files/user/Accounting/item-${String(index)}.pdf`,
    }))
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(multistatus(first), { status: 207 }))
      .mockResolvedValueOnce(
        new Response(
          multistatus([{ href: '/files/user/Accounting/final%20invoices/', directory: true }]),
          { status: 207 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const entries = await searchFiles(accessor(), PathSpec.fromStrPath('/Accounting'))

    expect(entries).toHaveLength(SEARCH_PAGE_SIZE + 1)
    expect(entries?.[0]).toMatchObject({ kind: 'f', size: 42, modified: '2026-07-11T12:00:00Z' })
    expect(entries?.at(-1)).toMatchObject({
      key: '/Accounting/final invoices',
      kind: 'd',
      size: null,
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

  it.each([404, 405, 500, 501])('falls back when SEARCH returns HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })))
    await expect(searchFiles(accessor(), PathSpec.fromStrPath('/Documents'))).resolves.toBeNull()
  })

  it('accepts an empty multistatus page', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 })),
    )
    await expect(searchFiles(accessor(), PathSpec.fromStrPath('/Documents'))).resolves.toEqual([])
  })

  it('rejects malformed and out-of-scope responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<not-xml', { status: 207 }))
      .mockResolvedValueOnce(
        new Response(multistatus([{ href: '/files/other/Documents/Invoices' }]), { status: 207 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchFiles(accessor(), PathSpec.fromStrPath('/Documents'))).rejects.toThrow(
      'invalid Nextcloud Files Search XML',
    )
    await expect(searchFiles(accessor(), PathSpec.fromStrPath('/Documents'))).rejects.toThrow(
      'out-of-scope href',
    )
  })
})

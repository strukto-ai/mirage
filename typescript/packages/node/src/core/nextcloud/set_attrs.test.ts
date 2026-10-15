import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { setAttrs } from './set_attrs.ts'

const FILE = 'https://cloud.example/remote.php/dav/files/user/a.txt'
const MTIME = '2020-01-01T00:00:01.900Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud setAttrs', () => {
  it.each<[string, Record<string, number | string>]>([
    ['200 OK', { uid: 7 }],
    ['403 Forbidden', { uid: 7, mtime: MTIME }],
  ])('sets an mtime in whole seconds (%s)', async (status, residual) => {
    const body =
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>' +
      '<d:href>/remote.php/dav/files/user/a.txt</d:href><d:propstat>' +
      '<d:prop><d:lastmodified/></d:prop>' +
      `<d:status>HTTP/1.1 ${status}</d:status>` +
      '</d:propstat></d:response></d:multistatus>'
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status: 207 })))
    vi.stubGlobal('fetch', fetchMock)
    expect(
      await setAttrs(
        new NextcloudAccessor({ url: 'https://cloud.example/remote.php/dav/files/user/' }),
        PathSpec.fromStrPath('/a.txt'),
        { uid: 7, mtime: MTIME },
      ),
    ).toEqual(residual)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(FILE)
    expect(init.method).toBe('PROPPATCH')
    expect(init.body as string).toContain('<d:lastmodified>1577836801</d:lastmodified>')
  })
})

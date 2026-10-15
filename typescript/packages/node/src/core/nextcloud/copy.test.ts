import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { dirCopy } from './copy.ts'

const ROOT = 'https://cloud.example/remote.php/dav/files/user'

afterEach(() => {
  vi.unstubAllGlobals()
})

const LOCKED_MEMBER =
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>' +
  '<d:href>/remote.php/dav/files/user/c/a.txt</d:href>' +
  '<d:status>HTTP/1.1 423 Locked</d:status></d:response></d:multistatus>'

describe('nextcloud dirCopy', () => {
  it.each<[number, string | null, string | null]>([
    [201, null, null],
    [404, null, 'ENOENT'],
    [207, LOCKED_MEMBER, 'EACCES'],
  ])('is one copy of the whole tree (%d)', async (status, body, code) => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status })))
    vi.stubGlobal('fetch', fetchMock)
    const copying = dirCopy(
      new NextcloudAccessor({ url: `${ROOT}/`, username: 'alice', password: 'secret' }),
      PathSpec.fromStrPath('/a b'),
      PathSpec.fromStrPath('/c'),
    )
    if (code === null) await copying
    else await expect(copying).rejects.toMatchObject({ code })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ROOT}/a%20b/`)
    expect(init.method).toBe('COPY')
    expect(init.headers).toMatchObject({
      Destination: `${ROOT}/c/`,
      Depth: 'infinity',
      Overwrite: 'F',
    })
  })
})

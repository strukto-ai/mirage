import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { capacity } from './capacity.ts'

const ROOT = 'https://cloud.example/remote.php/dav/files/user/'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud capacity', () => {
  it.each<[string, string, CapacityResult]>([
    ['700', '200 OK', { state: CapacityState.QUOTA, total: 1000, used: 300, available: 700 }],
    ['-3', '200 OK', { state: CapacityState.ELASTIC }],
    ['', '404 Not Found', { state: CapacityState.UNKNOWN }],
  ])('takes the quota properties as the capacity (%s)', async (available, status, expected) => {
    const body =
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>' +
      '<d:href>/remote.php/dav/files/user/</d:href><d:propstat><d:prop>' +
      `<d:quota-available-bytes>${available}</d:quota-available-bytes>` +
      '<d:quota-used-bytes>300</d:quota-used-bytes>' +
      `</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>` +
      '</d:response></d:multistatus>'
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status: 207 })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await capacity(new NextcloudAccessor({ url: ROOT }))).toEqual(expected)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ROOT)
    expect(init.method).toBe('PROPFIND')
  })
})

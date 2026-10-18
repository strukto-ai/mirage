import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { capacity } from './capacity.ts'
import { ROOT, answering, multistatus } from '../../../tests/core/nextcloud/mock.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud capacity', () => {
  it.each<[string, string, CapacityResult]>([
    ['700', '200 OK', { state: CapacityState.QUOTA, total: 1000, used: 300, available: 700 }],
    ['-3', '200 OK', { state: CapacityState.ELASTIC }],
    ['', '404 Not Found', { state: CapacityState.UNKNOWN }],
  ])('takes the quota properties as the capacity (%s)', async (available, status, expected) => {
    const fetchMock = answering(
      207,
      multistatus(
        status,
        `<d:quota-available-bytes>${available}</d:quota-available-bytes>` +
          '<d:quota-used-bytes>300</d:quota-used-bytes>',
      ),
    )
    expect(await capacity(new NextcloudAccessor({ url: `${ROOT}/` }))).toEqual(expected)
    const [url, init] = fetchMock.mock.lastCall ?? []
    expect(url).toBe(`${ROOT}/`)
    expect(init?.method).toBe('PROPFIND')
  })
})

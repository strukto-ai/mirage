import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { ROOT, answering, multistatus } from '../../../tests/core/nextcloud/mock.ts'
import { setAttrs } from './set_attrs.ts'

const MTIME = '2020-01-01T00:00:01.900Z'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud setAttrs', () => {
  it.each<[string, Record<string, number | string>]>([
    ['200 OK', { uid: 7 }],
    ['403 Forbidden', { uid: 7, mtime: MTIME }],
  ])('sets an mtime in whole seconds (%s)', async (status, residual) => {
    const fetchMock = answering(207, multistatus(status, '<d:lastmodified/>'))
    expect(
      await setAttrs(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath('/a.txt'), {
        uid: 7,
        mtime: MTIME,
      }),
    ).toEqual(residual)
    const [url, init] = fetchMock.mock.lastCall ?? []
    expect(url).toBe(`${ROOT}/a.txt`)
    expect(init?.method).toBe('PROPPATCH')
    expect(init?.body).toContain('<d:lastmodified>1577836801</d:lastmodified>')
  })
})

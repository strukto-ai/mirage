import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { dirCopy } from './copy.ts'
import { ROOT, answering, multistatus } from '../../../tests/core/nextcloud/mock.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud dirCopy', () => {
  it.each<[number, string | null, string | null]>([
    [201, null, null],
    [404, null, 'ENOENT'],
    [207, multistatus('423 Locked'), 'EACCES'],
  ])('is one copy of the whole tree (%d)', async (status, body, code) => {
    const fetchMock = answering(status, body)
    const copying = dirCopy(
      new NextcloudAccessor({ url: `${ROOT}/`, username: 'alice', password: 'secret' }),
      PathSpec.fromStrPath('/a b'),
      PathSpec.fromStrPath('/c'),
    )
    if (code === null) await copying
    else await expect(copying).rejects.toMatchObject({ code })
    const [url, init] = fetchMock.mock.lastCall ?? []
    expect(url).toBe(`${ROOT}/a%20b/`)
    expect(init?.method).toBe('COPY')
    expect(init?.headers).toMatchObject({
      Destination: `${ROOT}/c/`,
      Depth: 'infinity',
      Overwrite: 'F',
    })
  })
})

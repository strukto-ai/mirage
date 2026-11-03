import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeFolder, ROOT } from '../../../tests/core/nextcloud/mock.ts'
import { rmdir } from './rmdir.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud rmdir', () => {
  it('lists the children and refuses one', async () => {
    const folder = new FakeFolder('dir', ['a.txt'])
    vi.stubGlobal('fetch', folder.fetch)
    await expect(
      rmdir(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath('/dir')),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.exists).toBe(true)
    expect(folder.calls[0]?.headers.Depth).toBe('1')
  })

  it('removes an empty collection', async () => {
    const folder = new FakeFolder('dir')
    vi.stubGlobal('fetch', folder.fetch)
    await rmdir(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath('/dir'))
    expect(folder.exists).toBe(false)
  })
})

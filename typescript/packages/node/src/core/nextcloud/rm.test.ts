import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeFolder, ROOT } from '../../../tests/core/nextcloud/mock.ts'
import { rmR } from './rm.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud rmR', () => {
  it('takes a subtree in one delete', async () => {
    const folder = new FakeFolder('dir', ['a.txt', 'sub/'])
    vi.stubGlobal('fetch', folder.fetch)
    await rmR(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath('/dir'))
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE'])
    expect(folder.calls[0]?.headers.Depth).toBe('0')
  })
})

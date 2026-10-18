import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { mkdir } from './mkdir.ts'
import { FakeNextcloudOperator, installFakeOperator } from '../../../tests/core/nextcloud/mock.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'

function accessorWith(fake: FakeNextcloudOperator): NextcloudAccessor {
  const accessor = new NextcloudAccessor({
    url: 'https://cloud.example/remote.php/dav/files/user/',
  })
  installFakeOperator(accessor, fake)
  return accessor
}

describe('nextcloud rmdir', () => {
  it('removes an empty collection', async () => {
    const fake = new FakeNextcloudOperator()
    const accessor = accessorWith(fake)
    await mkdir(accessor, PathSpec.fromStrPath('/dir'))
    await rmdir(accessor, PathSpec.fromStrPath('/dir'))
    expect(fake.directories.has('dir/')).toBe(false)
  })

  it('refuses a collection holding a file and keeps every key', async () => {
    const fake = new FakeNextcloudOperator({ 'dir/a.txt': 'a', 'keep.txt': 'k' })
    const promise = rmdir(accessorWith(fake), PathSpec.fromStrPath('/dir'))
    await expect(promise).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect([...fake.files.keys()].sort()).toEqual(['dir/a.txt', 'keep.txt'])
  })

  it('refuses a collection holding only a subtree', async () => {
    const fake = new FakeNextcloudOperator({ 'dir/sub/deep.txt': 'd' })
    const promise = rmdir(accessorWith(fake), PathSpec.fromStrPath('/dir'))
    await expect(promise).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect([...fake.files.keys()]).toEqual(['dir/sub/deep.txt'])
  })

  it('rmR still takes the whole subtree', async () => {
    const fake = new FakeNextcloudOperator({ 'dir/a.txt': 'a', 'keep.txt': 'k' })
    await rmR(accessorWith(fake), PathSpec.fromStrPath('/dir'))
    expect([...fake.files.keys()]).toEqual(['keep.txt'])
  })
})

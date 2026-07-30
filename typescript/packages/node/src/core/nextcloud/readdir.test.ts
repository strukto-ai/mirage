import { PathSpec, RAMIndexCacheStore } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import { readdir } from './readdir.ts'

function accessorWith(fake: FakeNextcloudOperator): NextcloudAccessor {
  const accessor = new NextcloudAccessor({
    url: 'https://cloud.example/remote.php/dav/files/user/',
  })
  installFakeOperator(accessor, fake)
  return accessor
}

describe('nextcloud readdir', () => {
  it('indexes listing sizes, 0-byte files included', async () => {
    const accessor = accessorWith(
      new FakeNextcloudOperator({ 'a.txt': 'hello', 'empty.txt': '' }),
    )
    const index = new RAMIndexCacheStore()
    const out = await readdir(accessor, PathSpec.fromStrPath('/'), index)
    expect(out).toEqual(['/a.txt', '/empty.txt'])
    expect((await index.get('/a.txt')).entry?.size).toBe(5)
    expect((await index.get('/empty.txt')).entry?.size).toBe(0)
  })

  it('backfills a lister-omitted size with one stat', async () => {
    const fake = new FakeNextcloudOperator({ 'a.txt': 'hello' })
    const realList = fake.list.bind(fake)
    fake.list = async (path, options) => {
      const entries = await realList(path, options)
      return entries.map((entry) =>
        entry.path() === 'a.txt'
          ? {
              path: entry.path,
              metadata: () => ({
                isDirectory: () => false,
                isFile: () => true,
                contentLength: null,
                etag: null,
                lastModified: null,
              }),
            }
          : entry,
      )
    }
    const accessor = accessorWith(fake)
    const index = new RAMIndexCacheStore()
    await readdir(accessor, PathSpec.fromStrPath('/'), index)
    expect((await index.get('/a.txt')).entry?.size).toBe(5)
  })
})

import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { PathSpec } from '@struktoai/mirage-core/types'
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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

describe('nextcloud readdir', () => {
  it('indexes listing sizes, 0-byte files included', async () => {
    const accessor = accessorWith(new FakeNextcloudOperator({ 'a.txt': 'hello', 'empty.txt': '' }))
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

  it('reports ENOENT for a missing path', async () => {
    const accessor = accessorWith(new FakeNextcloudOperator({ 'data/a.txt': 'a' }))
    await expect(codeOf(readdir(accessor, PathSpec.fromStrPath('/never.txt')))).resolves.toBe(
      'ENOENT',
    )
  })

  it('stats each component of a missing path once', async () => {
    const fake = new FakeNextcloudOperator({ 'data/a.txt': 'a' })
    const asked: string[] = []
    const realStat = fake.stat.bind(fake)
    fake.stat = (key) => {
      asked.push(key)
      return realStat(key)
    }
    await expect(
      codeOf(readdir(accessorWith(fake), PathSpec.fromStrPath('/data/never'))),
    ).resolves.toBe('ENOENT')
    expect(asked).toEqual(['data/never', 'data'])
  })

  it('reports ENOENT for a missing nested path', async () => {
    const accessor = accessorWith(new FakeNextcloudOperator({ 'data/a.txt': 'a' }))
    await expect(codeOf(readdir(accessor, PathSpec.fromStrPath('/nodir/deep')))).resolves.toBe(
      'ENOENT',
    )
  })

  it('reports ENOTDIR below a file', async () => {
    const accessor = accessorWith(new FakeNextcloudOperator({ 'data/a.txt': 'a' }))
    await expect(codeOf(readdir(accessor, PathSpec.fromStrPath('/data/a.txt/x')))).resolves.toBe(
      'ENOTDIR',
    )
  })

  it('does not raise on the mount root of an empty server', async () => {
    const accessor = accessorWith(new FakeNextcloudOperator({}))
    await expect(readdir(accessor, PathSpec.fromStrPath('/'))).resolves.toEqual([])
  })
})

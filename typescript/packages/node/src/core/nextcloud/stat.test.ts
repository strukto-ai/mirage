import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import { stat } from './stat.ts'

describe('nextcloud stat', () => {
  it('asks the server once for a directory and once for a missing path', async () => {
    const fake = new FakeNextcloudOperator({ 'data/file.txt': 'x' })
    const asked: string[] = []
    const realStat = fake.stat.bind(fake)
    fake.stat = (key) => {
      asked.push(key)
      return realStat(key)
    }
    const accessor = new NextcloudAccessor({
      url: 'https://cloud.example/remote.php/dav/files/user/',
    })
    installFakeOperator(accessor, fake)
    const directory = await stat(accessor, PathSpec.fromStrPath('/data'))
    expect(directory.type).toBe(FileType.DIRECTORY)
    await expect(stat(accessor, PathSpec.fromStrPath('/missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(asked).toEqual(['data', 'missing.txt'])
  })
})

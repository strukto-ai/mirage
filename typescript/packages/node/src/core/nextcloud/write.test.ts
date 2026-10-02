import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { settling } from '../../cache/_test_util.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import { write } from './write.ts'

describe('core/nextcloud/write settles', () => {
  it('settles its bytes without a receipt', async () => {
    const fake = new FakeNextcloudOperator()
    const accessor = new NextcloudAccessor({
      url: 'https://cloud.example/remote.php/dav/files/user/',
    })
    installFakeOperator(accessor, fake)
    const manager = await settling(() =>
      write(accessor, PathSpec.fromStrPath('/a.txt'), new TextEncoder().encode('hi')),
    )
    expect([...fake.files.keys()]).toEqual(['a.txt'])
    expect(manager.settled).toEqual([{ path: '/a.txt', data: 'hi', receipt: null, generation: 5 }])
    expect(manager.writes).toEqual([])
  })
})

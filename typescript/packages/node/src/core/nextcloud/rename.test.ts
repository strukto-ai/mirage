import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import { rename } from './rename.ts'

// Which invalidation each end of a rename took, in call order.
class MoveRecorder {
  readonly calls: string[] = []

  invalidateAfterMove(path: PathSpec, folder: boolean): Promise<void> {
    this.calls.push(`${folder ? 'subtree' : 'unlink'} ${path.virtual}`)
    return Promise.resolve()
  }

  invalidateSubtree(path: PathSpec): Promise<void> {
    this.calls.push(`subtree ${path.virtual}`)
    return Promise.resolve()
  }
}

describe('nextcloud rename', () => {
  it('a renamed file still drops both subtrees', async () => {
    // WebDAV MOVE with Overwrite: T replaces anything at dst, a non-empty
    // folder included, and the reply names no kind: both ends keep the
    // subtree even for a file.
    const fake = new FakeNextcloudOperator({ 'old.txt': 'data' })
    const accessor = new NextcloudAccessor({
      url: 'https://cloud.example/remote.php/dav/files/user/',
    })
    installFakeOperator(accessor, fake)
    const recorder = new MoveRecorder()
    await runWithCacheManager(recorder as unknown as CacheInvalidator, async () => {
      await rename(accessor, PathSpec.fromStrPath('/old.txt'), PathSpec.fromStrPath('/new.txt'))
    })
    expect(fake.files.get('new.txt')?.toString()).toBe('data')
    expect(recorder.calls).toEqual(['subtree /new.txt', 'subtree /old.txt'])
  })
})

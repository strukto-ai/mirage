import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { mkdir } from './mkdir.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'

function accessorWith(fake: FakeNextcloudOperator): NextcloudAccessor {
  const accessor = new NextcloudAccessor({
    url: 'https://cloud.example/remote.php/dav/files/user/',
  })
  installFakeOperator(accessor, fake)
  return accessor
}

// Collects the paths each invalidation hook was told about.
class RecordingInvalidator implements CacheInvalidator {
  readonly writes: string[] = []
  readonly unlinks: string[] = []
  readonly subtrees: string[] = []

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    this.unlinks.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  invalidateSubtree(path: string | PathSpec): Promise<void> {
    this.subtrees.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  cachedBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(): Promise<number | null> {
    return Promise.resolve(null)
  }
}

async function record(path: string, parents?: boolean): Promise<RecordingInvalidator> {
  const recorder = new RecordingInvalidator()
  const accessor = accessorWith(new FakeNextcloudOperator())
  await runWithCacheManager(recorder, async () => {
    await mkdir(accessor, PathSpec.fromStrPath(path), parents)
  })
  return recorder
}

describe('nextcloud mkdir', () => {
  it('creates the collection', async () => {
    const fake = new FakeNextcloudOperator()
    await mkdir(accessorWith(fake), PathSpec.fromStrPath('/newdir'))
    expect(fake.directories.has('newdir/')).toBe(true)
  })

  // opendal's createDir is MKCOL over the whole chain either way, so the
  // ancestor walk cannot be gated on `parents`: a bare `mkdir a/b/c`
  // materializes `a` and `a/b` too, and their cached listings hid the new
  // levels until the index TTL expired.
  it('invalidates every ancestor without parents', async () => {
    const recorder = await record('/a/b/c')
    expect(recorder.writes).toEqual(['/a/b/c', '/a/b', '/a'])
  })

  it('invalidates the same chain with parents', async () => {
    const recorder = await record('/a/b/c', true)
    expect(recorder.writes).toEqual(['/a/b/c', '/a/b', '/a'])
  })
})

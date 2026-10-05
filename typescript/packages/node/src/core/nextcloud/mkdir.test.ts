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
  listingTrusted(_folder: string): boolean {
    return false
  }

  probedStat(): null {
    return null
  }

  readonly writes: string[] = []
  ancestors: string[] = []
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

  invalidateAncestors(path: PathSpec): Promise<void> {
    this.ancestors.push(path.virtual)
    return Promise.resolve()
  }

  invalidateSubtree(path: string | PathSpec): Promise<void> {
    this.subtrees.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  cachedBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(): Promise<number | null> {
    return Promise.resolve(null)
  }
}

function refusingCreate(initial: Record<string, string>): FakeNextcloudOperator {
  const fake = new FakeNextcloudOperator(initial)
  fake.createDir = () =>
    Promise.reject(new Error('Unexpected (permanent) at create_dir, status 409'))
  return fake
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

  // opendal's createDir is MKCOL over the whole chain either way, so a bare
  // `mkdir a/b/c` looks `a/b` up first, as mkdir(2) does.
  it('refuses a missing parent without parents', async () => {
    const fake = new FakeNextcloudOperator()
    await expect(mkdir(accessorWith(fake), PathSpec.fromStrPath('/a/b/c'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/a/b/c',
    })
    expect(fake.directories.size).toBe(0)
  })

  it('creates one level without parents', async () => {
    const recorder = new RecordingInvalidator()
    const accessor = accessorWith(new FakeNextcloudOperator({ 'a/b/x': '' }))
    await runWithCacheManager(recorder, () => mkdir(accessor, PathSpec.fromStrPath('/a/b/c')))
    expect(recorder.writes).toEqual(['/a/b/c'])
    expect(recorder.ancestors).toEqual([])
  })

  it('invalidates the same chain with parents', async () => {
    const recorder = await record('/a/b/c', true)
    expect(recorder.writes).toEqual(['/a/b/c'])
    expect(recorder.ancestors).toEqual(['/a/b/c'])
  })

  // MKCOL's 405 on a taken name reads as done; the stat after names it.
  it('refuses a name a file holds', async () => {
    const fake = new FakeNextcloudOperator({ 'mkp/f': 'x' })
    await expect(mkdir(accessorWith(fake), PathSpec.fromStrPath('/mkp/f'))).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  it('answers ENOTDIR under a file', async () => {
    const fake = refusingCreate({ 'mkp/f': 'x' })
    await expect(mkdir(accessorWith(fake), PathSpec.fromStrPath('/mkp/f/g'))).rejects.toMatchObject(
      { code: 'ENOTDIR', virtualPath: '/mkp/f/g' },
    )
  })

  it('names the operand under a deeper file', async () => {
    const fake = new FakeNextcloudOperator({ 'mkp/f': 'x' })
    await expect(
      mkdir(accessorWith(fake), PathSpec.fromStrPath('/mkp/f/g/h')),
    ).rejects.toMatchObject({ code: 'ENOTDIR', virtualPath: '/mkp/f/g/h' })
  })

  it('names the file a -p walk stops at', async () => {
    const fake = refusingCreate({ 'mkp/f': 'x' })
    await expect(
      mkdir(accessorWith(fake), PathSpec.fromStrPath('/mkp/f/g/h'), true),
    ).rejects.toMatchObject({ code: 'ENOTDIR', virtualPath: '/mkp/f' })
  })

  it('keeps a refusal no file explains', async () => {
    const fake = refusingCreate({ 'mkp/x': '' })
    await expect(mkdir(accessorWith(fake), PathSpec.fromStrPath('/mkp/g'))).rejects.toThrow(
      'status 409',
    )
  })

  // A probe that fails after MKCOL landed still leaves no stale listing.
  it('invalidates before the probe after the create', async () => {
    const fake = new FakeNextcloudOperator()
    fake.stat = () => Promise.reject(new Error('Unexpected (temporary) at stat, status 503'))
    const recorder = new RecordingInvalidator()
    await expect(
      runWithCacheManager(recorder, () =>
        mkdir(accessorWith(fake), PathSpec.fromStrPath('/newdir')),
      ),
    ).rejects.toThrow('status 503')
    expect(fake.directories.has('newdir/')).toBe(true)
    expect(recorder.writes).toEqual(['/newdir'])
    expect(recorder.ancestors).toEqual([])
  })
})

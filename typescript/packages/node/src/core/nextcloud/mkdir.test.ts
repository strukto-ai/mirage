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

function refusingCreate(initial: Record<string, string>): FakeNextcloudOperator {
  const fake = new FakeNextcloudOperator(initial)
  fake.createDir = () =>
    Promise.reject(new Error('Unexpected (permanent) at create_dir, status 409'))
  return fake
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
    const fake = new FakeNextcloudOperator({ 'a/b/x': '' })
    await mkdir(accessorWith(fake), PathSpec.fromStrPath('/a/b/c'))
    expect(fake.directories.has('a/b/c/')).toBe(true)
  })

  it('creates the whole chain with parents', async () => {
    const fake = new FakeNextcloudOperator()
    await mkdir(accessorWith(fake), PathSpec.fromStrPath('/a/b/c'), true)
    expect(fake.directories.has('a/b/c/')).toBe(true)
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

  // A probe that fails after MKCOL landed throws, the collection made.
  it('throws a probe that fails after the create', async () => {
    const fake = new FakeNextcloudOperator()
    fake.stat = () => Promise.reject(new Error('Unexpected (temporary) at stat, status 503'))
    await expect(mkdir(accessorWith(fake), PathSpec.fromStrPath('/newdir'))).rejects.toThrow(
      'status 503',
    )
    expect(fake.directories.has('newdir/')).toBe(true)
  })
})

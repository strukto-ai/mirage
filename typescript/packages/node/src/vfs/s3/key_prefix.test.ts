import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { S3VFS } from './s3.ts'
import { installS3Mock, S3MockStore, type S3Mock } from './mock.ts'

const BUCKET = 'prefix-test-bucket'
const PREFIX = 'users/abc/'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function mkPath(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
}

describe('normalizeKeyPrefix', () => {
  it('returns undefined for empty string', () => {
    expect(normalizeKeyPrefix('')).toBeUndefined()
  })

  it('appends trailing slash to prefix without one', () => {
    expect(normalizeKeyPrefix('users/abc')).toBe('users/abc/')
  })

  it('strips leading slash and normalizes trailing slash', () => {
    expect(normalizeKeyPrefix('/users/abc/')).toBe('users/abc/')
  })
})

describe('S3VFS constructor with keyPrefix', () => {
  it('does not set keyPrefix when not provided', () => {
    const res = new S3VFS({ bucket: BUCKET })
    expect(res.config.keyPrefix).toBeUndefined()
  })

  it('normalizes keyPrefix on construction', () => {
    const res = new S3VFS({ bucket: BUCKET, keyPrefix: '/users/abc/' })
    expect(res.config.keyPrefix).toBe('users/abc/')
  })
})

describe('S3VFS operations with keyPrefix (mocked)', () => {
  let vfs: S3VFS
  let mock: S3Mock
  let store: S3MockStore

  beforeAll(() => {
    store = new S3MockStore()
    mock = installS3Mock(store)
    vfs = new S3VFS({ bucket: BUCKET, keyPrefix: PREFIX })
  })

  afterEach(() => {
    store.objects(BUCKET).clear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('write stores object under prefixed bucket key', async () => {
    await vfs.writeFile(mkPath('/b.txt'), ENC.encode('hello'))
    expect(store.has(BUCKET, 'users/abc/b.txt')).toBe(true)
  })

  it('read retrieves content via user path (prefix-free)', async () => {
    store.set(BUCKET, 'users/abc/r.txt', ENC.encode('world'))
    const bytes = await vfs.readFile(mkPath('/r.txt'))
    expect(DEC.decode(bytes)).toBe('world')
  })

  it('stat resolves object under prefixed key', async () => {
    store.set(BUCKET, 'users/abc/s.txt', ENC.encode('sized'))
    const s = await vfs.stat(mkPath('/s.txt'))
    expect(s.size).toBe(5)
  })

  it('exists returns true for prefixed key', async () => {
    store.set(BUCKET, 'users/abc/e.txt', ENC.encode('x'))
    expect(await vfs.exists(mkPath('/e.txt'))).toBe(true)
  })

  it('exists returns false when key not present', async () => {
    expect(await vfs.exists(mkPath('/missing.txt'))).toBe(false)
  })

  it('readdir returns prefix-free user paths and stores under prefixed keys', async () => {
    store.set(BUCKET, 'users/abc/dir/a.txt', ENC.encode('a'))
    store.set(BUCKET, 'users/abc/dir/b.txt', ENC.encode('b'))
    const dirPath = new PathSpec({
      virtual: '/dir/',
      directory: '/dir/',
      vfsPath: 'dir',
    })
    const entries = await vfs.readdir(dirPath)
    for (const entry of entries) {
      expect(entry).not.toContain(PREFIX)
    }
    expect(entries.sort()).toEqual(['/dir/a.txt', '/dir/b.txt'])
  })

  it('glob resolves entries without keyPrefix in returned paths', async () => {
    store.set(BUCKET, 'users/abc/gdir/x.txt', ENC.encode('x'))
    store.set(BUCKET, 'users/abc/gdir/y.md', ENC.encode('y'))
    const globPath = new PathSpec({
      virtual: '/gdir/*.txt',
      directory: '/gdir/',
      pattern: '*.txt',
      resolved: false,
      vfsPath: 'gdir/*.txt',
    })
    const results = await vfs.glob([globPath])
    expect(results.length).toBe(1)
    expect(results[0]?.virtual).toBe('/gdir/x.txt')
    expect(results[0]?.virtual).not.toContain(PREFIX)
  })

  it('copy stores destination under prefixed bucket key', async () => {
    store.set(BUCKET, 'users/abc/src.txt', ENC.encode('copy me'))
    await vfs.copy(mkPath('/src.txt'), mkPath('/dst.txt'))
    expect(store.has(BUCKET, 'users/abc/dst.txt')).toBe(true)
    expect(DEC.decode(store.get(BUCKET, 'users/abc/dst.txt') ?? new Uint8Array())).toBe('copy me')
  })

  it('rename moves object to new prefixed key and removes old', async () => {
    store.set(BUCKET, 'users/abc/mv_src.txt', ENC.encode('moving'))
    await vfs.rename(mkPath('/mv_src.txt'), mkPath('/mv_dst.txt'))
    expect(store.has(BUCKET, 'users/abc/mv_dst.txt')).toBe(true)
    expect(store.has(BUCKET, 'users/abc/mv_src.txt')).toBe(false)
  })

  it('unlink removes object at prefixed key', async () => {
    store.set(BUCKET, 'users/abc/del.txt', ENC.encode('doomed'))
    await vfs.unlink(mkPath('/del.txt'))
    expect(store.has(BUCKET, 'users/abc/del.txt')).toBe(false)
  })
})

describe('S3VFS getState with keyPrefix', () => {
  it('getState config includes keyPrefix value', async () => {
    const res = new S3VFS({ bucket: BUCKET, keyPrefix: 'users/abc/' })
    const state = await res.getState()
    expect(state.config.keyPrefix).toBe('users/abc/')
  })

  it('does not redact keyPrefix', async () => {
    const res = new S3VFS({ bucket: BUCKET, keyPrefix: 'users/abc/' })
    const state = await res.getState()
    expect(state.config.keyPrefix).toBe('users/abc/')
    expect(state.config.keyPrefix).not.toBe('<REDACTED>')
  })
})

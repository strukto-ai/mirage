import { copy as copyCore } from '@struktoai/mirage-core/core/s3/copy'
import { exists as existsCore } from '@struktoai/mirage-core/core/s3/exists'
import { ops } from '@struktoai/mirage-core/test-utils'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { HfModelsAccessor } from '../../accessor/hf_hub.ts'
import { GridFSVFS } from '../gridfs/gridfs.ts'
import { R2VFS } from '../r2/r2.ts'
import { S3VFS } from './s3.ts'
import { installS3Mock, S3MockStore, type S3Mock } from './mock.ts'

const BUCKET = 'prefix-test-bucket'
const PREFIX = 'users/abc/'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function mkPath(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
}

// The one key-prefix rule (core `normalize`) reaches every backend that keys
// objects under a prefix, so one spelling names one prefix whichever backend
// it lands on; an alias reaches it through the S3VFS it builds. A root-spelled
// prefix is no prefix. Mirrors python/tests/utils/test_key_prefix.py.
const PREFIX_SPELLINGS: readonly [string | undefined, string][] = [
  ['/team/x/', 'team/x/'],
  ['team/x', 'team/x/'],
  ['', ''],
  [undefined, ''],
  ['/', ''],
]

const opt = (keyPrefix: string | undefined): { keyPrefix?: string } =>
  keyPrefix === undefined ? {} : { keyPrefix }

const PREFIX_BACKENDS: Record<string, (keyPrefix: string | undefined) => string | undefined> = {
  normalizeKeyPrefix: (p) => normalizeKeyPrefix(p),
  s3: (p) => new S3VFS({ bucket: BUCKET, ...opt(p) }).config.keyPrefix,
  r2: (p) => new R2VFS({ bucket: BUCKET, accountId: 'a', ...opt(p) }).accessor.config.keyPrefix,
  gridfs: (p) => new GridFSVFS({ uri: 'mongodb://h', database: 'd', ...opt(p) }).config.keyPrefix,
  hf_buckets: (p) => new HfBucketsAccessor({ bucket: 'o/b', ...opt(p) }).keyPrefix,
  hf_models: (p) => new HfModelsAccessor({ repoId: 'o/r', ...opt(p) }).keyPrefix,
}

describe('one key prefix rule across backends', () => {
  for (const [name, build] of Object.entries(PREFIX_BACKENDS)) {
    it.each(PREFIX_SPELLINGS)(`${name}: %j -> %j`, (raw, expected) => {
      expect(build(raw) ?? '').toBe(expected)
    })
  }
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
    await ops(vfs).write(mkPath('/b.txt'), ENC.encode('hello'))
    expect(store.has(BUCKET, 'users/abc/b.txt')).toBe(true)
  })

  it('read retrieves content via user path (prefix-free)', async () => {
    store.set(BUCKET, 'users/abc/r.txt', ENC.encode('world'))
    const bytes = await ops(vfs).read(mkPath('/r.txt'))
    expect(DEC.decode(bytes)).toBe('world')
  })

  it('stat resolves object under prefixed key', async () => {
    store.set(BUCKET, 'users/abc/s.txt', ENC.encode('sized'))
    const s = await ops(vfs).stat(mkPath('/s.txt'))
    expect(s.size).toBe(5)
  })

  it('exists returns true for prefixed key', async () => {
    store.set(BUCKET, 'users/abc/e.txt', ENC.encode('x'))
    expect(await existsCore(vfs.accessor, mkPath('/e.txt'))).toBe(true)
  })

  it('exists returns false when key not present', async () => {
    expect(await existsCore(vfs.accessor, mkPath('/missing.txt'))).toBe(false)
  })

  it('readdir returns prefix-free user paths and stores under prefixed keys', async () => {
    store.set(BUCKET, 'users/abc/dir/a.txt', ENC.encode('a'))
    store.set(BUCKET, 'users/abc/dir/b.txt', ENC.encode('b'))
    const dirPath = new PathSpec({
      virtual: '/dir/',
      directory: '/dir/',
      vfsPath: 'dir',
    })
    const entries = await ops(vfs).readdir(dirPath)
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
    const results = await ops(vfs).glob(globPath)
    expect(results.length).toBe(1)
    expect(results[0]?.virtual).toBe('/gdir/x.txt')
    expect(results[0]?.virtual).not.toContain(PREFIX)
  })

  it('copy stores destination under prefixed bucket key', async () => {
    store.set(BUCKET, 'users/abc/src.txt', ENC.encode('copy me'))
    await copyCore(vfs.accessor, mkPath('/src.txt'), mkPath('/dst.txt'))
    expect(store.has(BUCKET, 'users/abc/dst.txt')).toBe(true)
    expect(DEC.decode(store.get(BUCKET, 'users/abc/dst.txt') ?? new Uint8Array())).toBe('copy me')
  })

  it('rename moves object to new prefixed key and removes old', async () => {
    store.set(BUCKET, 'users/abc/mv_src.txt', ENC.encode('moving'))
    await ops(vfs).rename(mkPath('/mv_src.txt'), mkPath('/mv_dst.txt'))
    expect(store.has(BUCKET, 'users/abc/mv_dst.txt')).toBe(true)
    expect(store.has(BUCKET, 'users/abc/mv_src.txt')).toBe(false)
  })

  it('unlink removes object at prefixed key', async () => {
    store.set(BUCKET, 'users/abc/del.txt', ENC.encode('doomed'))
    await ops(vfs).unlink(mkPath('/del.txt'))
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

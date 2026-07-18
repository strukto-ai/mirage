// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import {
  LookupStatus,
  PathSpec,
  RAMIndexCacheStore,
  makeResolveGlob,
  mountKey,
} from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisAccessor } from '../../accessor/redis.ts'
import { RedisStore } from '../../resource/redis/store.ts'
import { appendBytes } from './append.ts'
import { SCOPE_ERROR } from './constants.ts'
import { copy } from './copy.ts'
import { create } from './create.ts'
import { du, duAll } from './du.ts'
import { exists } from './exists.ts'
import { find } from './find.ts'
import { mkdir } from './mkdir.ts'
import { mkdirP } from './mkdir_p.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { rename } from './rename.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { stat } from './stat.ts'
import { stream } from './stream.ts'
import { truncate } from './truncate.ts'
import { unlink } from './unlink.ts'
import { writeBytes } from './write.ts'

const resolveGlob = makeResolveGlob(readdir, SCOPE_ERROR)

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string, prefix = ''): PathSpec {
  return PathSpec.fromStrPath(path, mountKey(path, prefix))
}

describe.skipIf(skip)('core/redis ops', () => {
  let store: RedisStore
  let acc: RedisAccessor
  const prefix = `mirage:fs:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    store = new RedisStore(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    acc = new RedisAccessor(store)
    await store.clear()
    await store.addDir('/')
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('writeBytes + read round-trip', async () => {
    await writeBytes(acc, spec('/hi.txt'), ENC.encode('hello'))
    expect(DEC.decode(await read(acc, spec('/hi.txt')))).toBe('hello')
  })

  it('writeBytes fails when parent is missing', async () => {
    await expect(writeBytes(acc, spec('/missing/x.txt'), ENC.encode('.'))).rejects.toThrow(
      /parent directory does not exist/,
    )
  })

  it('appendBytes creates then extends', async () => {
    await appendBytes(acc, spec('/a.txt'), ENC.encode('foo'))
    await appendBytes(acc, spec('/a.txt'), ENC.encode('bar'))
    expect(DEC.decode(await read(acc, spec('/a.txt')))).toBe('foobar')
  })

  it('create writes empty file', async () => {
    await create(acc, spec('/e.txt'))
    expect((await read(acc, spec('/e.txt'))).byteLength).toBe(0)
  })

  it('exists sees files and dirs', async () => {
    await writeBytes(acc, spec('/f'), ENC.encode('x'))
    await mkdir(acc, spec('/d'))
    expect(await exists(acc, spec('/f'))).toBe(true)
    expect(await exists(acc, spec('/d'))).toBe(true)
    expect(await exists(acc, spec('/nope'))).toBe(false)
  })

  it('mkdir requires existing parent', async () => {
    await expect(mkdir(acc, spec('/foo/bar'))).rejects.toThrow(/parent directory does not exist/)
    await mkdir(acc, spec('/foo'))
    await mkdir(acc, spec('/foo/bar'))
    expect(await exists(acc, spec('/foo/bar'))).toBe(true)
  })

  it('mkdir with parents=true creates chain', async () => {
    await mkdir(acc, spec('/a/b/c'), true)
    expect(await exists(acc, spec('/a/b/c'))).toBe(true)
  })

  it('mkdirP creates chain idempotently', async () => {
    await mkdirP(acc, spec('/x/y'))
    await mkdirP(acc, spec('/x/y'))
    expect(await exists(acc, spec('/x/y'))).toBe(true)
  })

  it('rmdir refuses non-empty and removes empty', async () => {
    await mkdir(acc, spec('/dir'))
    await writeBytes(acc, spec('/dir/f'), ENC.encode('.'))
    await expect(rmdir(acc, spec('/dir'))).rejects.toThrow(/directory not empty/)
    await unlink(acc, spec('/dir/f'))
    await rmdir(acc, spec('/dir'))
    expect(await exists(acc, spec('/dir'))).toBe(false)
  })

  it('rmdir fails on missing dir', async () => {
    await expect(rmdir(acc, spec('/ghost'))).rejects.toThrow(/not a directory/)
  })

  it('unlink removes files', async () => {
    await writeBytes(acc, spec('/f'), ENC.encode('.'))
    await unlink(acc, spec('/f'))
    expect(await exists(acc, spec('/f'))).toBe(false)
  })

  it('rename moves a file + preserves content', async () => {
    await writeBytes(acc, spec('/a'), ENC.encode('data'))
    await rename(acc, spec('/a'), spec('/b'))
    expect(await exists(acc, spec('/a'))).toBe(false)
    expect(DEC.decode(await read(acc, spec('/b')))).toBe('data')
  })

  it('rename moves a dir with nested files', async () => {
    await mkdir(acc, spec('/d1'))
    await writeBytes(acc, spec('/d1/x'), ENC.encode('x'))
    await rename(acc, spec('/d1'), spec('/d2'))
    expect(DEC.decode(await read(acc, spec('/d2/x')))).toBe('x')
  })

  it('copy duplicates contents', async () => {
    await writeBytes(acc, spec('/s'), ENC.encode('hi'))
    await copy(acc, spec('/s'), spec('/t'))
    expect(DEC.decode(await read(acc, spec('/t')))).toBe('hi')
    expect(await exists(acc, spec('/s'))).toBe(true)
  })

  it('truncate shrinks and zero-pads', async () => {
    await writeBytes(acc, spec('/x'), ENC.encode('abcdef'))
    await truncate(acc, spec('/x'), 3)
    expect(DEC.decode(await read(acc, spec('/x')))).toBe('abc')
    await truncate(acc, spec('/x'), 6)
    expect((await read(acc, spec('/x'))).byteLength).toBe(6)
  })

  it('rmR removes dir tree', async () => {
    await mkdir(acc, spec('/t/a'), true)
    await writeBytes(acc, spec('/t/a/f'), ENC.encode('.'))
    await rmR(acc, spec('/t'))
    expect(await exists(acc, spec('/t'))).toBe(false)
  })

  it('du sums file sizes under path', async () => {
    await mkdir(acc, spec('/d'))
    await writeBytes(acc, spec('/d/a'), ENC.encode('abc'))
    await writeBytes(acc, spec('/d/b'), ENC.encode('defg'))
    expect(await du(acc, spec('/d'))).toBe(7)
    const { entries, total } = await duAll(acc, spec('/d'))
    expect(entries).toHaveLength(2)
    expect(total).toBe(7)
  })

  it('readdir returns mount-prefixed entries', async () => {
    await mkdir(acc, spec('/d'))
    await writeBytes(acc, spec('/d/a'), ENC.encode('.'))
    await writeBytes(acc, spec('/d/b'), ENC.encode('.'))
    const entries = await readdir(acc, spec('/mount/d', '/mount'))
    expect(entries).toEqual(['/mount/d/a', '/mount/d/b'])
  })

  it('stat returns file + dir metadata', async () => {
    await writeBytes(acc, spec('/f.txt'), ENC.encode('xyz'))
    const fs = await stat(acc, spec('/f.txt'))
    expect(fs.size).toBe(3)
    await mkdir(acc, spec('/d'))
    const ds = await stat(acc, spec('/d'))
    expect(ds.type).toBe('directory')
  })

  it('find filters by name pattern', async () => {
    await writeBytes(acc, spec('/a.txt'), ENC.encode('.'))
    await writeBytes(acc, spec('/b.md'), ENC.encode('.'))
    const r = await find(acc, spec('/'), { name: '*.txt' })
    expect(r).toEqual(['/a.txt'])
  })

  it('stream yields file contents once', async () => {
    await writeBytes(acc, spec('/f'), ENC.encode('hello'))
    const chunks: Uint8Array[] = []
    for await (const c of stream(acc, spec('/f'))) chunks.push(c)
    expect(chunks).toHaveLength(1)
    const first = chunks[0]
    expect(first).toBeDefined()
    if (first !== undefined) expect(DEC.decode(first)).toBe('hello')
  })

  it('readdir with index populates the cache', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await writeBytes(acc, spec('/a.txt'), ENC.encode('.'))
    await writeBytes(acc, spec('/b.txt'), ENC.encode('.'))
    const entries = await readdir(acc, spec('/data', '/data'), index)
    expect(entries.sort()).toEqual(['/data/a.txt', '/data/b.txt'])
    // readdir stores under the canonical key: no trailing slash except root.
    const cached = await index.listDir('/data')
    expect(cached.status).toBeUndefined()
    expect(cached.entries).toBeDefined()
  })

  it('readdir with index returns cached entries when present', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await writeBytes(acc, spec('/a.txt'), ENC.encode('.'))
    await readdir(acc, spec('/data', '/data'), index)
    // mutate store but cached result should still return
    await writeBytes(acc, spec('/c.txt'), ENC.encode('.'))
    const again = await readdir(acc, spec('/data', '/data'), index)
    expect(again).not.toContain('/data/c.txt')
  })

  it('readdir without index misses stale data (control test)', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await writeBytes(acc, spec('/a.txt'), ENC.encode('.'))
    await readdir(acc, spec('/data', '/data'), index)
    await writeBytes(acc, spec('/c.txt'), ENC.encode('.'))
    const fresh = await readdir(acc, spec('/data', '/data'))
    expect(fresh).toContain('/data/c.txt')
    const evicted = await index.listDir('/data')
    expect(evicted.status !== LookupStatus.NOT_FOUND || evicted.entries === undefined).toBe(true)
  })

  it('resolveGlob expands star patterns', async () => {
    await writeBytes(acc, spec('/a.txt'), ENC.encode('.'))
    await writeBytes(acc, spec('/b.txt'), ENC.encode('.'))
    await writeBytes(acc, spec('/c.md'), ENC.encode('.'))
    const patternSpec = new PathSpec({
      virtual: '/*.txt',
      directory: '/',
      pattern: '*.txt',
      resolved: false,
      resourcePath: '*.txt',
    })
    const expanded = await resolveGlob(acc, [patternSpec])
    const names = expanded.map((p) => p.virtual).sort()
    expect(names).toEqual(['/a.txt', '/b.txt'])
  })
})

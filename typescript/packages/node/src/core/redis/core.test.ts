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

import { makeResolveGlob } from '@struktoai/mirage-core/utils/glob_walk'
import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
import { RedisStore } from '../../vfs/redis/store.ts'
import { copy } from '@struktoai/mirage-core/core/redis/copy'
import { create } from '@struktoai/mirage-core/core/redis/create'
import { exists } from '@struktoai/mirage-core/core/redis/exists'
import { mkdir } from '@struktoai/mirage-core/core/redis/mkdir'
import { read } from '@struktoai/mirage-core/core/redis/read'
import { readdir, tree } from '@struktoai/mirage-core/core/redis/readdir'
import { rename } from '@struktoai/mirage-core/core/redis/rename'
import { rmR } from '@struktoai/mirage-core/core/redis/rm'
import { rmdir } from '@struktoai/mirage-core/core/redis/rmdir'
import { stat } from '@struktoai/mirage-core/core/redis/stat'
import { readStream } from '@struktoai/mirage-core/core/redis/stream'
import { truncate } from '@struktoai/mirage-core/core/redis/truncate'
import { unlink } from '@struktoai/mirage-core/core/redis/unlink'
import { write } from '@struktoai/mirage-core/core/redis/write'

async function listed(accessor: RedisAccessor, path: PathSpec): Promise<string[]> {
  const rows = await readdir(accessor, path)
  const base = (path.pattern !== null ? path.dir : path).virtual.replace(/\/+$/, '')
  return rows.map((row) => `${base}/${row.name}`)
}

const resolveGlob = (accessor: RedisAccessor, paths: PathSpec[]): Promise<PathSpec[]> =>
  makeResolveGlob((path) => listed(accessor, path))(paths)

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string, prefix = ''): PathSpec {
  return PathSpec.fromStrPath(path, mountKey(path, prefix))
}

async function* chunksOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const chunk of chunks) yield ENC.encode(chunk)
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
    await write(acc, spec('/hi.txt'), ENC.encode('hello'))
    expect(DEC.decode(await read(acc, spec('/hi.txt')))).toBe('hello')
  })

  // Each chunk is appended where it lands, so a reader watches a slow
  // program's log grow; another appender's bytes stay; an atomic write
  // shows nothing until it ends whole.
  it('a streamed write shows each chunk as it arrives and keeps other appends', async () => {
    let release = (): void => undefined
    const hold = new Promise<void>((resolve) => (release = resolve))
    async function* quiet(): AsyncIterable<Uint8Array> {
      yield ENC.encode('mine\n')
      await hold
    }
    await write(acc, spec('/log'), ENC.encode('start\n'))
    const writing = write(acc, spec('/log'), quiet(), true)
    let seen: Uint8Array | null = null
    for (let i = 0; i < 100; i++) {
      seen = await store.getFile('/log')
      if (seen !== null && DEC.decode(seen) === 'start\nmine\n') break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(DEC.decode(seen ?? new Uint8Array())).toBe('start\nmine\n')
    await write(acc, spec('/log'), ENC.encode('theirs\n'), true)
    release()
    await writing
    expect(DEC.decode((await store.getFile('/log')) ?? new Uint8Array())).toBe(
      'start\nmine\ntheirs\n',
    )
  })

  // A file another appender creates after the stream found it missing keeps
  // that appender's bytes: the stream creates it with APPEND, not a SET.
  it('writeStream keeps the bytes of a racing create', async () => {
    store.hasFile = async (path: string): Promise<boolean> => {
      await store.appendFile(path, ENC.encode('theirs\n'))
      return false
    }
    await write(acc, spec('/log'), chunksOf('mine\n'), true)
    expect(DEC.decode((await store.getFile('/log')) ?? new Uint8Array())).toBe('theirs\nmine\n')
  })

  // A replacement writes at its own position (SETRANGE): a truncation behind
  // its back leaves a hole up to where it writes next.
  it('writeStream keeps a replacement at its own position', async () => {
    let next = (): void => undefined
    const second = new Promise<void>((resolve) => (next = resolve))
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('a\n')
      await second
      yield ENC.encode('b\n')
    }
    const writing = write(acc, spec('/f'), source())
    for (let i = 0; i < 100; i++) {
      const seen = await store.getFile('/f')
      if (seen !== null && DEC.decode(seen) === 'a\n') break
      await new Promise((r) => setTimeout(r, 10))
    }
    await store.setFile('/f', new Uint8Array())
    next()
    await writing
    expect(DEC.decode((await store.getFile('/f')) ?? new Uint8Array())).toBe('\0\0b\n')
  })

  // An append that brings nothing leaves an existing file as it was, its
  // modification time included (`true >> f`), and creates a missing one.
  it('writeStream leaves a file alone for an empty append', async () => {
    await store.setFile('/f', ENC.encode('kept'))
    await store.setModified('/f', '2020-01-01T00:00:00Z')
    await write(acc, spec('/f'), chunksOf(), true)
    expect(DEC.decode((await store.getFile('/f')) ?? new Uint8Array())).toBe('kept')
    expect(await store.getModified('/f')).toBe('2020-01-01T00:00:00Z')
    await write(acc, spec('/new'), chunksOf(), true)
    expect((await store.getFile('/new'))?.byteLength).toBe(0)
  })

  it('writeStream atomic lands only at its end', async () => {
    let release = (): void => undefined
    const hold = new Promise<void>((resolve) => (release = resolve))
    async function* quiet(): AsyncIterable<Uint8Array> {
      yield ENC.encode('new')
      await hold
    }
    await write(acc, spec('/f'), ENC.encode('old'))
    const writing = write(acc, spec('/f'), quiet(), false, true)
    await new Promise((r) => setTimeout(r, 50))
    expect(DEC.decode((await store.getFile('/f')) ?? new Uint8Array())).toBe('old')
    release()
    await writing
    expect(DEC.decode((await store.getFile('/f')) ?? new Uint8Array())).toBe('new')
  })

  it('writeBytes fails when parent is missing', async () => {
    // The operand is what a GNU stderr line names, so the error carries the
    // virtual path and an errno, not the internal parent phrasing.
    await expect(write(acc, spec('/missing/x.txt'), ENC.encode('.'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/missing/x.txt',
    })
  })

  it('appendBytes creates then extends', async () => {
    await write(acc, spec('/a.txt'), ENC.encode('foo'), true)
    await write(acc, spec('/a.txt'), ENC.encode('bar'), true)
    expect(DEC.decode(await read(acc, spec('/a.txt')))).toBe('foobar')
  })

  it('create writes empty file', async () => {
    await create(acc, spec('/e.txt'))
    expect((await read(acc, spec('/e.txt'))).byteLength).toBe(0)
  })

  it('exists sees files and dirs', async () => {
    await write(acc, spec('/f'), ENC.encode('x'))
    await mkdir(acc, spec('/d'))
    expect(await exists(acc, spec('/f'))).toBe(true)
    expect(await exists(acc, spec('/d'))).toBe(true)
    expect(await exists(acc, spec('/nope'))).toBe(false)
  })

  it('mkdir requires existing parent', async () => {
    await expect(mkdir(acc, spec('/foo/bar'))).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(acc, spec('/foo'))
    await mkdir(acc, spec('/foo/bar'))
    expect(await exists(acc, spec('/foo/bar'))).toBe(true)
  })

  it('mkdir refuses an existing target, and -p is the idempotent form (GNU)', async () => {
    await mkdir(acc, spec('/d'))
    await expect(mkdir(acc, spec('/d'))).rejects.toMatchObject({ code: 'EEXIST' })
    await mkdir(acc, spec('/d'), true)
    expect(await exists(acc, spec('/d'))).toBe(true)
  })

  it('mkdir -p across a plain file names the component and keeps the file', async () => {
    await write(acc, spec('/f.txt'), ENC.encode('hi'))
    await expect(mkdir(acc, spec('/f.txt/sub'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/f.txt',
    })
    expect(await store.hasDir('/f.txt')).toBe(false)
    expect(DEC.decode(await read(acc, spec('/f.txt')))).toBe('hi')
  })

  it('mkdir -p onto a plain file target is EEXIST', async () => {
    await write(acc, spec('/f.txt'), ENC.encode('hi'))
    await expect(mkdir(acc, spec('/f.txt'), true)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('mkdir with parents=true creates chain', async () => {
    await mkdir(acc, spec('/a/b/c'), true)
    expect(await exists(acc, spec('/a/b/c'))).toBe(true)
  })

  it('rmdir refuses non-empty and removes empty', async () => {
    await mkdir(acc, spec('/dir'))
    await write(acc, spec('/dir/f'), ENC.encode('.'))
    await expect(rmdir(acc, spec('/dir'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    // The refusal must leave the child addressable, not orphan it.
    expect(await exists(acc, spec('/dir/f'))).toBe(true)
    await unlink(acc, spec('/dir/f'))
    await rmdir(acc, spec('/dir'))
    expect(await exists(acc, spec('/dir'))).toBe(false)
  })

  it('rmdir fails on missing dir', async () => {
    await expect(rmdir(acc, spec('/ghost'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('unlink removes files', async () => {
    await write(acc, spec('/f'), ENC.encode('.'))
    await unlink(acc, spec('/f'))
    expect(await exists(acc, spec('/f'))).toBe(false)
  })

  it('rename moves a file + preserves content', async () => {
    await write(acc, spec('/a'), ENC.encode('data'))
    await rename(acc, spec('/a'), spec('/b'))
    expect(await exists(acc, spec('/a'))).toBe(false)
    expect(DEC.decode(await read(acc, spec('/b')))).toBe('data')
  })

  it('rename moves a dir with nested files', async () => {
    await mkdir(acc, spec('/d1'))
    await write(acc, spec('/d1/x'), ENC.encode('x'))
    await rename(acc, spec('/d1'), spec('/d2'))
    expect(DEC.decode(await read(acc, spec('/d2/x')))).toBe('x')
  })

  it('copy duplicates contents', async () => {
    await write(acc, spec('/s'), ENC.encode('hi'))
    await copy(acc, spec('/s'), spec('/t'))
    expect(DEC.decode(await read(acc, spec('/t')))).toBe('hi')
    expect(await exists(acc, spec('/s'))).toBe(true)
  })

  it('truncate shrinks and zero-pads', async () => {
    await write(acc, spec('/x'), ENC.encode('abcdef'))
    await truncate(acc, spec('/x'), 3)
    expect(DEC.decode(await read(acc, spec('/x')))).toBe('abc')
    await truncate(acc, spec('/x'), 6)
    expect((await read(acc, spec('/x'))).byteLength).toBe(6)
  })

  it('rmR removes dir tree', async () => {
    await mkdir(acc, spec('/t/a'), true)
    await write(acc, spec('/t/a/f'), ENC.encode('.'))
    await rmR(acc, spec('/t'))
    expect(await exists(acc, spec('/t'))).toBe(false)
  })

  it('tree reads every key under a directory with its stat', async () => {
    await mkdir(acc, spec('/d'))
    await mkdir(acc, spec('/d/s'))
    await write(acc, spec('/d/a'), ENC.encode('abc'))
    await write(acc, spec('/d/s/b'), ENC.encode('defg'))
    const found = await tree(acc, spec('/d'))
    expect(
      [...(found ?? new Map<string, FileStat>()).entries()].map(([k, st]) => [k, st.type, st.size]),
    ).toEqual([
      ['a', 'file', 3],
      ['s/b', 'file', 4],
      ['s', 'directory', null],
    ])
    for (const [rel, st] of found ?? []) expect(st).toEqual(await stat(acc, spec(`/d/${rel}`)))
    expect(await tree(acc, spec('/d/a'))).toBeNull()
    await store.setFile('/d/missing/b', ENC.encode('b'))
    expect(await tree(acc, spec('/d'))).toBeNull()
  })

  it('readdir returns mount-prefixed entries', async () => {
    await mkdir(acc, spec('/d'))
    await write(acc, spec('/d/a'), ENC.encode('.'))
    await write(acc, spec('/d/b'), ENC.encode('.'))
    const entries = await listed(acc, spec('/mount/d', '/mount'))
    expect(entries).toEqual(['/mount/d/a', '/mount/d/b'])
  })

  it('stat returns file + dir metadata', async () => {
    await write(acc, spec('/f.txt'), ENC.encode('xyz'))
    const fs = await stat(acc, spec('/f.txt'))
    expect(fs.size).toBe(3)
    await mkdir(acc, spec('/d'))
    const ds = await stat(acc, spec('/d'))
    expect(ds.type).toBe('directory')
  })

  it('stream yields file contents once', async () => {
    await write(acc, spec('/f'), ENC.encode('hello'))
    const chunks: Uint8Array[] = []
    for await (const c of readStream(acc, spec('/f'))) chunks.push(c)
    expect(chunks).toHaveLength(1)
    const first = chunks[0]
    expect(first).toBeDefined()
    if (first !== undefined) expect(DEC.decode(first)).toBe('hello')
  })

  it('readdir answers each child as stat does', async () => {
    await write(acc, spec('/a.txt'), ENC.encode('.'))
    await mkdir(acc, spec('/d'))
    const rows = await readdir(acc, spec('/'))
    expect(rows.map((row) => row.name)).toEqual(['a.txt', 'd'])
    for (const row of rows) expect(row).toEqual(await stat(acc, spec(`/${row.name}`)))
  })

  it('resolveGlob expands star patterns', async () => {
    await write(acc, spec('/a.txt'), ENC.encode('.'))
    await write(acc, spec('/b.txt'), ENC.encode('.'))
    await write(acc, spec('/c.md'), ENC.encode('.'))
    const patternSpec = new PathSpec({
      virtual: '/*.txt',
      directory: '/',
      pattern: '*.txt',
      resolved: false,
      vfsPath: '*.txt',
    })
    const expanded = await resolveGlob(acc, [patternSpec])
    const names = expanded.map((p) => p.virtual).sort()
    expect(names).toEqual(['/a.txt', '/b.txt'])
  })
})

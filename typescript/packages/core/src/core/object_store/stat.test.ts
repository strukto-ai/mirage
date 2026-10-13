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

import { describe, expect, it, vi } from 'vitest'
import { RedisIndexCacheStore } from '../../cache/index/redis.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { type FileStat, FileType } from '../../types.ts'
import { codeOf, FakeAccessor, FakeStore, makeDriver, MODIFIED, spec } from './fakes.ts'
import { makeReaddir, makeTree } from './readdir.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

function sizeOf(found: Map<string, FileStat> | null): number {
  return [...(found ?? new Map<string, FileStat>()).values()].reduce(
    (total, st) => total + (st.size ?? 0),
    0,
  )
}

it.each(['tree', 'readdir'])('%s refresh does not revive an expired folder', async (refresh) => {
  const store = new FakeStore({ 'data/old.txt': 'old' })
  const driver = makeDriver(store)
  const index = new RAMIndexCacheStore({ ttl: 60 })
  const path = spec('/data')
  const tree = makeTree(driver)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    await tree(accessor, path, null, index)
    store.objects.clear()
    store.objects.set('data', new TextEncoder().encode('file'))
    store.objects.set('data/new.txt', new TextEncoder().encode('new'))
    clock.mockReturnValue(62000)
    if (refresh === 'tree') await tree(accessor, path, null, index)
    else await makeReaddir(driver)(accessor, path, index)
    expect((await makeStat(driver)(accessor, path, index)).type).toBe(FileType.FILE)
  } finally {
    clock.mockRestore()
  }
})

describe('a tree caches expiring metadata', () => {
  describe.each(['expired', 'missing'])('with a %s listing', (expiry) => {
    it.each(['deleted', 'file', 'directory'])(
      'revalidates a root replaced with %s',
      async (replacement) => {
        const store = new FakeStore({ 'data/old.txt': 'old' })
        const driver = makeDriver(store)
        const index = new RAMIndexCacheStore({ ttl: 60 })
        const path = spec('/data')
        const stat = makeStat(driver)
        const tree = makeTree(driver)
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        try {
          await tree(accessor, path, null, index)
          store.connects = 0
          expect((await stat(accessor, path, index)).type).toBe(FileType.DIRECTORY)
          expect(store.connects).toBe(0)
          store.objects.clear()
          if (replacement === 'file')
            store.objects.set('data', new TextEncoder().encode('new file'))
          else if (replacement === 'directory')
            store.objects.set('data/new.txt', new TextEncoder().encode('new contents'))
          if (expiry === 'expired') clock.mockReturnValue(62000)
          else await index.invalidateDir(path.virtual)
          if (replacement === 'deleted') {
            await expect(stat(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await tree(accessor, path, null, index)).toBeNull()
          } else {
            expect((await stat(accessor, path, index)).type).toBe(
              replacement === 'file' ? FileType.FILE : FileType.DIRECTORY,
            )
          }
          await expect(stat(accessor, spec('/data/old.txt'), index)).rejects.toMatchObject({
            code: 'ENOENT',
          })
          if (replacement === 'directory') {
            expect(sizeOf(await tree(accessor, path, null, index))).toBe('new contents'.length)
          }
        } finally {
          clock.mockRestore()
        }
      },
    )
  })
})

describe('object_store stat', () => {
  it('maps the driver meta onto FileStat', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const stat = makeStat(makeDriver(store))
    const st = await stat(accessor, spec('/a.txt'))
    expect(st.size).toBe(2)
    expect(st.modified).toBe(MODIFIED)
    expect(st.fingerprint).toBe('fp-a.txt')
    expect(st.revision).toBe('rev-a.txt')
    expect(st.extra).toEqual({ etag: 'fp-a.txt' })
  })

  it('answers the root as a directory without connecting', async () => {
    const store = new FakeStore()
    const stat = makeStat(makeDriver(store))
    const st = await stat(accessor, spec('/'))
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(store.connects).toBe(0)
  })

  it('answers a prefix as a directory', async () => {
    const store = new FakeStore({ 'dir/f.txt': 'x' })
    const stat = makeStat(makeDriver(store))
    await expect(stat(accessor, spec('/dir'))).resolves.toMatchObject({
      type: FileType.DIRECTORY,
    })
  })

  it('reports ENOENT for a missing path', async () => {
    const stat = makeStat(makeDriver(new FakeStore({ 'a.txt': 'hi' })))
    await expect(codeOf(stat(accessor, spec('/never')))).resolves.toBe('ENOENT')
  })

  it('a trailing slash prefers the coexisting prefix', async () => {
    const store = new FakeStore({ csv: 'file', 'csv/inner.txt': 'x' })
    const stat = makeStat(makeDriver(store))
    const asFile = await stat(accessor, spec('/csv'))
    expect(asFile.type).not.toBe(FileType.DIRECTORY)
    const asDir = await stat(accessor, spec('/csv/'))
    expect(asDir.type).toBe(FileType.DIRECTORY)
  })

  it('the index fast path skips the store', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const driver = makeDriver(store)
    const index = new RAMIndexCacheStore()
    await makeReaddir(driver)(accessor, spec('/'), index)
    const connects = store.connects
    const st = await makeStat(driver)(accessor, spec('/a.txt'), index)
    expect(st.size).toBe(2)
    expect(store.connects).toBe(connects)
  })

  it('a listed parent negative-caches ENOENT', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const driver = makeDriver(store)
    const index = new RAMIndexCacheStore()
    await makeReaddir(driver)(accessor, spec('/'), index)
    const connects = store.connects
    await expect(codeOf(makeStat(driver)(accessor, spec('/.git'), index))).resolves.toBe('ENOENT')
    expect(store.connects).toBe(connects)
  })
})

for (const type of ['ram', 'redis']) {
  describe.skipIf(type === 'redis' && process.env.REDIS_URL === undefined)(
    `object_store stat membership (${type})`,
    () => {
      it.each(['/a.txt', '/dir'])(
        'resolves listed %s from the backend after metadata eviction',
        async (path) => {
          const index =
            type === 'redis'
              ? new RedisIndexCacheStore({
                  ...(process.env.REDIS_URL === undefined ? {} : { url: process.env.REDIS_URL }),
                  keyPrefix: `stat:${crypto.randomUUID()}:`,
                })
              : new RAMIndexCacheStore()
          try {
            const store = new FakeStore({ 'a.txt': 'hi', 'dir/f.txt': 'x' })
            const driver = makeDriver(store)
            await makeReaddir(driver)(accessor, spec('/'), index)
            await index.invalidatePrefix('/mnt' + path)
            expect((await index.get('/mnt' + path)).entry).toBeUndefined()
            expect((await index.listDir('/mnt')).entries).toContain('/mnt' + path)
            const connects = store.connects
            const st = await makeStat(driver)(accessor, spec(path), index)
            expect(st.type).toBe(path === '/dir' ? FileType.DIRECTORY : FileType.FILE)
            expect(store.connects).toBeGreaterThan(connects)
            if (path === '/a.txt') {
              expect(st.size).toBe(2)
              expect(st.fingerprint).toBe('fp-a.txt')
            }
            const beforeMissing = store.connects
            await expect(codeOf(makeStat(driver)(accessor, spec('/.git'), index))).resolves.toBe(
              'ENOENT',
            )
            expect(store.connects).toBe(beforeMissing)
            await index.invalidate()
            store.objects.set('new.txt', new TextEncoder().encode('new'))
            expect((await makeStat(driver)(accessor, spec('/new.txt'), index)).size).toBe(3)
          } finally {
            await index.clear()
            await index.close()
          }
        },
      )
    },
  )
}

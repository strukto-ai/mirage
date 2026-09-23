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

import { PathSpec } from '@struktoai/mirage-core/types'
import { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { RedisIndexCacheStore } from '@struktoai/mirage-core/cache/index/redis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { exists as pathExists } from './exists.ts'
import { dirStatEntry, keyOf, lookup, probeDir, probeFile } from './lookup.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { parseEntry, seedIndex } from './tree.ts'

function ps(path: string, prefix = ''): PathSpec {
  const rel = path.replace(/^\/+|\/+$/g, '')
  const stem = prefix.replace(/\/+$/, '')
  const virtual =
    stem === '' ? (rel === '' ? '/' : `/${rel}`) : rel === '' ? stem : `${stem}/${rel}`
  const parent = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  return new PathSpec({ virtual, directory: parent, vfsPath: rel })
}

/** The errno an fs op refused with, which is what a backend test pins. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

function loaded(): HfHubAccessor {
  const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
  accessor.tree = new Map([
    ['a.txt', parseEntry({ type: 'file', oid: 'oid-a', size: 7, path: 'a.txt' })],
    ['d/b.txt', parseEntry({ type: 'file', oid: 'oid-b', size: 3, path: 'd/b.txt' })],
    ['d', parseEntry({ type: 'directory', oid: 'tree-d', size: 0, path: 'd' })],
  ])
  accessor.treeLoaded = true
  accessor.rowsCache = null
  return accessor
}

describe('keyOf', () => {
  it.each([
    ['', 'a.txt', '/a.txt'],
    ['', '', '/'],
    ['/m', 'a.txt', '/m/a.txt'],
    ['/m', '', '/m'],
    ['/m', '/d/a.txt', '/m/d/a.txt'],
  ])('prefix %s + %s', (prefix, local, expected) => {
    expect(keyOf(prefix, local)).toBe(expected)
  })
})

describe('lookup', () => {
  it('answers from the tree without an index', async () => {
    const found = await lookup(loaded(), undefined, '', '/a.txt')
    expect(found.entry?.size).toBe(7)
  })

  it('reports a directory with no row of its own', async () => {
    const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
    accessor.tree = new Map([
      ['d/b.txt', parseEntry({ type: 'file', oid: 'o', size: 1, path: 'd/b.txt' })],
    ])
    accessor.treeLoaded = true
    const found = await lookup(accessor, undefined, '', '/d')
    expect(found.entry).toBeNull()
    expect(found.children).toEqual(['/d/b.txt'])
  })

  it('reports an absence', async () => {
    const found = await lookup(loaded(), undefined, '', '/nope')
    expect(found.entry).toBeNull()
    expect(found.children).toBeNull()
  })
})

describe('probes', () => {
  it('tell a file from a directory', async () => {
    const accessor = loaded()
    expect(await probeFile(accessor, undefined, '', 'a.txt')).toBe(true)
    expect(await probeDir(accessor, undefined, '', 'a.txt')).toBe(false)
    expect(await probeDir(accessor, undefined, '', 'd')).toBe(true)
    expect(await probeFile(accessor, undefined, '', 'nope')).toBe(false)
  })
})

describe('dirStatEntry', () => {
  it('names the last segment', () => {
    const entry = dirStatEntry('/m/deep/dir')
    expect(entry.name).toBe('dir')
    expect(entry.resourceType).toBe('folder')
  })
})

describe('readdir', () => {
  it('lists the root and a subdirectory', async () => {
    const accessor = loaded()
    expect(await readdir(accessor, ps(''))).toEqual(['/a.txt', '/d'])
    expect(await readdir(accessor, ps('d'))).toEqual(['/d/b.txt'])
  })

  it('reports ENOTDIR for a file and for a path under one', async () => {
    // GNU `ls /f.txt/x` reports Not a directory, not absence. The FsError
    // carries the code; the strerror suffix is appended at the command
    // chokepoints, so the code is what a backend test can pin.
    const accessor = loaded()
    expect(await codeOf(() => readdir(accessor, ps('a.txt')))).toBe('ENOTDIR')
    expect(await codeOf(() => readdir(accessor, ps('a.txt/x')))).toBe('ENOTDIR')
  })

  it('reports ENOENT for a missing path however deep', async () => {
    const accessor = loaded()
    expect(await codeOf(() => readdir(accessor, ps('nope')))).toBe('ENOENT')
    expect(await codeOf(() => readdir(accessor, ps('nope/deeper')))).toBe('ENOENT')
  })

  it('lists nothing for an empty repo', async () => {
    const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
    accessor.treeLoaded = true
    expect(await readdir(accessor, ps(''))).toEqual([])
  })
})

describe('stat', () => {
  it('reports size and the oid as fingerprint', async () => {
    const result = await stat(loaded(), ps('a.txt'))
    expect(result.size).toBe(7)
    expect(result.fingerprint).toBe('oid-a')
  })

  it('leaves mtime null when the row carries none', async () => {
    // A Hub file's only mtime is its last commit, and a bare listing carries
    // none. Null is honest; a repo-wide timestamp on every file would not be.
    expect((await stat(loaded(), ps('a.txt'))).modified).toBeNull()
  })

  it('reports the mount root as a directory', async () => {
    const result = await stat(loaded(), ps(''))
    expect(result.name).toBe('/')
    expect(result.type).toBe('directory')
  })

  it('reports ENOENT for a missing path', async () => {
    expect(await codeOf(() => stat(loaded(), ps('nope')))).toBe('ENOENT')
  })
})

describe('read', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('never reaches the network for a path the listing knows is absent', async () => {
    const spy = vi.spyOn(client, 'hubBytes')
    expect(await codeOf(() => read(loaded(), ps('nope')))).toBe('ENOENT')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports EISDIR for a directory and for the mount root', async () => {
    const accessor = loaded()
    expect(await codeOf(() => read(accessor, ps('d')))).toBe('EISDIR')
    expect(await codeOf(() => read(accessor, ps('')))).toBe('EISDIR')
  })

  it('fetches the resolve url', async () => {
    const spy = vi.spyOn(client, 'hubBytes').mockResolvedValue(new TextEncoder().encode('hello'))
    const data = await read(loaded(), ps('a.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(spy.mock.calls[0]?.[1]).toBe('https://huggingface.co/acme/widget/resolve/main/a.txt')
    expect(spy.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('passes a byte window', async () => {
    const spy = vi.spyOn(client, 'hubBytes').mockResolvedValue(new Uint8Array(2))
    await read(loaded(), ps('a.txt'), undefined, { offset: 0, size: 2 })
    expect(spy.mock.calls[0]?.[2]).toEqual({ offset: 0, size: 2 })
  })
})

describe('exists', () => {
  it('is true for a file and a directory, false for an absence', async () => {
    const accessor = loaded()
    expect(await pathExists(accessor, ps('a.txt'))).toBe(true)
    expect(await pathExists(accessor, ps('d'))).toBe(true)
    expect(await pathExists(accessor, ps('nope'))).toBe(false)
  })
})

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `HF snapshot freshness with ${backend}`,
    () => {
      beforeEach(() => {
        vi.restoreAllMocks()
      })

      function indexForTest(): RAMIndexCacheStore | RedisIndexCacheStore {
        const url = process.env.REDIS_URL
        return backend === 'ram'
          ? new RAMIndexCacheStore()
          : new RedisIndexCacheStore({
              ...(url === undefined ? {} : { url }),
              keyPrefix: `hf-refresh:${crypto.randomUUID()}:`,
            })
      }

      for (const changed of ['a.txt', 'd/b.txt', 'd']) {
        for (const deleted of [true, false]) {
          it.each(['stat', 'read'])(
            `%s refreshes ${changed} after invalidation (deleted=${String(deleted)})`,
            async (reader) => {
              const accessor = loaded()
              const index = indexForTest()
              const rows = [...accessor.tree.values()]
                .filter((row) => row.path !== changed && !row.path.startsWith(`${changed}/`))
                .map((row) => ({ path: row.path, type: row.type, oid: row.oid, size: row.size }))
              if (!deleted) rows.push({ path: changed, type: 'file', oid: 'new-oid', size: 42 })
              const fetch = vi.spyOn(client, 'hubGetResponse').mockResolvedValue({
                data: rows,
                status: 200,
                headers: {},
              })
              const bytes = vi
                .spyOn(client, 'hubBytes')
                .mockResolvedValue(new TextEncoder().encode('new bytes'))
              try {
                await seedIndex(accessor, index, '/m')
                await index.setDir('/other', [
                  ['keep', new IndexEntry({ id: 'keep', name: 'keep', resourceType: 'file' })],
                ])
                await index.invalidate()
                expect((await index.get(`/m/${changed}`)).entry).toBeDefined()
                const path = ps(changed, '/m')
                for (let i = 0; i < 2; i++) {
                  if (deleted) {
                    await expect(
                      reader === 'stat' ? stat(accessor, path, index) : read(accessor, path, index),
                    ).rejects.toMatchObject({ code: 'ENOENT' })
                  } else {
                    if (reader === 'read')
                      expect(new TextDecoder().decode(await read(accessor, path, index))).toBe(
                        'new bytes',
                      )
                    const result = await stat(accessor, path, index)
                    expect(result.size).toBe(42)
                    expect(result.fingerprint).toBe('new-oid')
                  }
                }
                if (deleted || reader === 'stat') expect(bytes).not.toHaveBeenCalled()
                if (changed === 'd')
                  expect(await lookup(accessor, index, '/m', '/m/d/b.txt')).toEqual({
                    entry: null,
                    children: null,
                  })
                await lookup(accessor, index, '/m', '/m/missing')
                expect(fetch).toHaveBeenCalledTimes(1)
                expect((await index.get('/other/keep')).entry?.id).toBe('keep')
              } finally {
                await index.clear()
                await index.close()
              }
            },
          )
        }
      }

      it('refreshes an expired parent while the repository root is fresh', async () => {
        const accessor = loaded()
        const index = indexForTest()
        const fetch = vi
          .spyOn(client, 'hubGetResponse')
          .mockResolvedValue({ data: [], status: 200, headers: {} })
        try {
          await seedIndex(accessor, index, '')
          await index.setDir(
            '/d',
            [['b.txt', new IndexEntry({ id: 'old', name: 'b.txt', resourceType: 'file' })]],
            new Date(0),
          )
          await expect(stat(accessor, ps('d/b.txt'), index)).rejects.toMatchObject({
            code: 'ENOENT',
          })
          expect(fetch).toHaveBeenCalledTimes(1)
        } finally {
          await index.clear()
          await index.close()
        }
      })

      it('keeps the old snapshot on a failed fetch and retries the refresh', async () => {
        const accessor = loaded()
        const index = indexForTest()
        const fetch = vi
          .spyOn(client, 'hubGetResponse')
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValueOnce({ data: [], status: 200, headers: {} })
        try {
          await seedIndex(accessor, index, '')
          await index.invalidate()
          await expect(stat(accessor, ps('a.txt'), index)).rejects.toThrow('offline')
          expect((await index.get('/a.txt')).entry?.id).toBe('oid-a')
          await expect(stat(accessor, ps('a.txt'), index)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(fetch).toHaveBeenCalledTimes(2)
          expect(await readdir(accessor, ps(''), index)).toEqual([])
          expect(fetch).toHaveBeenCalledTimes(2)
        } finally {
          await index.clear()
          await index.close()
        }
      })

      it('does not consult an expired listing outside the mount', async () => {
        const accessor = loaded()
        const index = indexForTest()
        const fetch = vi
          .spyOn(client, 'hubGetResponse')
          .mockRejectedValue(new Error('unexpected fetch'))
        try {
          await seedIndex(accessor, index, '/m')
          await index.setDir('/', [], new Date(0))
          expect((await lookup(accessor, index, '/m', '/m')).children).toEqual(['/m/a.txt', '/m/d'])
          expect(fetch).not.toHaveBeenCalled()
        } finally {
          await index.clear()
          await index.close()
        }
      })
    },
  )
}

for (const backend of ['ram', 'redis']) {
  it.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `parallel snapshot readers share one replacement with ${backend}`,
    async () => {
      const url = process.env.REDIS_URL
      const index =
        backend === 'ram'
          ? new RAMIndexCacheStore()
          : new RedisIndexCacheStore({
              ...(url === undefined ? {} : { url }),
              keyPrefix: `parallel-hf:${crypto.randomUUID()}:`,
            })
      const accessor = loaded()
      const fetch = vi.spyOn(client, 'hubGetResponse').mockImplementation(async () => {
        await Promise.resolve()
        return {
          data: [{ path: 'a.txt', type: 'file', oid: 'new', size: 42 }],
          status: 200,
          headers: {},
        }
      })
      try {
        await seedIndex(accessor, index, '/m')
        await index.invalidate()
        const keys = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? '/m/a.txt' : '/m'))
        const results = await Promise.all(keys.map((key) => lookup(accessor, index, '/m', key)))
        expect(results.filter((_, i) => i % 2 === 0).map((row) => row.entry?.id)).toEqual([
          'new',
          'new',
          'new',
          'new',
        ])
        expect(results.filter((_, i) => i % 2 === 1).map((row) => row.children)).toEqual(
          Array.from({ length: 4 }, () => ['/m/a.txt']),
        )
        expect(fetch).toHaveBeenCalledTimes(1)
      } finally {
        fetch.mockRestore()
        await index.clear()
        await index.close()
      }
    },
  )
}

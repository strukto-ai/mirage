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

import { describe, expect, it } from 'vitest'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { FileStat, FileType, PathSpec, type WalkEntry } from '../types.ts'
import { enoent } from '../utils/errors.ts'
import { entryOf, ReaddirWalk, synthDirs } from './walk.ts'

function root(virtual: string, resourcePath: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath })
}

describe('synthDirs', () => {
  it('emits every ancestor of a file, excluding the root', () => {
    const dirs = [...synthDirs('/m/data', ['/m/data/a/b/c.txt'], [])].map((e) => e.virtual)
    expect(dirs).toEqual(['/m/data/a/b', '/m/data/a'])
  })

  it('reports a shared prefix once', () => {
    const dirs = [...synthDirs('/m/data', ['/m/data/a/x.txt', '/m/data/a/y.txt'], [])]
    expect(dirs.map((e) => e.virtual)).toEqual(['/m/data/a'])
  })

  it('emits an explicitly stored directory even with no children', () => {
    const dirs = [...synthDirs('/m/data', [], ['/m/data/empty'])]
    expect(dirs.map((e) => e.virtual)).toEqual(['/m/data/empty'])
  })

  it('does not double-report a prefix backed by both a marker and children', () => {
    const dirs = [...synthDirs('/m/data', ['/m/data/a/x.txt'], ['/m/data/a'])]
    expect(dirs.map((e) => e.virtual)).toEqual(['/m/data/a'])
  })

  it('marks every row as a directory with no fingerprint', () => {
    const dirs = [...synthDirs('/m/data', ['/m/data/a/x.txt'], [])]
    expect(dirs.every((e) => e.isDir && e.fingerprint === null)).toBe(true)
  })

  it('emits nothing for a file directly under the root', () => {
    expect([...synthDirs('/m/data', ['/m/data/x.txt'], [])]).toEqual([])
  })
})

describe('entryOf', () => {
  it('reports a directory with no fingerprint', () => {
    const entry = entryOf('/m/d', new FileStat({ name: 'd', type: FileType.DIRECTORY }))
    expect(entry).toEqual({ virtual: '/m/d', isDir: true, fingerprint: null })
  })

  it('prefers the backend fingerprint over the composite', () => {
    const entry = entryOf(
      '/m/f.txt',
      new FileStat({
        name: 'f.txt',
        type: FileType.FILE,
        size: 3,
        modified: 'T',
        fingerprint: 'etag-1',
      }),
    )
    expect(entry.fingerprint).toBe('etag-1')
  })

  it('falls back to mtime|size when the backend has no version', () => {
    const entry = entryOf(
      '/m/f.txt',
      new FileStat({ name: 'f.txt', type: FileType.FILE, size: 3, modified: 'T' }),
    )
    expect(entry.fingerprint).toBe('T|3')
  })
})

type FakeTree = Record<string, { children?: string[]; stat: FileStat }>

function fakeBackend(tree: FakeTree): ReaddirWalk {
  const readdir = (path: PathSpec): Promise<string[]> => {
    const node = tree[path.virtual]
    if (node?.children === undefined) return Promise.reject(enoent(path.virtual))
    return Promise.resolve(node.children)
  }
  const stat = (path: PathSpec): Promise<FileStat> => {
    const node = tree[path.virtual]
    if (node === undefined) return Promise.reject(enoent(path.virtual))
    return Promise.resolve(node.stat)
  }
  return new ReaddirWalk(readdir as never, stat as never)
}

async function collect(walk: ReaddirWalk, spec: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(spec)) out.push(entry)
  return out
}

describe('ReaddirWalk', () => {
  it('descends into every directory and reports leaves', async () => {
    const walk = fakeBackend({
      '/m/data': {
        children: ['/m/data/a.txt', '/m/data/sub'],
        stat: new FileStat({ name: 'data', type: FileType.DIRECTORY }),
      },
      '/m/data/a.txt': {
        stat: new FileStat({
          name: 'a.txt',
          type: FileType.FILE,
          size: 5,
          modified: 'T1',
          fingerprint: 'fp-a',
        }),
      },
      '/m/data/sub': {
        children: ['/m/data/sub/deep.txt'],
        stat: new FileStat({ name: 'sub', type: FileType.DIRECTORY }),
      },
      '/m/data/sub/deep.txt': {
        stat: new FileStat({
          name: 'deep.txt',
          type: FileType.FILE,
          size: 4,
          modified: 'T2',
          fingerprint: 'fp-d',
        }),
      },
    })
    const entries = await collect(walk, root('/m/data', 'data'))
    expect(entries.map((e) => e.virtual)).toEqual([
      '/m/data/a.txt',
      '/m/data/sub',
      '/m/data/sub/deep.txt',
    ])
    expect(entries.filter((e) => e.isDir).map((e) => e.virtual)).toEqual(['/m/data/sub'])
  })

  it('trusts a trailing slash without a stat round trip', async () => {
    const walk = fakeBackend({
      '/m/data': {
        children: ['/m/data/sub/'],
        stat: new FileStat({ name: 'data', type: FileType.DIRECTORY }),
      },
      // No stat entry for /m/data/sub at all: the slash is the proof,
      // so a stat would reject and the walk would lose the subtree.
      '/m/data/sub': {
        children: [],
        stat: new FileStat({ name: 'sub', type: FileType.DIRECTORY }),
      },
    })
    const entries = await collect(walk, root('/m/data', 'data'))
    expect(entries).toEqual([{ virtual: '/m/data/sub', isDir: true, fingerprint: null }])
  })

  it('skips an entry that vanished between the readdir and the stat', async () => {
    const walk = fakeBackend({
      '/m/data': {
        children: ['/m/data/gone.txt', '/m/data/here.txt'],
        stat: new FileStat({ name: 'data', type: FileType.DIRECTORY }),
      },
      '/m/data/here.txt': {
        stat: new FileStat({
          name: 'here.txt',
          type: FileType.FILE,
          size: 1,
          modified: 'T',
          fingerprint: 'fp',
        }),
      },
    })
    const entries = await collect(walk, root('/m/data', 'data'))
    expect(entries.map((e) => e.virtual)).toEqual(['/m/data/here.txt'])
  })

  it('walks a missing root as empty rather than throwing', async () => {
    const walk = fakeBackend({})
    expect(await collect(walk, root('/m/gone', 'gone'))).toEqual([])
  })

  it('starts from an empty index on every call', async () => {
    const seen: (IndexCacheStore | undefined)[] = []
    const readdir = (path: PathSpec, index: IndexCacheStore): Promise<string[]> => {
      seen.push(index)
      return Promise.resolve(path.virtual === '/m/data' ? ['/m/data/a.txt'] : [])
    }
    const stat = (): Promise<FileStat> =>
      Promise.resolve(
        new FileStat({
          name: 'a.txt',
          type: FileType.FILE,
          size: 1,
          modified: 'T',
          fingerprint: 'fp',
        }),
      )
    const walk = new ReaddirWalk(readdir as never, stat as never)
    await collect(walk, root('/m/data', 'data'))
    await collect(walk, root('/m/data', 'data'))
    // Two pulls, two distinct index instances: nothing a pull learned
    // can leak into the next one's snapshot.
    expect(seen[0]).not.toBe(seen[seen.length - 1])
  })
})

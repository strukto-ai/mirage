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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { enoent } from '../../errors/fs.ts'
import { DirListing, FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import type { Handed } from '../../vfs/types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { entryAt, indexKey, keepListing, storedListing, storedStat } from './listing.ts'

interface Node {
  name: string
  parent: string
  dir: boolean
  data: Uint8Array
}

/** A store that knows its entries only by id, as Drive does. */
class Folders extends BaseVFS {
  override readonly name: string = 'folders'
  override readonly listsStats: boolean = true
  override readonly handed = {
    readdir: ['entry'],
    stat: ['entry'],
    read: ['entry'],
    write: ['entry', 'parent'],
    mkdir: ['parent'],
    readTree: ['entry'],
    unlink: ['entry'],
    rename: ['entry', 'dstParent', 'dstEntry'],
  } as const
  readonly nodes = new Map<string, Node>([
    ['root', { name: '', parent: '', dir: true, data: new Uint8Array() }],
  ])
  readonly calls: [string, string][] = []
  private ids = 0

  add(name: string, parent = 'root', data?: Uint8Array): string {
    this.ids += 1
    const id = `n${String(this.ids)}`
    this.nodes.set(id, { name, parent, dir: data === undefined, data: data ?? new Uint8Array() })
    return id
  }

  get lastId(): string {
    return `n${String(this.ids)}`
  }

  statOf(id: string): FileStat {
    const node = this.nodes.get(id)
    if (node === undefined) throw new Error(`no node ${id}`)
    return new FileStat({
      name: node.name,
      type: node.dir ? FileType.DIRECTORY : FileType.FILE,
      size: node.dir ? null : node.data.byteLength,
      extra: { id },
    })
  }

  private folder(path: PathSpec, parent: FileStat | null | undefined): string {
    if (parent !== null && parent !== undefined) return parent.extra.id as string
    if (path.vfsPath.replace(/^\/+|\/+$/g, '').includes('/')) throw enoent(path)
    return 'root'
  }

  override readdir(path: PathSpec, handed?: IndexCacheStore | Handed): Promise<FileStat[]> {
    const entry = (handed as Handed | undefined)?.entry ?? null
    if (entry === null && path.vfsPath.replace(/^\/+|\/+$/g, '') !== '') {
      return Promise.reject(enoent(path))
    }
    const folder = entry === null ? 'root' : (entry.extra.id as string)
    this.calls.push(['list', folder])
    if (!this.nodes.has(folder)) return Promise.reject(enoent(path))
    return Promise.resolve(
      [...this.nodes].filter(([, node]) => node.parent === folder).map(([id]) => this.statOf(id)),
    )
  }

  override stat(path: PathSpec, handed?: IndexCacheStore | Handed): Promise<FileStat> {
    if (path.vfsPath.replace(/^\/+|\/+$/g, '') === '') {
      return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
    }
    const entry = (handed as Handed | undefined)?.entry ?? null
    if (entry === null || !this.nodes.has(entry.extra.id as string)) {
      return Promise.reject(enoent(path))
    }
    this.calls.push(['stat', entry.extra.id as string])
    return Promise.resolve(this.statOf(entry.extra.id as string))
  }

  override read(path: PathSpec, handed?: IndexCacheStore | Handed): Promise<Uint8Array> {
    const entry = (handed as Handed | undefined)?.entry ?? null
    const node = entry === null ? undefined : this.nodes.get(entry.extra.id as string)
    if (entry === null || node === undefined) return Promise.reject(enoent(path))
    this.calls.push(['read', entry.extra.id as string])
    return Promise.resolve(node.data)
  }

  override write(
    path: PathSpec,
    data: Uint8Array,
    _signal?: AbortSignal,
    handed: Handed = {},
  ): Promise<FileStat> {
    const entry = handed.entry ?? null
    if (entry !== null) {
      const id = entry.extra.id as string
      this.calls.push(['update', id])
      const node = this.nodes.get(id)
      if (node !== undefined) node.data = data
      return Promise.resolve(this.statOf(id))
    }
    const folder = this.folder(path, handed.parent)
    this.calls.push(['write', folder])
    const name = path.vfsPath.replace(/\/+$/, '').split('/').pop() ?? ''
    return Promise.resolve(this.statOf(this.add(name, folder, data)))
  }

  override mkdir(path: PathSpec, _parents = false, handed: Handed = {}): Promise<FileStat> {
    const folder = this.folder(path, handed.parent)
    this.calls.push(['mkdir', folder])
    const name = path.vfsPath.replace(/\/+$/, '').split('/').pop() ?? ''
    return Promise.resolve(this.statOf(this.add(name, folder)))
  }

  override readTree(
    _path: PathSpec,
    handed?: IndexCacheStore | Handed,
  ): Promise<Map<string, FileStat> | null> {
    const entry = (handed as Handed | undefined)?.entry ?? null
    const root = entry === null ? 'root' : (entry.extra.id as string)
    this.calls.push(['tree', root])
    const found = new Map<string, FileStat>([['', this.statOf(root)]])
    const pending: [string, string][] = [[root, '']]
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [folder, base] = next
      for (const [id, node] of this.nodes) {
        if (node.parent !== folder) continue
        const relative = base === '' ? node.name : `${base}/${node.name}`
        found.set(relative, this.statOf(id))
        if (node.dir) pending.push([id, relative])
      }
    }
    return Promise.resolve(found)
  }

  override unlink(path: PathSpec, handed?: IndexCacheStore | Handed): Promise<void> {
    const entry = (handed as Handed | undefined)?.entry ?? null
    if (entry === null || !this.nodes.has(entry.extra.id as string)) {
      return Promise.reject(enoent(path))
    }
    this.calls.push(['unlink', entry.extra.id as string])
    this.nodes.delete(entry.extra.id as string)
    return Promise.resolve()
  }

  override rename(src: PathSpec, dst: PathSpec, handed: Handed = {}): Promise<FileStat> {
    const entry = handed.entry ?? null
    if (entry === null) return Promise.reject(enoent(src))
    const moved = entry.extra.id as string
    const folder = this.folder(dst, handed.dstParent)
    const replaced = handed.dstEntry ?? null
    this.calls.push([
      'rename',
      `${moved}>${folder}${replaced === null ? '' : `!${replaced.extra.id as string}`}`,
    ])
    if (replaced !== null) this.nodes.delete(replaced.extra.id as string)
    const node = this.nodes.get(moved)
    if (node !== undefined) {
      node.parent = folder
      node.name = dst.vfsPath.replace(/\/+$/, '').split('/').pop() ?? ''
    }
    return Promise.resolve(this.statOf(moved))
  }
}

const ENC = new TextEncoder()

async function workspace(store: Folders): Promise<Workspace> {
  return new Workspace(
    { '/f/': store },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
}

describe('a mount that keeps its VFS listings', () => {
  it('answers the stats after a listing from it', async () => {
    const store = new Folders()
    store.add('a.txt', 'root', ENC.encode('hi'))
    store.add('d')
    const ws = await workspace(store)
    try {
      expect(((await ws.dispatch('readdir', '/f')) as string[]).sort()).toEqual([
        '/f/a.txt',
        '/f/d',
      ])
      const row = (await ws.dispatch('stat', '/f/a.txt')) as FileStat
      expect([row.name, row.size]).toEqual(['a.txt', 2])
      await expect(ws.dispatch('stat', '/f/gone.txt')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(store.calls).toEqual([['list', 'root']])
    } finally {
      await ws.close()
    }
  })

  it('lists a cold read’s parent and reads by id', async () => {
    const store = new Folders()
    const d = store.add('d')
    const f = store.add('f.txt', d, ENC.encode('deep'))
    const ws = await workspace(store)
    try {
      const data = await ws.dispatch('read', '/f/d/f.txt')
      expect(new TextDecoder().decode(data as Uint8Array)).toBe('deep')
      expect(store.calls).toEqual([
        ['list', 'root'],
        ['list', d],
        ['read', f],
      ])
    } finally {
      await ws.close()
    }
  })

  it('hands each level of a nested create the one above', async () => {
    const store = new Folders()
    const ws = await workspace(store)
    try {
      await ws.dispatch('mkdir', '/f/a/b/c', [], { parents: true })
      const byName = new Map([...store.nodes].map(([id, node]) => [node.name, { id, node }]))
      expect(byName.get('a')?.node.parent).toBe('root')
      expect(byName.get('b')?.node.parent).toBe(byName.get('a')?.id)
      expect(byName.get('c')?.node.parent).toBe(byName.get('b')?.id)
      expect(store.calls).toEqual([
        ['list', 'root'],
        ['mkdir', 'root'],
        ['mkdir', byName.get('a')?.id],
        ['mkdir', byName.get('b')?.id],
      ])
      await ws.dispatch('write', '/f/a/b/c/x.txt', [ENC.encode('x')])
      expect(store.nodes.get(store.lastId)?.parent).toBe(byName.get('c')?.id)
      expect(await ws.dispatch('readdir', '/f/a/b/c')).toEqual(['/f/a/b/c/x.txt'])
      expect(store.calls.at(-1)).toEqual(['write', byName.get('c')?.id])
    } finally {
      await ws.close()
    }
  })

  it('needs no second request for a listing kept through a create', async () => {
    const store = new Folders()
    store.add('old.txt', 'root', ENC.encode('o'))
    const ws = await workspace(store)
    try {
      await ws.dispatch('readdir', '/f')
      await ws.dispatch('write', '/f/new.txt', [ENC.encode('n')])
      expect(((await ws.dispatch('readdir', '/f')) as string[]).sort()).toEqual([
        '/f/new.txt',
        '/f/old.txt',
      ])
      expect(store.calls.filter(([op]) => op === 'list')).toEqual([['list', 'root']])
    } finally {
      await ws.close()
    }
  })

  it('hands a rename where it lands and what it replaces', async () => {
    const store = new Folders()
    const a = store.add('a.txt', 'root', ENC.encode('a'))
    const d = store.add('d')
    const b = store.add('b.txt', d, ENC.encode('b'))
    const ws = await workspace(store)
    try {
      await ws.dispatch('rename', '/f/a.txt', [PathSpec.fromStrPath('/f/d/b.txt')])
      expect(store.calls).toContainEqual(['rename', `${a}>${d}!${b}`])
      expect([store.nodes.get(a)?.parent, store.nodes.has(b)]).toEqual([d, false])
      await ws.dispatch('rename', '/f/d/b.txt', [PathSpec.fromStrPath('/f/c.txt')])
      expect(store.calls).toContainEqual(['rename', `${a}>root`])
    } finally {
      await ws.close()
    }
  })

  it('lists a stale entry again once', async () => {
    const store = new Folders()
    const old = store.add('a.txt', 'root', ENC.encode('old'))
    const ws = await workspace(store)
    try {
      await ws.dispatch('readdir', '/f')
      store.nodes.delete(old)
      const fresh = store.add('a.txt', 'root', ENC.encode('new'))
      const data = await ws.dispatch('read', '/f/a.txt')
      expect(new TextDecoder().decode(data as Uint8Array)).toBe('new')
      expect(store.calls).toEqual([
        ['list', 'root'],
        ['list', 'root'],
        ['read', fresh],
      ])
    } finally {
      await ws.close()
    }
  })

  it('keeps a subtree read and answers the walk after it', async () => {
    const store = new Folders()
    const d = store.add('d')
    const sub = store.add('sub', d)
    store.add('f.txt', d, ENC.encode('f'))
    store.add('g.txt', sub, ENC.encode('gg'))
    const ws = await workspace(store)
    try {
      const tree = (await ws.dispatch('read_tree', '/f/d')) as Map<string, FileStat>
      expect([...tree.keys()].sort()).toEqual(['f.txt', 'sub', 'sub/g.txt'])
      expect(store.calls).toEqual([
        ['list', 'root'],
        ['tree', d],
      ])
      store.calls.length = 0
      expect(((await ws.dispatch('stat', '/f/d')) as FileStat).name).toBe('d')
      expect(((await ws.dispatch('stat', '/f/d/sub/g.txt')) as FileStat).size).toBe(2)
      expect(await ws.dispatch('readdir', '/f/d/sub')).toEqual(['/f/d/sub/g.txt'])
      const again = (await ws.dispatch('read_tree', '/f/d')) as Map<string, FileStat>
      expect([...again.keys()].sort()).toEqual([...tree.keys()].sort())
      expect(store.calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('asks the backend for a stat once its listing expires', async () => {
    const store = new Folders()
    const a = store.add('a.txt', 'root', ENC.encode('a'))
    const ws = await workspace(store)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      await ws.dispatch('readdir', '/f')
      await ws.dispatch('stat', '/f/a.txt')
      expect(store.calls).toEqual([['list', 'root']])
      vi.setSystemTime(Date.now() + (store.indexTtl + 1) * 1000)
      await ws.dispatch('stat', '/f/a.txt')
      expect(store.calls).toEqual([
        ['list', 'root'],
        ['list', 'root'],
        ['stat', a],
      ])
    } finally {
      vi.useRealTimers()
      await ws.close()
    }
  })
})

describe('a kept listing', () => {
  it('names its seeds and leaves a view partial', async () => {
    const index = new RAMIndexCacheStore()
    const file = new FileStat({ name: 'v.txt', type: FileType.FILE })
    const seeded = new DirListing({
      entries: [new FileStat({ name: 'd', type: FileType.DIRECTORY }), file],
      seeds: new Map([['d', [new FileStat({ name: 'in.txt', type: FileType.FILE })]]]),
    })
    expect(await keepListing(index, '/m', seeded)).toEqual(['/m/d', '/m/v.txt'])
    expect(await storedListing(index, '/m/d')).toEqual(['/m/d/in.txt'])
    expect((await storedStat(index, '/m/d/in.txt'))?.name).toBe('in.txt')
    await expect(storedStat(index, '/m/nope')).rejects.toMatchObject({ code: 'ENOENT' })
    await keepListing(index, '/p', new DirListing({ entries: [file], partial: true }))
    expect(await storedListing(index, '/p')).toBeNull()
    expect((await entryAt(index, '/p/v.txt', null))?.name).toBe('v.txt')
    expect(await storedStat(index, '/p/other')).toBeNull()
  })

  it('keys the virtual path, and a glob its directory', () => {
    expect(
      indexKey('/m/', new PathSpec({ virtual: '/m/a/b', directory: '/m/a/', vfsPath: 'a/b' })),
    ).toBe('/m/a/b')
    expect(indexKey('/m/', new PathSpec({ virtual: '/m', directory: '/', vfsPath: '' }))).toBe('/m')
    const glob = new PathSpec({
      virtual: '/m/a/*.txt',
      directory: '/m/a/',
      vfsPath: 'a/*.txt',
      pattern: '*.txt',
    })
    expect(indexKey('/m/', glob)).toBe('/m/a')
  })
})

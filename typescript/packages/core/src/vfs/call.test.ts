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
import { enoent } from '../errors/fs.ts'
import type { Action, VfsContext } from '../policy/types.ts'
import { runWithSession } from '../context/session_context.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../types.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { SessionState } from '../workspace/session/session.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { RAMVFS } from './ram/ram.ts'
import { BaseVFS } from './base.ts'
import { callNames, declaredCalls, vfsCall } from './call.ts'
import { Effect, Target } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A cached flat store with functions of its own. */
class Shelf extends BaseVFS {
  override readonly name: string = 'shelf'
  override readonly cachesReads: boolean = true
  readonly files = new Map<string, Uint8Array>([['a.txt', ENC.encode('old\n')]])

  override readdir(_path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].sort().map((name) => `/shelf/${name}`))
  }

  override read(path: PathSpec): Promise<Uint8Array> {
    const data = this.files.get(path.vfsPath.replace(/^\/+/, ''))
    return data === undefined ? Promise.reject(enoent(path)) : Promise.resolve(data)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    const key = path.vfsPath.replace(/^\/+/, '')
    if (key === '') return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
    const data = this.files.get(key)
    if (data === undefined) return Promise.reject(enoent(path))
    return Promise.resolve(new FileStat({ name: key, type: FileType.FILE, size: data.length }))
  }

  @vfsCall({ effect: Effect.READ })
  peek(path: PathSpec): Promise<string> {
    return Promise.resolve(path.virtual)
  }

  @vfsCall({ effect: Effect.READ })
  compare(_path: PathSpec, other: PathSpec): Promise<string> {
    return Promise.resolve(other.vfsPath)
  }

  @vfsCall({ effect: Effect.WRITE })
  shelve(path: PathSpec): Promise<void> {
    this.files.set(path.vfsPath.replace(/^\/+/, ''), ENC.encode('new\n'))
    return Promise.resolve()
  }

  @vfsCall({ effect: Effect.WRITE })
  copyTo(path: PathSpec, target: PathSpec): Promise<void> {
    const data = this.files.get(path.vfsPath.replace(/^\/+/, ''))
    if (data !== undefined) this.files.set(target.vfsPath.replace(/^\/+/, ''), data)
    return Promise.resolve()
  }
}

// What each built-in function declares. The Python twin
// (tests/vfs/test_call.py) pins this same table, so a declaration changed
// in one language fails the other language's test.
const BUILT_INS = {
  append: [Effect.WRITE, Target.FILE, true],
  create: [Effect.WRITE, Target.FILE, true],
  mkdir: [Effect.CREATE, Target.DIR, false],
  pwrite: [Effect.WRITE, Target.FILE, true],
  read: [Effect.READ, Target.FILE, false],
  readdir: [Effect.READ, Target.DIR, false],
  rename: [Effect.RENAME, Target.ANY, false],
  rmdir: [Effect.REMOVE, Target.DIR, false],
  setattr: [Effect.ATTR, Target.ANY, false],
  stat: [Effect.METADATA, Target.ANY, false],
  truncate: [Effect.WRITE, Target.FILE, true],
  unlink: [Effect.REMOVE, Target.FILE, false],
  write: [Effect.WRITE, Target.FILE, true],
} as const

describe('declarations', () => {
  it('has the built-ins declare what they do', () => {
    const expected = Object.entries(BUILT_INS).map(([name, [effect, target, creates]]) => [
      name,
      { effect, target, creates },
    ])
    expect([...declaredCalls(BaseVFS)]).toEqual(expected)
  })

  it('defaults a mark to any entry and no create', () => {
    expect(declaredCalls(Shelf).get('shelve')).toEqual({
      effect: Effect.WRITE,
      target: Target.ANY,
      creates: false,
    })
  })

  it.each([
    [Effect.REMOVE, 'unlink and rmdir'],
    [Effect.RENAME, 'rename'],
  ] as const)('lets only the posix calls declare %s', (effect, names) => {
    expect(() => {
      class Discarding extends BaseVFS {
        @vfsCall({ effect })
        discard(): Promise<void> {
          return Promise.resolve()
        }
      }
      return Discarding
    }).toThrow(`discard: only ${names} may declare ${effect.toUpperCase()}`)
  })

  it('keeps the names that match every filter', () => {
    const calls = declaredCalls(BaseVFS)
    expect([...callNames(calls, { effects: [Effect.REMOVE] })].sort()).toEqual(['rmdir', 'unlink'])
    expect([...callNames(calls, { effects: [Effect.REMOVE], targets: [Target.DIR] })]).toEqual([
      'rmdir',
    ])
    expect(callNames(calls, { effects: [Effect.WRITE], creates: false }).size).toBe(0)
    expect(callNames(calls, { targets: [Target.LINK] }).size).toBe(0)
  })
})

describe('VFS functions', () => {
  it('supports a function set on the instance', () => {
    const shelf = new Shelf()
    expect(shelf.supports('write')).toBe(false)
    ;(shelf as unknown as Record<string, unknown>).write = (): Promise<void> => Promise.resolve()
    expect(shelf.supports('write')).toBe(true)
    expect(new MountEntry({ prefix: '/', vfs: shelf }).answers('write')).toBe(true)
  })

  it('runs a function with its own keywords only', async () => {
    const ws = new Workspace({ '/shelf': new Shelf() }, { mode: MountMode.WRITE })
    const misspelled = (name: string): Promise<unknown> =>
      ws.dispatch(name, '/shelf/a.txt', [], { offest: 1 })
    try {
      expect(await ws.dispatch('peek', '/shelf/a.txt')).toBe('/shelf/a.txt')
      await expect(misspelled('peek')).rejects.toThrow(
        "peek() got an unexpected keyword argument 'offest'",
      )
      await expect(misspelled('read')).rejects.toThrow(
        "read() got an unexpected keyword argument 'offest'",
      )
      await ws.dispatch('read', '/shelf/a.txt')
      expect(
        DEC.decode((await ws.dispatch('read', '/shelf/a.txt', [], { offset: 1 })) as Uint8Array),
      ).toBe('ld\n')
      await expect(misspelled('read')).rejects.toThrow(
        "read() got an unexpected keyword argument 'offest'",
      )
    } finally {
      await ws.close()
    }
  })

  it('has a writing function answer to the read-only paths', async () => {
    const shelf = new Shelf()
    shelf.files.set('b.txt', ENC.encode('older\n'))
    const ws = new Workspace({ '/shelf': shelf }, { mode: MountMode.WRITE })
    const session = ws.createSession('rev', {
      profile: parseSessionProfile({
        paths: { show: { '/shelf/a.txt': 'r', '/shelf/b.txt': 'rw' } },
      }),
    })
    try {
      await expect(
        runWithSession(session, () => ws.dispatch('shelve', '/shelf/a.txt')),
      ).rejects.toMatchObject({ code: 'EROFS' })
      await expect(
        runWithSession(session, () =>
          ws.dispatch('copyTo', '/shelf/b.txt', [PathSpec.fromStrPath('/shelf/a.txt')]),
        ),
      ).rejects.toMatchObject({ code: 'EROFS' })
      expect(DEC.decode(shelf.files.get('a.txt'))).toBe('old\n')
    } finally {
      await ws.close()
    }
  })

  it('has policies judge a function by its effect and every path', async () => {
    const seen: [string, boolean, string][] = []
    const ws = new Workspace({ '/shelf': new Shelf() }, { mode: MountMode.WRITE })
    ws.policies.add({
      preVfs(ctx: VfsContext): Action | null {
        seen.push([ctx.op, ctx.write, ctx.path.virtual])
        return null
      },
    })
    try {
      await ws.dispatch('shelve', '/shelf/a.txt')
      await ws.dispatch('compare', '/shelf/a.txt', [PathSpec.fromStrPath('/shelf/b.txt')])
      expect(seen).toEqual([
        ['shelve', true, '/shelf/a.txt'],
        ['compare', false, '/shelf/a.txt'],
        ['compare', false, '/shelf/b.txt'],
      ])
    } finally {
      await ws.close()
    }
  })

  it('passes a second path through the dispatcher', async () => {
    const ws = new Workspace(
      { '/shelf': new Shelf(), '/ram': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    const session = new SessionState({
      sessionId: 'agent',
      visibility: { paths: { paths: ['/shelf/c.txt'] } },
    })
    const compare = (other: string): Promise<unknown> =>
      runWithSession(session, () =>
        ws.dispatch('compare', '/shelf/a.txt', [PathSpec.fromStrPath(other, undefined, '/')]),
      )
    try {
      expect(await compare('/shelf/b.txt')).toBe('b.txt')
      await ws.vfs.symlink('/shelf/l.txt', 'b.txt')
      expect(await compare('/shelf/l.txt')).toBe('b.txt')
      await expect(compare('/shelf/c.txt')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(compare('/shelf/missing/../b.txt')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(compare('/shelf/a.txt/')).rejects.toMatchObject({ code: 'ENOTDIR' })
      for (const elsewhere of ['/ram/b.txt', '/nowhere/b.txt']) {
        await expect(compare(elsewhere)).rejects.toMatchObject({ code: 'EXDEV' })
      }
    } finally {
      await ws.close()
    }
  })

  it('drops the cached bytes of every path a custom write changed', async () => {
    const shelf = new Shelf()
    shelf.files.set('b.txt', ENC.encode('older\n'))
    const ws = new Workspace({ '/shelf': shelf }, { mode: MountMode.WRITE })
    const read = async (path: string): Promise<string> =>
      DEC.decode((await ws.dispatch('read', path)) as Uint8Array)
    try {
      expect(await read('/shelf/a.txt')).toBe('old\n')
      expect(await read('/shelf/b.txt')).toBe('older\n')
      await ws.dispatch('shelve', '/shelf/a.txt')
      await ws.dispatch('copyTo', '/shelf/a.txt', [PathSpec.fromStrPath('/shelf/b.txt')])
      expect(await read('/shelf/a.txt')).toBe('new\n')
      expect(await read('/shelf/b.txt')).toBe('new\n')
    } finally {
      await ws.close()
    }
  })
})

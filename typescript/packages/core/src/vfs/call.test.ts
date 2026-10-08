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
import { FileStat, FileType, MountMode, type PathSpec } from '../types.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { BaseVFS } from './base.ts'
import { vfsCall } from './call.ts'
import { Effect } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A cached flat store whose one custom function rewrites a file. */
class Shelf extends BaseVFS {
  override readonly name: string = 'shelf'
  override readonly cachesReads: boolean = true
  readonly files = new Map<string, Uint8Array>([['a.txt', ENC.encode('old\n')]])
  readonly stamped: string[] = []

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

  @vfsCall({ effect: Effect.WRITE })
  shelve(path: PathSpec): Promise<void> {
    this.files.set(path.vfsPath.replace(/^\/+/, ''), ENC.encode('new\n'))
    this.stamped.push(path.virtual)
    return Promise.resolve()
  }

  @vfsCall({ effect: Effect.READ })
  peek(path: PathSpec): Promise<string> {
    return Promise.resolve(path.virtual)
  }
}

describe('VFS functions', () => {
  it('supports a function set on the instance', () => {
    const shelf = new Shelf()
    expect(shelf.supports('write')).toBe(false)
    ;(shelf as unknown as Record<string, unknown>).write = (): Promise<void> => Promise.resolve()
    expect(shelf.supports('write')).toBe(true)
    expect(new MountEntry({ prefix: '/', vfs: shelf }).answers('write')).toBe(true)
  })

  it('has policies judge a custom function by its effect', async () => {
    const shelf = new Shelf()
    const seen: [string, boolean][] = []
    const ws = new Workspace({ '/shelf': shelf }, { mode: MountMode.WRITE })
    ws.policies.add({
      preVfs(ctx: VfsContext): Action | null {
        seen.push([ctx.op, ctx.write])
        return ctx.write ? { kind: 'deny', reason: 'read-only agent' } : null
      },
    })
    try {
      await expect(ws.dispatch('shelve', '/shelf/a.txt')).rejects.toThrow()
      expect(await ws.dispatch('peek', '/shelf/a.txt')).toBe('/shelf/a.txt')
      expect(seen).toContainEqual(['shelve', true])
      expect(seen).toContainEqual(['peek', false])
      expect(shelf.stamped).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('drops the cached bytes a custom write changed', async () => {
    const ws = new Workspace({ '/shelf': new Shelf() }, { mode: MountMode.WRITE })
    try {
      expect(DEC.decode((await ws.dispatch('read', '/shelf/a.txt')) as Uint8Array)).toBe('old\n')
      await ws.dispatch('shelve', '/shelf/a.txt')
      expect(DEC.decode((await ws.dispatch('read', '/shelf/a.txt')) as Uint8Array)).toBe('new\n')
    } finally {
      await ws.close()
    }
  })
})

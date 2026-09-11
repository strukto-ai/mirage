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
import { ContentType, FileStat, FileType, PathSpec } from '../types.ts'
import { VisibleRemnant, childSpec, entryName, removeRemnants, visibleBelow } from './remnants.ts'

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual.replace(/^\/+/, ''),
  })
}

function nothingVisible(): boolean {
  return false
}

function miss(virtual: string): Error {
  const err = new Error(`ENOENT: ${virtual}`) as Error & { code: string }
  err.code = 'ENOENT'
  return err
}

class TreeChannel {
  dirs: Set<string>
  files: Set<string>
  removed: [string, string][] = []
  readonly_ = new Set<string>()
  // Listed but gone by stat time: the mid-walk vanish case.
  ghosts = new Set<string>()

  constructor(dirs: string[], files: string[]) {
    this.dirs = new Set(dirs)
    this.files = new Set(files)
  }

  readdir(at: PathSpec): Promise<string[]> {
    const base = at.virtual.replace(/\/+$/, '')
    if (!this.dirs.has(base)) return Promise.reject(miss(base))
    const names = new Set<string>()
    for (const p of [...this.dirs, ...this.files, ...this.ghosts]) {
      if (p.startsWith(`${base}/`)) {
        names.add(p.slice(base.length + 1).split('/', 1)[0] ?? '')
      }
    }
    return Promise.resolve([...names].sort())
  }

  stat(at: PathSpec): Promise<FileStat> {
    if (this.dirs.has(at.virtual)) {
      return Promise.resolve(new FileStat({ name: at.virtual, type: FileType.DIRECTORY }))
    }
    if (this.files.has(at.virtual)) {
      return Promise.resolve(
        new FileStat({ name: at.virtual, type: FileType.FILE, content: ContentType.TEXT }),
      )
    }
    return Promise.reject(miss(at.virtual))
  }

  unlink(at: PathSpec): Promise<void> {
    if (this.readonly_.has(at.virtual)) {
      const err = new Error(`EROFS: ${at.virtual}`) as Error & { code: string }
      err.code = 'EROFS'
      return Promise.reject(err)
    }
    if (!this.files.has(at.virtual)) return Promise.reject(miss(at.virtual))
    this.files.delete(at.virtual)
    this.removed.push(['unlink', at.virtual])
    return Promise.resolve()
  }

  rmdir(at: PathSpec): Promise<void> {
    if (!this.dirs.has(at.virtual)) return Promise.reject(miss(at.virtual))
    this.dirs.delete(at.virtual)
    this.removed.push(['rmdir', at.virtual])
    return Promise.resolve()
  }
}

describe('removeRemnants', () => {
  it('removes a nested tree children first', async () => {
    const ch = new TreeChannel(['/d', '/d/sub'], ['/d/a', '/d/sub/b'])
    await removeRemnants(ch, nothingVisible, spec('/d'))
    expect(ch.dirs.size).toBe(0)
    expect(ch.files.size).toBe(0)
    const unlinked = ch.removed.findIndex(([, p]) => p === '/d/sub/b')
    const subGone = ch.removed.findIndex(([op, p]) => op === 'rmdir' && p === '/d/sub')
    expect(unlinked).toBeLessThan(subGone)
    expect(ch.removed[ch.removed.length - 1]).toEqual(['rmdir', '/d'])
  })

  it('aborts on a visible entry before it is touched', async () => {
    const ch = new TreeChannel(['/d', '/d/sec'], ['/d/sec/k', '/d/sec/new.txt'])
    await expect(
      removeRemnants(ch, (v) => v === '/d/sec/new.txt', spec('/d')),
    ).rejects.toBeInstanceOf(VisibleRemnant)
    expect(ch.files.has('/d/sec/new.txt')).toBe(true)
    expect(ch.dirs.has('/d')).toBe(true)
    expect(ch.dirs.has('/d/sec')).toBe(true)
  })

  it('treats entries vanished mid-walk as completed removals', async () => {
    const ch = new TreeChannel(['/d'], ['/d/a'])
    ch.ghosts.add('/d/ghost')
    await removeRemnants(ch, nothingVisible, spec('/d'))
    expect(ch.dirs.size).toBe(0)
    expect(ch.files.size).toBe(0)
  })

  it('is done when the directory vanished before its listing', async () => {
    const ch = new TreeChannel([], [])
    await removeRemnants(ch, nothingVisible, spec('/d'))
    expect(ch.removed).toEqual([])
  })

  it('propagates a channel refusal to the caller', async () => {
    // The channel carries the plane's mode axis; a read-only entry
    // refuses the deletion and the cascade must surface that, so the
    // arm can fall back to its original refusal.
    const ch = new TreeChannel(['/d'], ['/d/k'])
    ch.readonly_.add('/d/k')
    await expect(removeRemnants(ch, nothingVisible, spec('/d'))).rejects.toMatchObject({
      code: 'EROFS',
    })
    expect(ch.dirs.has('/d')).toBe(true)
    expect(ch.files.has('/d/k')).toBe(true)
  })
})

describe('visibleBelow', () => {
  it('normalizes slashes and whole paths to child names', () => {
    const seen: string[] = []
    const probe = (v: string): boolean => {
      seen.push(v)
      return v === '/d/pub'
    }
    expect(visibleBelow('/d/', ['sec/', '/d/pub'], probe)).toBe(true)
    expect(seen).toEqual(['/d/sec', '/d/pub'])
    expect(visibleBelow('/d', ['sec', 'hidden.txt'], nothingVisible)).toBe(false)
  })
})

describe('entryName', () => {
  it('takes the last component', () => {
    expect(entryName('sub/')).toBe('sub')
    expect(entryName('/a/b/c')).toBe('c')
    expect(entryName('plain')).toBe('plain')
  })
})

describe('childSpec', () => {
  it('appends to the resource key', () => {
    const parent = new PathSpec({ virtual: '/m/d', directory: '/m', resourcePath: 'd' })
    const child = childSpec(parent, 'x')
    expect(child.virtual).toBe('/m/d/x')
    expect(child.resourcePath).toBe('d/x')
    const root = new PathSpec({ virtual: '/m', directory: '/', resourcePath: '' })
    expect(childSpec(root, 'x').resourcePath).toBe('x')
  })
})

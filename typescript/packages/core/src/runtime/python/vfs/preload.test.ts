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
import { preloadInto } from './preload.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { ContentType, DEVICE_NUMBERS_KEY, FileStat, FileType } from '../../../types.ts'
import { CHAR_MODE } from '../../../utils/stat_view.ts'
import type { BridgeDispatchFn } from '../../types.ts'
import { PrefixResolver } from '../../resolver.ts'
import { MirageFsSeed } from './seed.ts'

interface FakeFS {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
  symlink?(path: string, target: string): void
  _dirs: Set<string>
  _files: Map<string, Uint8Array>
  _links: Map<string, string>
}

function makeFakeFS(withLinks = true): FakeFS {
  const dirs = new Set<string>()
  const files = new Map<string, Uint8Array>()
  const links = new Map<string, string>()
  return {
    _dirs: dirs,
    _files: files,
    _links: links,
    mkdirTree(path) {
      dirs.add(path)
    },
    writeFile(path, bytes) {
      files.set(path, bytes)
    },
    ...(withLinks
      ? {
          symlink(path: string, target: string) {
            links.set(path, target)
          },
        }
      : {}),
  }
}

// The door builds each row from a name plus one stat, so a double
// standing in for the bridge has to answer both.
function fileStat(size: number): FileStat {
  return new FileStat({ name: 'f', size, type: FileType.FILE, content: ContentType.TEXT })
}

function dirStat(): FileStat {
  return new FileStat({ name: 'd', type: FileType.DIRECTORY })
}

// A resolver whose name plane holds exactly these link names.
function linksOn(names: string[]): PrefixResolver {
  return new PrefixResolver(
    () => ['/ram/'],
    () => new Set(names),
  )
}

describe('preloadInto', () => {
  it('creates the prefix directory and writes flat files', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') {
        return Promise.resolve(['/ram/a.txt', '/ram/b.bin'])
      }
      if (op === 'stat' && path === '/ram/a.txt') return Promise.resolve(fileStat(5))
      if (op === 'stat' && path === '/ram/b.bin') return Promise.resolve(fileStat(3))
      if (op === 'read' && path === '/ram/a.txt')
        return Promise.resolve(new TextEncoder().encode('hello'))
      if (op === 'read' && path === '/ram/b.bin') return Promise.resolve(new Uint8Array([1, 2, 3]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(new TextDecoder().decode(fs._files.get('/ram/a.txt'))).toBe('hello')
    const bbin = fs._files.get('/ram/b.bin')
    if (bbin === undefined) throw new Error('unreachable')
    expect(Array.from(bbin)).toEqual([1, 2, 3])
  })

  it('seeds a character device without trying to whole-read it', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/dev/') return Promise.resolve(['/dev/zero'])
      if (op === 'stat' && path === '/dev/zero') {
        return Promise.resolve(
          new FileStat({
            name: 'zero',
            type: FileType.CHAR_DEVICE,
            extra: { [DEVICE_NUMBERS_KEY]: [1, 5] },
          }),
        )
      }
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const seed = new MirageFsSeed()
    await preloadInto(seed, new RuntimeVFS(dispatch), '/dev/')
    expect(seed.devices.get('/dev/zero')).toEqual({ mode: CHAR_MODE, rdev: 0x105 })
    expect(dispatch.mock.calls.every(([op]) => op !== 'read')).toBe(true)
  })

  // The row already carries both (the door stats every entry it does not
  // slash-mark), so the seed gets the mount's metadata for free. Without
  // it every seeded node reported 0o644 and the moment it was built.
  it('carries each row mode and stamp onto the seed', async () => {
    const stat = new FileStat({
      name: 'a.txt',
      size: 5,
      type: FileType.FILE,
      content: ContentType.TEXT,
      mode: 0o600,
      modified: '2026-07-15T00:00:00Z',
    })
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/a.txt'])
      if (op === 'stat' && path === '/ram/a.txt') return Promise.resolve(stat)
      if (op === 'read' && path === '/ram/a.txt') return Promise.resolve(new Uint8Array([1]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const seed = new MirageFsSeed()
    await preloadInto(seed, new RuntimeVFS(dispatch), '/ram/')
    expect(seed.modes.get('/ram/a.txt')).toBe(0o100600)
    expect(seed.stamps.get('/ram/a.txt')).toEqual({
      atimeMs: 1784073600000,
      mtimeMs: 1784073600000,
    })
  })

  // A slash-marked row never stat'd, so there is nothing to carry and
  // the node keeps the tree's default rather than a fabricated one.
  it('records no metadata for a row that carries none', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/sub/'])
      if (op === 'readdir' && path === '/ram/sub/') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const seed = new MirageFsSeed()
    await preloadInto(seed, new RuntimeVFS(dispatch), '/ram/')
    expect(seed.dirs).toContain('/ram/sub/')
    expect(seed.modes.size).toBe(0)
    expect(seed.stamps.size).toBe(0)
  })

  it('recurses into subdirectories', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/sub'])
      if (op === 'stat' && path === '/ram/sub') return Promise.resolve(dirStat())
      if (op === 'readdir' && path === '/ram/sub/') return Promise.resolve(['/ram/sub/c.txt'])
      if (op === 'stat' && path === '/ram/sub/c.txt') return Promise.resolve(fileStat(1))
      if (op === 'read' && path === '/ram/sub/c.txt') return Promise.resolve(new Uint8Array([7]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')
    expect(fs._dirs.has('/ram/sub')).toBe(true)
    const ctxt = fs._files.get('/ram/sub/c.txt')
    if (ctxt === undefined) throw new Error('unreachable')
    expect(Array.from(ctxt)).toEqual([7])
  })

  it('is idempotent: re-running overwrites with the mount content', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/x'])
      if (op === 'stat' && path === '/ram/x') return Promise.resolve(fileStat(1))
      if (op === 'read' && path === '/ram/x') return Promise.resolve(new Uint8Array([42]))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    const vfs = new RuntimeVFS(dispatch)
    await preloadInto(fs, vfs, '/ram/')
    fs.writeFile('/ram/x', new Uint8Array([99]))
    await preloadInto(fs, vfs, '/ram/')
    const x = fs._files.get('/ram/x')
    if (x === undefined) throw new Error('unreachable')
    expect(Array.from(x)).toEqual([42])
  })

  it('handles empty mounts (readdir returns [])', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) =>
      Promise.resolve(op === 'readdir' ? [] : new Uint8Array()),
    )
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(fs._files.size).toBe(0)
  })

  it('accepts a prefix without trailing slash and lists with one', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram')
    expect(fs._dirs.has('/ram')).toBe(true)
    expect(dispatch).toHaveBeenCalledWith('readdir', '/ram/')
  })

  it('skips a single failing entry and still preloads the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') {
        return Promise.resolve(['/ram/ok.txt', '/ram/bad.txt'])
      }
      if (op === 'stat' && path === '/ram/ok.txt') return Promise.resolve(fileStat(2))
      if (op === 'stat' && path === '/ram/bad.txt') return Promise.resolve(fileStat(4))
      if (op === 'read' && path === '/ram/ok.txt') return Promise.resolve(new Uint8Array([1, 2]))
      if (op === 'read' && path === '/ram/bad.txt') return Promise.reject(new Error('unreadable'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')
    const ok = fs._files.get('/ram/ok.txt')
    if (ok === undefined) throw new Error('unreachable')
    expect(Array.from(ok)).toEqual([1, 2])
    expect(fs._files.has('/ram/bad.txt')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips a failing subtree and still preloads sibling files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') {
        return Promise.resolve(['/ram/ok.txt', '/ram/bad'])
      }
      if (op === 'stat' && path === '/ram/ok.txt') return Promise.resolve(fileStat(1))
      if (op === 'stat' && path === '/ram/bad') return Promise.resolve(dirStat())
      if (op === 'read' && path === '/ram/ok.txt') return Promise.resolve(new Uint8Array([7]))
      if (op === 'readdir' && path === '/ram/bad/') return Promise.reject(new Error('subtree fail'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')
    const ok = fs._files.get('/ram/ok.txt')
    if (ok === undefined) throw new Error('unreachable')
    expect(Array.from(ok)).toEqual([7])
    expect(fs._dirs.has('/ram/bad')).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('lets the top-level readdir error propagate', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('top-level boom')))
    const fs = makeFakeFS()
    await expect(preloadInto(fs, new RuntimeVFS(dispatch), '/ram/')).rejects.toThrow(
      /top-level boom/,
    )
  })

  // A nested mount is served through its parent's walk (syncMounts
  // collapses to maximal prefixes), but it keeps the failure boundary it
  // had as a top-level prefix: degrading its root readdir failure to an
  // empty directory would let syncMounts replace a healthy snapshot with
  // one where the nested mount reads as empty.
  it('lets a nested mount root readdir failure fail the whole collection', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') {
        return Promise.resolve(['/ram/ok.txt', '/ram/inner'])
      }
      if (op === 'stat' && path === '/ram/ok.txt') return Promise.resolve(fileStat(1))
      if (op === 'stat' && path === '/ram/inner') return Promise.resolve(dirStat())
      if (op === 'read' && path === '/ram/ok.txt') return Promise.resolve(new Uint8Array([7]))
      if (op === 'readdir' && path === '/ram/inner/') return Promise.reject(new Error('inner boom'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    const vfs = new RuntimeVFS(dispatch, new PrefixResolver(() => ['/ram/', '/ram/inner/']))
    await expect(preloadInto(fs, vfs, '/ram/')).rejects.toThrow(/inner boom/)
  })

  // A link is copied as a link, never followed: stat reports the target,
  // so a directory link would copy its whole subtree and a cyclic one
  // would never terminate.
  it('copies a link as a link and does not walk it', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/loop'])
      // A link to a directory stats as one, which is exactly why the
      // mark has to be consulted before the row's isDir.
      if (op === 'stat' && path === '/ram/loop') return Promise.resolve(dirStat())
      if (op === 'readlink' && path === '/ram/loop') return Promise.resolve('/ram')
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch, linksOn(['loop'])), '/ram/')
    expect(fs._links.get('/ram/loop')).toBe('/ram')
    expect(fs._dirs.has('/ram/loop')).toBe(false)
  })

  it('skips a link the namespace listed but will not resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/l'])
      if (op === 'stat' && path === '/ram/l') return Promise.resolve(fileStat(0))
      if (op === 'readlink') return Promise.reject(new Error('link vanished'))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS()
    await preloadInto(fs, new RuntimeVFS(dispatch, linksOn(['l'])), '/ram/')
    expect(fs._links.size).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // A target that cannot hold links omits them without paying for the
  // readlink, which is what every seed did before links were reachable.
  it('does not read a link target when the target cannot hold one', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/l'])
      if (op === 'stat' && path === '/ram/l') return Promise.resolve(fileStat(0))
      return Promise.reject(new Error(`unexpected ${op} ${path}`))
    })
    const fs = makeFakeFS(false)
    await preloadInto(fs, new RuntimeVFS(dispatch, linksOn(['l'])), '/ram/')
    expect(fs._links.size).toBe(0)
    expect(dispatch).not.toHaveBeenCalledWith('readlink', '/ram/l')
  })
})

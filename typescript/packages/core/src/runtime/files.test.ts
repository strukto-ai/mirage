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
import { enotsup } from '../errors/fs.ts'
import { ContentType, DEVICE_NUMBERS_KEY, FileStat, FileType } from '../types.ts'
import { CHAR_MODE, DIR_MODE, DIR_SIZE, FILE_MODE, LINK_MODE } from '../utils/stat_view.ts'
import { LISTING_ENTRY_CONCURRENCY } from './constants.ts'
import { CrossMountError } from './errors.ts'
import type { BridgeDispatchFn } from './types.ts'
import { RuntimeFiles } from './files.ts'
import { PrefixResolver } from './resolver.ts'

const enc = new TextEncoder()

describe('RuntimeFiles transport', () => {
  it('forwards read to dispatch read and returns bytes', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    const out = await new RuntimeFiles(dispatch).read('/ram/x.txt')
    expect(dispatch).toHaveBeenCalledWith('read', '/ram/x.txt', undefined, undefined, {})
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('forwards a ranged and a raw read as the read attrs', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new Uint8Array([2])))
    const files = new RuntimeFiles(dispatch)
    await files.read('/ram/x.txt', { offset: 1, size: 1 })
    await files.read('/ram/x.txt', { raw: true })
    expect(dispatch.mock.calls.map((call) => call[4])).toEqual([
      { offset: 1, size: 1 },
      { raw: true },
    ])
  })

  it('forwards write to dispatch write with bytes and resolves void', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch).write('/ram/x.txt', new Uint8Array([9, 9]))
    const call = dispatch.mock.calls[0]
    if (call === undefined) throw new Error('unreachable')
    const [op, path, bytes] = call
    if (bytes === undefined) throw new Error('unreachable')
    expect(op).toBe('write')
    expect(path).toBe('/ram/x.txt')
    expect(Array.from(bytes)).toEqual([9, 9])
  })

  it('resolves each readdir name through stat', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt', '/ram/sub'])
      return Promise.resolve(
        path === '/ram/sub'
          ? new FileStat({ name: 'sub', type: FileType.DIRECTORY })
          : new FileStat({
              name: 'a.txt',
              size: 4,
              type: FileType.FILE,
              content: ContentType.TEXT,
            }),
      )
    })
    const entries = await new RuntimeFiles(dispatch).readdir('/ram/')
    expect(entries).toEqual([
      { path: '/ram/a.txt', size: 4, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
      { path: '/ram/sub', size: DIR_SIZE, isDir: true, mode: DIR_MODE, mtimeMs: 0 },
    ])
  })

  it('carries the owner and access time a stat gave on a listing row', async () => {
    // A guest placing a tree from one listing reads its owner and access
    // time off the row, so a listed file must not stat as owned by root.
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt'])
      return Promise.resolve(
        new FileStat({
          name: 'a.txt',
          size: 4,
          type: FileType.FILE,
          content: ContentType.TEXT,
          uid: 501,
          gid: 20,
          atime: '2001-02-03T04:05:06Z',
        }),
      )
    })
    const [row] = await new RuntimeFiles(dispatch).readdir('/ram/')
    expect([row?.uid, row?.gid, row?.atimeMs]).toEqual([501, 20, 981173106000])
  })

  // The projection is the file adapter's, so preview1, monty and Emscripten read
  // the same five facts instead of translating a FileStat three ways.
  it('projects one stat struct for every surface', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve(
        new FileStat({
          name: 'a.txt',
          size: 4,
          type: FileType.FILE,
          content: ContentType.TEXT,
          mode: 0o700,
          modified: '2026-07-15T00:00:00Z',
        }),
      ),
    )
    expect(await new RuntimeFiles(dispatch).stat('/ram/a.txt')).toEqual({
      size: 4,
      isDir: false,
      mode: (FILE_MODE & ~0o7777) | 0o700,
      mtimeMs: 1784073600000,
    })
  })

  it('reports an unknown stamp as absent', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve(
        new FileStat({ name: 'a.txt', size: 1, type: FileType.FILE, content: ContentType.TEXT }),
      ),
    )
    expect((await new RuntimeFiles(dispatch).stat('/ram/a.txt')).mtimeMs).toBeUndefined()
  })

  it('projects character type bits and logical device numbers', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve(
        new FileStat({
          name: 'zero',
          type: FileType.CHAR_DEVICE,
          extra: { [DEVICE_NUMBERS_KEY]: [1, 5] },
        }),
      ),
    )
    expect(await new RuntimeFiles(dispatch).stat('/dev/zero')).toEqual({
      size: 0,
      isDir: false,
      mode: CHAR_MODE,
      rdev: 0x105,
    })
  })

  // lstat is one dispatcher question now, not a surface reaching past it: the
  // flag rides the dispatch, which answers a link's own row from the
  // node table and gates it exactly as it gates readlink.
  it('asks for the link row itself under nofollow', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.resolve(new FileStat({ name: 'lnk', size: 8, type: FileType.SYMLINK })),
    )
    const st = await new RuntimeFiles(dispatch).stat('/ram/lnk', true)
    expect(dispatch).toHaveBeenCalledWith('stat', '/ram/lnk', undefined, undefined, {
      nofollow: true,
    })
    expect(st).toEqual({ size: 8, isDir: false, mode: LINK_MODE, isLink: true })
  })

  // A backend that slash-marks its directories has already said what the
  // entry is, so the file adapter does not pay a stat to hear it again.
  it('takes a trailing slash as the answer and skips the stat', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/sub/'])
      throw new Error('stat should not be called')
    })
    expect(await new RuntimeFiles(dispatch).readdir('/ram/')).toEqual([
      { path: '/ram/sub/', size: 0, isDir: true },
    ])
  })

  // A dangling link, or an entry that vanished between the listing and
  // the stat, must not fail the whole listing.
  it('degrades a missing entry to a zero row', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/gone'])
      return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await new RuntimeFiles(dispatch).readdir('/ram/')).toEqual([
        { path: '/ram/gone', size: 0, isDir: false },
      ])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  // One record a remote API refuses must not cost the guest the whole
  // directory: the row rides unclassified and the guest's own open of
  // it reports the failure.
  it('keeps the listing when one entry stat fails', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt', '/ram/bad.txt'])
      if (path === '/ram/bad.txt') return Promise.reject(new Error('upstream 502 Bad Gateway'))
      return Promise.resolve(new FileStat({ name: 'a.txt', size: 4, type: FileType.FILE }))
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stdout = (['debug', 'log', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    )
    try {
      expect(await new RuntimeFiles(dispatch).readdir('/ram/')).toEqual([
        { path: '/ram/a.txt', size: 4, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
        { path: '/ram/bad.txt', size: 0, isDir: false },
      ])
      expect(warn.mock.calls).toEqual([
        ['runtime files: readdir /ram/: stat /ram/bad.txt: Error: upstream 502 Bad Gateway'],
      ])
      for (const spy of stdout) expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('still fails when the listing itself fails', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('401 Unauthorized')))
    await expect(new RuntimeFiles(dispatch).readdir('/ram/')).rejects.toThrow('401 Unauthorized')
  })

  // On a mount that keeps no listing index every classifying stat is a
  // backend request, so a large directory must not fire them together.
  it('stats at most LISTING_ENTRY_CONCURRENCY entries at once', async () => {
    let inFlight = 0
    let peak = 0
    const names = Array.from({ length: 100 }, (_, i) => `/ram/${String(i)}.json`)
    const dispatch = vi.fn<BridgeDispatchFn>(async (op) => {
      if (op === 'readdir') return names
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return new FileStat({ name: 'x', size: 1, type: FileType.FILE })
    })
    const entries = await new RuntimeFiles(dispatch).readdir('/ram/')
    expect(entries).toHaveLength(100)
    expect(peak).toBe(LISTING_ENTRY_CONCURRENCY)
  })

  // A guest that only wants names pays for the listing and nothing else,
  // the way a POSIX readdir costs one call.
  it('stats nothing when asked for names only', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/a.txt', '/ram/sub/'])
      throw new Error('stat should not be called')
    })
    expect(await new RuntimeFiles(dispatch).readdir('/ram/', false)).toEqual([
      { path: '/ram/a.txt', size: 0, isDir: false },
      { path: '/ram/sub/', size: 0, isDir: true },
    ])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // The mark is the name plane's, since no backend listing reports a
  // link, and a marked row is the link's own, as a guest's lstat reads
  // it: the node table answers, no backend.
  it('marks the names the resolver calls links, with their own rows', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, _path, _bytes, _dst, attrs) => {
      if (op === 'readdir') return Promise.resolve(['/ram/lnk', '/ram/a.txt'])
      if (attrs?.nofollow === true)
        return Promise.resolve(new FileStat({ name: 'lnk', size: 8, type: FileType.SYMLINK }))
      return Promise.resolve(
        new FileStat({ name: 'x', size: 2, type: FileType.FILE, content: ContentType.TEXT }),
      )
    })
    const resolver = new PrefixResolver(
      () => ['/ram/'],
      () => new Set(['lnk']),
    )
    expect(await new RuntimeFiles(dispatch, resolver).readdir('/ram/')).toEqual([
      { path: '/ram/lnk', size: 8, isDir: false, mode: LINK_MODE, mtimeMs: 0, isLink: true },
      { path: '/ram/a.txt', size: 2, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
    ])
  })

  // Every shape a backend answers in reaches the same mark: the name is
  // the part they agree on.
  it('marks a link whatever shape the entry arrived in', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['lnk', '/ram/dirlink/'])
      return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    })
    const resolver = new PrefixResolver(
      () => ['/ram/'],
      () => new Set(['lnk', 'dirlink']),
    )
    expect(await new RuntimeFiles(dispatch, resolver).readdir('/ram/')).toEqual([
      { path: 'lnk', size: 0, isDir: false, isLink: true },
      { path: '/ram/dirlink/', size: 0, isDir: true, isLink: true },
    ])
  })

  it('marks nothing when no link source was supplied', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'readdir') return Promise.resolve(['/ram/lnk'])
      return Promise.resolve(
        new FileStat({ name: 'lnk', size: 0, type: FileType.FILE, content: ContentType.TEXT }),
      )
    })
    const entries = await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/ram/'])).readdir(
      '/ram/',
    )
    expect(entries).toEqual([
      { path: '/ram/lnk', size: 0, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
    ])
  })

  // The target rides the `dst` slot: it is the op's second string and a
  // link stores it verbatim, so there is nothing a separate slot would
  // say.
  it('forwards symlink to dispatch symlink with the target', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch).symlink('/ram/link', '../t.txt')
    expect(dispatch).toHaveBeenCalledWith('symlink', '/ram/link', undefined, '../t.txt')
  })

  it('forwards readlink and returns the target', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve('../t.txt'))
    const out = await new RuntimeFiles(dispatch).readlink('/ram/link')
    expect(dispatch).toHaveBeenCalledWith('readlink', '/ram/link')
    expect(out).toBe('../t.txt')
  })

  it('forwards setattr with the fields it was given', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch).setattr('/ram/f', { mode: 0o600, nofollow: true })
    expect(dispatch).toHaveBeenCalledWith('setattr', '/ram/f', undefined, undefined, {
      mode: 0o600,
      nofollow: true,
    })
  })

  it('rethrows dispatch errors', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('boom')))
    await expect(new RuntimeFiles(dispatch).read('/x')).rejects.toThrow(/boom/)
  })

  // A bridge answer of the wrong shape is a TypeError, never a value a
  // guest encoder would then misread.
  it.each<[string, unknown, (vfs: RuntimeFiles) => Promise<unknown>, RegExp]>([
    ['read', 'not bytes', (vfs) => vfs.read('/x'), /./],
    ['readdir', { not: 'array' }, (vfs) => vfs.readdir('/x'), /./],
    ['a readdir entry', [{ path: '/x' }], (vfs) => vfs.readdir('/x'), /./],
    ['write', 'unexpected', (vfs) => vfs.write('/x', new Uint8Array([1])), /./],
    ['stat', { size: 4 }, (vfs) => vfs.stat('/ram/a.txt'), /bad shape/],
    ['readlink', 7, (vfs) => vfs.readlink('/ram/link'), /expected string/],
  ])('refuses a %s answer of the wrong shape', async (_op, answer, call, message) => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(answer as never))
    const refused = call(new RuntimeFiles(dispatch))
    await expect(refused).rejects.toThrow(TypeError)
    await expect(refused).rejects.toThrow(message)
  })

  it('forwards create and truncate as their own ops, never a write', async () => {
    // The bridge used to lack both verbs, so quickjs faked them with
    // write: the ledger recorded the wrong op and a backend with a
    // native truncate got a whole-file write instead.
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = new RuntimeFiles(dispatch)
    await vfs.create('/ram/new.txt')
    await vfs.truncate('/ram/old.txt')
    expect(dispatch.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['create', '/ram/new.txt'],
      ['truncate', '/ram/old.txt'],
    ])
  })
})

describe('RuntimeFiles routing', () => {
  const noop = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))

  it('normalizes prefixes to a trailing slash, longest first', () => {
    const vfs = new RuntimeFiles(noop, new PrefixResolver(() => ['/a', '/a/deep/', '/b']))
    expect(vfs.prefixes()).toEqual(['/a/deep/', '/a/', '/b/'])
  })

  it('picks the longest matching mount, and the prefix itself counts', () => {
    const vfs = new RuntimeFiles(noop, new PrefixResolver(() => ['/a', '/a/deep']))
    expect(vfs.mountOf('/a/deep/x')).toBe('/a/deep/')
    expect(vfs.mountOf('/a/deep')).toBe('/a/deep/')
    expect(vfs.mountOf('/a/x')).toBe('/a/')
    expect(vfs.mountOf('/elsewhere')).toBeNull()
  })

  it('answers no mount when none are wired', () => {
    expect(new RuntimeFiles(noop).mountOf('/a/x')).toBeNull()
  })

  it('refuses a rename whose ends are on different mounts', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a', '/b']))
    await expect(vfs.rename('/a/x', '/b/x')).rejects.toThrow(CrossMountError)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches a rename within one mount', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).rename('/a/x', '/a/y')
    expect(dispatch).toHaveBeenCalledWith('rename', '/a/x', undefined, '/a/y')
  })
})

// A dispatcher over an empty world, or one where every op is refused.
function world(refusal?: Error): { vfs: RuntimeFiles } {
  const dispatch = vi.fn<BridgeDispatchFn>((_op, path) =>
    Promise.reject(refusal ?? Object.assign(new Error(path), { code: 'ENOENT' })),
  )
  return { vfs: new RuntimeFiles(dispatch, new PrefixResolver(() => ['/data/'])) }
}

const F = '/data/f'

describe('RuntimeFiles guest rules', () => {
  it('serves the mounted paths, and every path when none are wired', () => {
    const scoped = new RuntimeFiles(vi.fn(), new PrefixResolver(() => ['/data/']))
    expect(scoped.serves('/data/a.txt')).toBe(true)
    expect(scoped.serves('/tmp/a.txt')).toBe(false)
    expect(new RuntimeFiles(vi.fn()).serves('/tmp/a.txt')).toBe(true)
  })

  // The dispatcher follows a link outside every mount, so what is
  // reached through one is the workspace's too.
  it('serves a path reached through a link outside every mount', () => {
    const links = (directory: string): Set<string> =>
      directory === '/' ? new Set(['alias']) : new Set<string>()
    const files = new RuntimeFiles(vi.fn(), new PrefixResolver(() => ['/data/'], links))
    expect(files.serves('/alias')).toBe(true)
    expect(files.serves('/alias/inner.txt')).toBe(true)
    expect(files.serves('/tmp/a.txt')).toBe(false)
  })

  it('opens structure to view_stat and withholds content', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'stat') {
        if (path === '/data/a.txt' || path === '/.bash_history') {
          return Promise.resolve(new FileStat({ name: path, size: 1, type: FileType.FILE }))
        }
      }
      const listed = ['/', '/parent/', '/.bash_history/']
      if (op === 'readdir' && listed.includes(path)) return Promise.resolve([])
      return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
    })
    const vfs = new RuntimeFiles(dispatch, new PrefixResolver(() => ['/data/']))
    expect((await vfs.viewStat('/data/a.txt'))?.isDir).toBe(false)
    expect(await vfs.viewStat('/parent')).toMatchObject({ isDir: true, mode: DIR_MODE })
    // A withheld file stays unseen though its mount lists it as empty,
    // the way the history mount does so a traversal never descends.
    expect(await vfs.viewStat('/.bash_history')).toBeNull()
  })

  // A backend that will not answer has said nothing about whether the
  // path is there, and "not there" is the one answer a guest cannot
  // tell from the truth.
  it('reads a refusal as itself, never as an absence', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const { vfs } = world(denied)
    await expect(vfs.statOrNull(F)).rejects.toBe(denied)
    await expect(vfs.listingOrNull(F)).rejects.toBe(denied)
    expect(await world().vfs.statOrNull(F)).toBeNull()
    expect(await world().vfs.listingOrNull(F)).toBeNull()
  })
})

describe('RuntimeFiles append', () => {
  it('ships only the tail when the mount takes an append', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['append'])
  })

  it('reads the base fresh when the mount has no append', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.resolve(enc.encode('head'))
      return Promise.resolve(undefined)
    })
    await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    const write = dispatch.mock.calls.find((c) => c[0] === 'write')
    if (write?.[2] === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(write[2])).toBe('headtail')
    const read = dispatch.mock.calls.find((c) => c[0] === 'read')
    expect(read?.[4]).toEqual({ raw: true, direct: true })
  })

  // The fallback reads the base fresh each time: an append lands after
  // whatever the file holds now, as O_APPEND does, so a copy kept from
  // the last append would overwrite another action's write.
  it('keeps a write made since the last append', async () => {
    let stored: Uint8Array = enc.encode('head')
    const dispatch = vi.fn<BridgeDispatchFn>((op, _path, bytes) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.resolve(stored)
      if (op === 'write' && bytes !== undefined) stored = bytes
      return Promise.resolve(undefined)
    })
    const files = new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a']))
    await files.append('/a/x', enc.encode('-1'))
    stored = enc.encode('other')
    await files.append('/a/x', enc.encode('-2'))
    const writes = dispatch.mock.calls.filter((c) => c[0] === 'write')
    expect(writes.map((c) => new TextDecoder().decode(c[2]))).toEqual(['head-1', 'other-2'])
  })

  it('starts from an empty base when the file is simply absent', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.reject(missing)
      return Promise.resolve(undefined)
    })
    await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).append(
      '/a/x',
      enc.encode('tail'),
    )
    const write = dispatch.mock.calls.find((c) => c[0] === 'write')
    if (write?.[2] === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(write[2])).toBe('tail')
  })

  it('propagates a read failure that is not an absence', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.reject(new Error('transport down'))
      return Promise.resolve(undefined)
    })
    await expect(
      new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).append(
        '/a/x',
        enc.encode('tail'),
      ),
    ).rejects.toThrow(/transport down/)
    expect(dispatch.mock.calls.some((c) => c[0] === 'write')).toBe(false)
  })

  it('remembers a mount that declined, so it costs one failed dispatch', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(enotsup('s3', 'append', '/a/x'))
      if (op === 'read') return Promise.resolve(new Uint8Array())
      return Promise.resolve(undefined)
    })
    const vfs = new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a']))
    await vfs.append('/a/x', enc.encode('1'))
    await vfs.append('/a/y', enc.encode('2'))
    expect(dispatch.mock.calls.filter((c) => c[0] === 'append')).toHaveLength(1)
  })

  it('lets a real append failure propagate instead of writing whole', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (op === 'append') return Promise.reject(new Error('mount is read-only'))
      return Promise.resolve(undefined)
    })
    await expect(
      new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).append('/a/x', enc.encode('t')),
    ).rejects.toThrow(/read-only/)
    expect(dispatch.mock.calls.some((c) => c[0] === 'write')).toBe(false)
  })
})

describe('RuntimeFiles flush', () => {
  it('sends each step of a plan in order', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await new RuntimeFiles(dispatch, new PrefixResolver(() => ['/a'])).flush('/a/x', [
      { kind: 'truncate', length: 2 },
      { kind: 'pwrite', data: enc.encode('z'), offset: 4 },
      { kind: 'append', data: enc.encode('!') },
      { kind: 'write', data: enc.encode('w') },
    ])
    expect(dispatch.mock.calls).toEqual([
      ['truncate', '/a/x', undefined, undefined, { length: 2 }],
      ['pwrite', '/a/x', enc.encode('z'), undefined, { offset: 4 }],
      ['append', '/a/x', enc.encode('!')],
      ['write', '/a/x', enc.encode('w')],
    ])
  })
})

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

import { describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeDispatchFn } from '../../types.ts'
import { ContentType, FileStat, FileType } from '../../../types.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { MontyVFS } from './index.ts'
import { PrefixResolver } from '../../resolver.ts'

function viewOn(
  dispatch: BridgeDispatchFn,
  mounts: string[] = ['/ram'],
  links: string[] = [],
): MontyVFS {
  return new MontyVFS(
    new RuntimeVFS(
      dispatch,
      new PrefixResolver(
        () => mounts,
        () => new Set(links),
      ),
    ),
  )
}

// The door builds each row from a name plus one stat, so a double
// standing in for the bridge answers both; a name it did not list stats
// as a missing path.
function listingOf(names: string[]): Mock<BridgeDispatchFn> {
  return vi.fn<BridgeDispatchFn>((op, path) => {
    if (op === 'readdir') return Promise.resolve(names)
    if (op === 'stat') {
      if (!names.includes(path)) {
        return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
      }
      return Promise.resolve(
        new FileStat({ name: path, size: 1, type: FileType.FILE, content: ContentType.TEXT }),
      )
    }
    return Promise.resolve(undefined)
  })
}

describe('MontyVFS scoping', () => {
  const noop = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))

  it('serves a path under a mount and declines one outside every mount', () => {
    const vfs = viewOn(noop)
    expect(vfs.serves('/ram/x')).toBe(true)
    expect(vfs.serves('/ram')).toBe(true)
    expect(vfs.serves('/tmp/x')).toBe(false)
  })

  it('serves everything when no mounts are wired', () => {
    // No scoping rather than no service: the runtime is attached but the
    // workspace has no prefixes, so nothing should be withheld.
    expect(viewOn(noop, []).serves('/tmp/x')).toBe(true)
  })
})

describe('MontyVFS guest errors', () => {
  it('names a missing file the way python spells it, so except catches', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
    )
    await expect(viewOn(dispatch).read('/ram/x')).rejects.toMatchObject({
      name: 'FileNotFoundError',
      message: "[Errno 2] No such file or directory: '/ram/x'",
    })
  })

  it('names an existing directory FileExistsError on mkdir', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() =>
      Promise.reject(Object.assign(new Error('there'), { code: 'EEXIST' })),
    )
    await expect(viewOn(dispatch).mkdir('/ram/d')).rejects.toMatchObject({
      name: 'FileExistsError',
    })
  })

  it('leaves an unmapped failure alone rather than inventing an errno', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('transport down')))
    await expect(viewOn(dispatch).read('/ram/x')).rejects.toThrow(/transport down/)
  })

  it('spells a cross-mount rename EXDEV, which is what tells a caller to copy', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    await expect(viewOn(dispatch, ['/ram', '/s3']).rename('/ram/x', '/s3/x')).rejects.toMatchObject(
      {
        name: 'OSError',
        message: "[Errno 18] Invalid cross-device link: '/ram/x' -> '/s3/x'",
      },
    )
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('MontyVFS values', () => {
  it('reports the character count for text and the byte count for bytes', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = viewOn(dispatch)
    expect(await vfs.write('/ram/x', 'héllo')).toBe(5)
    expect(await vfs.write('/ram/y', new Uint8Array([1, 2, 3]))).toBe(3)
    // Code points, not UTF-16 units: python's len('𝄞') is 1.
    expect(await vfs.write('/ram/z', '\u{1d11e}')).toBe(1)
  })

  it('answers readOrNull with null for a miss and the bytes for a hit', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'read' && path === '/ram/a') {
        return Promise.resolve(new TextEncoder().encode('hi'))
      }
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const vfs = viewOn(dispatch)
    expect(await vfs.readOrNull('/ram/a')).toEqual(new TextEncoder().encode('hi'))
    expect(await vfs.readOrNull('/ram/nope')).toBeNull()
    // The miss is remembered, so the second probe costs no dispatch.
    expect(await vfs.readOrNull('/ram/nope')).toBeNull()
    expect(dispatch.mock.calls.filter(([, p]) => p === '/ram/nope')).toHaveLength(1)
  })

  it('readOrNull lets a transport failure propagate rather than faking absence', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('socket hangup')))
    await expect(viewOn(dispatch).readOrNull('/ram/a')).rejects.toThrow('socket hangup')
  })

  it('forwards the establishing ops and the mkdir parents flag to the bridge', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))
    const vfs = viewOn(dispatch)
    await vfs.create('/ram/new')
    await vfs.truncate('/ram/keep')
    await vfs.mkdir('/ram/d')
    await vfs.mkdir('/ram/x/y', true)
    expect(dispatch).toHaveBeenCalledWith('create', '/ram/new')
    expect(dispatch).toHaveBeenCalledWith('truncate', '/ram/keep')
    expect(dispatch).toHaveBeenCalledWith('mkdir', '/ram/d', undefined, undefined, undefined)
    expect(dispatch).toHaveBeenCalledWith('mkdir', '/ram/x/y', undefined, undefined, {
      parents: true,
    })
  })

  it('append rides the delta and keeps the negative cache honest', async () => {
    const appends: Uint8Array[] = []
    const dispatch = vi.fn<BridgeDispatchFn>((op, path, bytes) => {
      if (op === 'append') {
        appends.push(bytes ?? new Uint8Array())
        return Promise.resolve(undefined)
      }
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const vfs = viewOn(dispatch)
    await expect(vfs.read('/ram/log')).rejects.toThrow()
    await vfs.append('/ram/log', new Uint8Array([98]), new Uint8Array([97, 98]))
    expect(appends).toEqual([new Uint8Array([98])])
    // The append forgot the remembered absence.
    expect(await vfs.readOrNull('/ram/log')).toBeNull()
    expect(dispatch.mock.calls.filter(([op]) => op === 'read')).toHaveLength(2)
  })

  it('lists a directory through its slash-terminated prefix', async () => {
    const dispatch = listingOf(['/ram/d/a'])
    const entries = await viewOn(dispatch).readdir('/ram/d')
    expect(dispatch).toHaveBeenCalledWith('readdir', '/ram/d/')
    expect(entries).toHaveLength(1)
  })

  it('finds a path through its parent listing, and answers null for a miss', async () => {
    const vfs = viewOn(listingOf(['/ram/a']))
    expect(await vfs.entryFor('/ram/a')).toMatchObject({ isDir: false })
    expect(await vfs.entryFor('/ram/nope')).toBeNull()
  })
})

describe('MontyVFS negative cache', () => {
  const listing = () => listingOf(['/ram/a'])

  it('remembers an absence, so a repeated probe costs no second listing', async () => {
    // Monty asks whether a path exists on nearly every guest
    // expression, so the second miss must not reach the mount.
    const dispatch = listing()
    const vfs = viewOn(dispatch)
    expect(await vfs.entryFor('/ram/nope')).toBeNull()
    expect(await vfs.entryFor('/ram/nope')).toBeNull()
    expect(dispatch.mock.calls.filter((c) => c[0] === 'readdir')).toHaveLength(1)
  })

  it('answers a remembered absence from read without dispatching', async () => {
    const dispatch = listing()
    const vfs = viewOn(dispatch)
    await vfs.entryFor('/ram/nope')
    await expect(vfs.read('/ram/nope')).rejects.toMatchObject({ name: 'FileNotFoundError' })
    expect(dispatch.mock.calls.filter((c) => c[0] === 'read')).toHaveLength(0)
  })

  it('forgets the absence once the path is written, so the guest sees its own write', async () => {
    const dispatch = listing()
    const vfs = viewOn(dispatch)
    expect(await vfs.entryFor('/ram/new.txt')).toBeNull()
    await vfs.write('/ram/new.txt', 'hi')
    await vfs.entryFor('/ram/new.txt')
    expect(dispatch.mock.calls.filter((c) => c[0] === 'readdir')).toHaveLength(2)
  })

  it('remembers a path it removed, and forgets a rename destination', async () => {
    const dispatch = listing()
    const vfs = viewOn(dispatch)
    await vfs.unlink('/ram/a')
    expect(await vfs.entryFor('/ram/a')).toBeNull()
    expect(dispatch.mock.calls.filter((c) => c[0] === 'readdir')).toHaveLength(0)
    await vfs.rename('/ram/b', '/ram/a')
    expect(await vfs.entryFor('/ram/a')).toMatchObject({ isDir: false })
  })

  it('forgets across commands, so another writer between runs is seen', async () => {
    // python builds a fresh MirageOSAccess per run; this view is
    // attached once, so the runtime resets it at the top of each
    // command. Without that a shell command's file stays invisible.
    let created = false
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir') return Promise.resolve(created ? ['/ram/late.txt'] : [])
      if (op === 'stat' && path === '/ram/late.txt') {
        return Promise.resolve(
          new FileStat({ name: path, size: 1, type: FileType.FILE, content: ContentType.TEXT }),
        )
      }
      return Promise.resolve(undefined)
    })
    const vfs = viewOn(dispatch)
    expect(await vfs.entryFor('/ram/late.txt')).toBeNull()
    created = true
    expect(await vfs.entryFor('/ram/late.txt')).toBeNull()
    vfs.reset()
    expect(await vfs.entryFor('/ram/late.txt')).toMatchObject({ isDir: false })
  })

  it('does not remember a transport failure as an absence', async () => {
    // "I could not reach the mount" is not "there is nothing here";
    // caching it would hide the file for the rest of the run.
    let down = true
    const dispatch = vi.fn<BridgeDispatchFn>((op) => {
      if (down) return Promise.reject(new Error('transport down'))
      if (op === 'read') return Promise.resolve(new TextEncoder().encode('back'))
      return Promise.resolve(undefined)
    })
    const vfs = viewOn(dispatch)
    await expect(vfs.read('/ram/x')).rejects.toThrow(/transport down/)
    down = false
    expect(await vfs.read('/ram/x')).toEqual(new TextEncoder().encode('back'))
  })
})

// The link mark rides the parent's listing, which the door already
// resolved, so a predicate the guest asks per path adds no dispatch of
// its own. Monty's own tree holds no links, so declining would answer
// False for one the shell made.
describe('MontyVFS.isLink', () => {
  it('reads the mark off the parent listing', async () => {
    const vfs = viewOn(listingOf(['/ram/link']), ['/ram'], ['link'])
    expect(await vfs.isLink('/ram/link')).toBe(true)
  })

  it('answers false for an entry with no mark', async () => {
    const vfs = viewOn(listingOf(['/ram/f']))
    expect(await vfs.isLink('/ram/f')).toBe(false)
  })

  it('answers false when the parent will not list', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.reject(new Error('no such dir')))
    expect(await viewOn(dispatch).isLink('/ram/gone/l')).toBe(false)
  })
})

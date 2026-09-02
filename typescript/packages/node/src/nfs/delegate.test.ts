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

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { FileStat, MountMode } from '@struktoai/mirage-core/types'
import { beforeEach, describe, expect, it } from 'vitest'

import { Workspace } from '../workspace.ts'
import { NFSConfig } from './config.ts'
import { RenameIntoSelfError, StaleHandleError } from './errors.ts'
import { MirageNFS } from './delegate.ts'

// The adapter is driven against a real workspace rather than a fake
// facade: every wire bug this port hit came from a fake that was not
// faithful (stat follows links, readdir answers in paths, a child mount
// stats as a directory), and the real Ops cannot drift from itself.
let ws: Workspace
let fs: MirageNFS
let root: number

async function stored(path: string): Promise<string> {
  return Buffer.from(await ws.fs.readFile(path, { raw: true })).toString()
}

async function missing(path: string): Promise<boolean> {
  try {
    await ws.fs.stat(path)
    return false
  } catch {
    return true
  }
}

beforeEach(async () => {
  ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
  await ws.fs.writeFile('/a.txt', Buffer.from('hello'))
  await ws.fs.mkdir('/sub')
  fs = new MirageNFS(ws.fs)
  root = fs.rootDir()
})

describe('ids and lookup', () => {
  it('allocates the root id rather than hardcoding one', () => {
    expect(fs.rootDir()).toBeGreaterThan(0)
    expect(fs.rootDir()).toBe(root)
  })

  it('returns a stable id for a child', async () => {
    const first = await fs.lookup(root, 'a.txt')
    expect(await fs.lookup(root, 'a.txt')).toBe(first)
  })

  it('refuses a lookup of a missing child', async () => {
    await expect(fs.lookup(root, 'nope.txt')).rejects.toThrow()
  })

  it('reads an unknown id as stale', async () => {
    await expect(fs.getattr(4242)).rejects.toThrow(StaleHandleError)
  })
})

describe('getattr', () => {
  it('reports size and type', async () => {
    const attrs = await fs.getattr(await fs.lookup(root, 'a.txt'))
    expect(attrs.size).toBe(5)
    expect(attrs.isDir).toBe(false)
  })

  it('reports a directory as one, sized zero', async () => {
    const attrs = await fs.getattr(await fs.lookup(root, 'sub'))
    expect(attrs.isDir).toBe(true)
    expect(attrs.size).toBe(0)
  })
})

describe('read and write', () => {
  it('returns the requested slice', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    expect((await fs.read(fileid, 1, 3)).toString()).toBe('ell')
  })

  it('buffers a write instead of storing it', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('HELLO'))
    expect(await stored('/a.txt')).toBe('hello')
  })

  it('shows a buffered write to read and getattr', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('HELLO'))
    expect((await fs.read(fileid, 0, 5)).toString()).toBe('HELLO')
    expect((await fs.getattr(fileid)).size).toBe(5)
  })

  it('extends the reported size for a write past the end', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 10, Buffer.from('xy'))
    expect((await fs.getattr(fileid)).size).toBe(12)
  })

  it('merges out-of-order writes on flush', async () => {
    // The macOS client sends overlapping and out-of-order WRITEs during
    // a plain cp, so arrival order — not offset order — decides.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 4, Buffer.from('dd'))
    await fs.write(fileid, 0, Buffer.from('aa'))
    await fs.write(fileid, 2, Buffer.from('bb'))
    await fs.flush(fileid)
    expect(await stored('/a.txt')).toBe('aabbdd')
  })

  it('stores every buffered file on flushAll', async () => {
    const one = await fs.create(root, 'one.txt')
    const two = await fs.create(root, 'two.txt')
    await fs.write(one, 0, Buffer.from('1'))
    await fs.write(two, 0, Buffer.from('2'))
    await fs.flushAll()
    expect(await stored('/one.txt')).toBe('1')
    expect(await stored('/two.txt')).toBe('2')
  })
})

describe('create, mkdir and remove', () => {
  it('creates a file and returns its id', async () => {
    const fileid = await fs.create(root, 'new.txt')
    expect(await stored('/new.txt')).toBe('')
    expect((await fs.getattr(fileid)).size).toBe(0)
  })

  it('makes a directory', async () => {
    const fileid = await fs.mkdir(root, 'd')
    expect((await fs.getattr(fileid)).isDir).toBe(true)
  })

  it('drops buffered writes when the file is removed', async () => {
    // Storing them would bring the file back.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('doomed'))
    await fs.remove(root, 'a.txt')
    expect(await missing('/a.txt')).toBe(true)
    await fs.flushAll()
    expect(await missing('/a.txt')).toBe(true)
  })

  it('routes a directory removal to rmdir', async () => {
    await fs.remove(root, 'sub')
    expect(await missing('/sub')).toBe(true)
  })

  it('invalidates the id it removed', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.remove(root, 'a.txt')
    await expect(fs.getattr(fileid)).rejects.toThrow(StaleHandleError)
  })
})

describe('rename', () => {
  it('moves the file and keeps its id', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.rename(root, 'a.txt', root, 'b.txt')
    expect(await stored('/b.txt')).toBe('hello')
    expect((await fs.getattr(fileid)).size).toBe(5)
  })

  it('flushes pending writes against the old path first', async () => {
    // They were acknowledged against it; flushing after the move would
    // merge them onto whatever now lives at the destination.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('moved'))
    await fs.rename(root, 'a.txt', root, 'b.txt')
    await fs.flushAll()
    expect(await stored('/b.txt')).toBe('moved')
  })

  it('leaves the backend untouched for a rename into its own subtree', async () => {
    const subid = await fs.lookup(root, 'sub')
    await expect(fs.rename(root, 'sub', subid, 'inner')).rejects.toThrow(RenameIntoSelfError)
    expect(await missing('/sub')).toBe(false)
  })
})

describe('setSize', () => {
  it('clips pending writes as well as the stored file', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('abcdef'))
    await fs.setSize(fileid, 3)
    await fs.flushAll()
    expect(await stored('/a.txt')).toBe('abc')
  })

  it('accepts and ignores an attribute change that names no size', async () => {
    // mode, owner and the timestamps have nowhere to persist, and
    // refusing them would fail ordinary tools.
    const fileid = await fs.lookup(root, 'a.txt')
    expect((await fs.setSize(fileid, 3)).size).toBe(3)
    expect((await fs.setSize(fileid, null)).size).toBe(3)
  })
})

describe('symlinks', () => {
  it('presents an absolute target relative to the link', async () => {
    // Returned raw, the client would resolve it against its own root
    // and escape the mount.
    const fileid = await fs.symlink(root, 'link', '/a.txt')
    expect(await fs.readlink(fileid)).toBe('a.txt')
  })

  it('keeps a relative target verbatim', async () => {
    const fileid = await fs.symlink(root, 'link', 'a.txt')
    expect(await fs.readlink(fileid)).toBe('a.txt')
  })

  it('reports the link itself, not its target', async () => {
    const fileid = await fs.symlink(root, 'link', '/a.txt')
    const attrs = await fs.getattr(fileid)
    expect(attrs.isSymlink).toBe(true)
    expect(attrs.isDir).toBe(false)
    expect(attrs.size).toBe('a.txt'.length)
  })

  it('unlinks a link to a directory without touching the target', async () => {
    await fs.symlink(root, 'dlink', '/sub')
    await fs.remove(root, 'dlink')
    expect(await missing('/sub')).toBe(false)
  })

  it('removes a broken link, and finds one on lookup', async () => {
    const made = await fs.symlink(root, 'ghost', '/nope.txt')
    expect(await fs.lookup(root, 'ghost')).toBe(made)
    await fs.remove(root, 'ghost')
    await expect(fs.lookup(root, 'ghost')).rejects.toThrow()
  })
})

describe('readdir', () => {
  it('derives bare names from the facade paths', async () => {
    // The facade answers in paths, a child mount with a trailing slash;
    // /dev is mounted into every workspace, so the boundary case is
    // real rather than staged.
    const names = (await fs.readdir(root)).map((entry) => entry.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('dev')
    expect(names.some((name) => name.includes('/'))).toBe(false)
  })

  it('lists every entry with an id', async () => {
    const entries = await fs.readdir(root)
    expect(entries.map((entry) => entry.name)).toContain('sub')
    expect(entries.every((entry) => entry.fileid > 0)).toBe(true)
  })

  it('skips macOS metadata names', async () => {
    await ws.fs.writeFile('/.DS_Store', Buffer.from('x'))
    await ws.fs.writeFile('/._shadow', Buffer.from('x'))
    const names = (await fs.readdir(root)).map((entry) => entry.name)
    expect(names).not.toContain('.DS_Store')
    expect(names).not.toContain('._shadow')
  })

  it('answers a metadata lookup with ENOENT and no backend op', async () => {
    // Finder and Spotlight probe these on every listing, so answering
    // here keeps the probe off the backend, as MountCore does. The
    // second half is the control: an ordinary lookup does reach it.
    const before = ws.fs.records.length
    await expect(fs.lookup(root, '.DS_Store')).rejects.toThrow()
    expect(ws.fs.records.length).toBe(before)
    await fs.lookup(root, 'a.txt')
    expect(ws.fs.records.length).toBeGreaterThan(before)
  })

  it('marks a link entry as one', async () => {
    await fs.symlink(root, 'link', '/a.txt')
    const entries = new Map((await fs.readdir(root)).map((entry) => [entry.name, entry]))
    expect(entries.get('link')?.attrs.isSymlink).toBe(true)
    expect(entries.get('a.txt')?.attrs.isSymlink).toBe(false)
  })

  it('paginates from the cookie the client returns', async () => {
    // The cookie is the last entry's fileid: the server crate derives
    // the wire cookie from it and hands it back as startAfter.
    const all = (await fs.readdir(root)).map((entry) => entry.name)
    const first = await fs.readdir(root, 0, 1)
    expect(first).toHaveLength(1)
    expect(first[0]?.cookie).toBe(first[0]?.fileid)
    const rest = await fs.readdir(root, first[0]?.cookie ?? 0)
    expect(rest.map((entry) => entry.name)).not.toContain(first[0]?.name)
    expect([...first, ...rest].map((entry) => entry.name)).toEqual(all)
  })

  it('resumes when id order does not match name order', async () => {
    // Ids are minted in access order, so a later entry can carry a
    // smaller fileid than an earlier one; resume keys on identity,
    // never on comparing cookie magnitudes.
    await fs.lookup(root, 'sub')
    await ws.fs.writeFile('/0first.txt', Buffer.from('x'))
    const all = (await fs.readdir(root)).map((entry) => entry.name)
    const first = await fs.readdir(root, 0, 2)
    const rest = await fs.readdir(root, first.at(-1)?.cookie ?? 0)
    expect([...first, ...rest].map((entry) => entry.name)).toEqual(all)
  })

  it('carries a real mtime on the wire shape', async () => {
    // vfs.rs reads mtimeEpoch and nothing else; an adapter that leaves
    // it unset dates every file 1970 on the client, which is what
    // shipped before this test existed.
    const attrs = await fs.getattr(await fs.lookup(root, 'a.txt'))
    expect(attrs.mtimeEpoch).toBeGreaterThan(1_000_000_000)
    // Seconds, and bounded above as well as below: nfstime3.seconds is
    // a u32, so an adapter handing it milliseconds or nanoseconds
    // saturates it and dates every file 2106-02-07 -- which clears a
    // bare floor. Python's twin shipped exactly that for months.
    expect(attrs.mtimeEpoch).toBeLessThan(2 ** 32)
  })

  it('dates an undated row from the mount, the way fuse does', async () => {
    // This used to report the epoch, on the argument that a fabricated
    // time is a lie. Sharing the core settles it the other way: the
    // fuse tier has always answered its mount time for a row the
    // backend cannot date, and two kernel mounts of one tree disagreeing
    // about a file's age is worse than either answer alone. What matters
    // is that neither says 1970 when the backend does know.
    const real = ws.fs.stat.bind(ws.fs)
    ws.fs.stat = async (path: string) => {
      const row = await real(path)
      return new FileStat({ name: row.name, type: row.type, size: row.size })
    }
    const attrs = await fs.getattr(await fs.lookup(root, 'a.txt'))
    expect(attrs.mtimeEpoch).toBeGreaterThan(1_000_000_000)
  })

  it('does not lose an acknowledged write when flushes overlap', async () => {
    // The losing interleaving is specific: the first flush must already
    // have taken its batch and be parked in the store when the second
    // reads the base, so both merge onto the same bytes and the later
    // store drops the earlier batch. Waiting for the store to be
    // entered is what makes that deterministic rather than a timing
    // guess -- an earlier version of this test let the second write land
    // before the first take, which collapses both batches into one
    // store and passes whether the bug is present or not.
    const fileid = await fs.lookup(root, 'a.txt')
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const gate = new Promise<void>((go) => {
      release = go
    })
    const firstStoreStarted = new Promise<void>((go) => {
      entered = go
    })
    const realWrite = ws.fs.writeFile.bind(ws.fs)
    let held = false
    ws.fs.writeFile = async (path: string, data: Uint8Array) => {
      if (!held) {
        held = true
        entered()
        await gate
      }
      return realWrite(path, data)
    }

    await fs.write(fileid, 0, Buffer.from('AAAAA'))
    const first = fs.flush(fileid)
    await firstStoreStarted
    await fs.write(fileid, 5, Buffer.from('BBBBB'))
    const second = fs.flush(fileid)
    release()
    await Promise.all([first, second])
    ws.fs.writeFile = realWrite

    expect(await stored('/a.txt')).toBe('AAAAABBBBB')
  })

  // --- the three data-loss paths the review found, both languages ---

  it('refuses an exclusive create without touching the existing file', async () => {
    // NFSv3 EXCLUSIVE is O_CREAT|O_EXCL on the wire, so it is every
    // lockfile idiom there is. Routed to the plain create, whose core
    // truncates, it emptied the file it was meant to refuse.
    await ws.fs.writeFile('/keep.txt', Buffer.from('important data\n'))

    await expect(fs.createExclusive(root, 'keep.txt')).rejects.toThrow(/exists/i)

    expect(await stored('/keep.txt')).toBe('important data\n')
  })

  it('still creates a fresh file exclusively', async () => {
    const fileid = await fs.createExclusive(root, 'new.txt')

    expect(fileid).toBeGreaterThan(0)
    expect(await stored('/new.txt')).toBe('')
  })

  it('keeps acknowledged writes when the store fails', async () => {
    // Every buffered write was answered FILE_SYNC, so the client will
    // never send them again. take() up front meant a store that threw
    // lost them for good.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('NEW'))
    const real = ws.fs.writeFile.bind(ws.fs)
    ws.fs.writeFile = () => Promise.reject(new Error('permission denied'))

    await expect(fs.flush(fileid)).rejects.toThrow(/denied/)

    ws.fs.writeFile = real
    await fs.flush(fileid)
    expect(await stored('/a.txt')).toBe('NEWlo')
  })

  it('keeps acknowledged writes when the removal fails', async () => {
    // A denied unlink used to leave the file in place with its
    // pre-write bytes while the acknowledged writes were already gone.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('NEW'))
    const real = ws.fs.unlink.bind(ws.fs)
    ws.fs.unlink = () => Promise.reject(new Error('permission denied'))

    await expect(fs.remove(root, 'a.txt')).rejects.toThrow(/denied/)

    ws.fs.unlink = real
    await fs.flush(fileid)
    expect(await stored('/a.txt')).toBe('NEWlo')
  })

  it('drops the buffer once the removal succeeds', async () => {
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('NEW'))

    await fs.remove(root, 'a.txt')

    expect(await missing('/a.txt')).toBe(true)
  })

  it('propagates an unexpected failure while reading the flush base', async () => {
    // A bare catch read every transient backend, auth or policy error
    // as "empty file", and the whole-object write that followed stored
    // the pending ranges alone -- destroying untouched content.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 4, Buffer.from('!'))
    ws.fs.readFile = () => Promise.reject(new Error('permission denied'))

    await expect(fs.flush(fileid)).rejects.toThrow(/denied/)
  })

  it('fetches the object once across sequential reads', async () => {
    // NFSv3 has no OPEN, so the prefetch cache's only fill site (open)
    // never fired for NFS and every 64 KiB READ refetched the whole
    // file: 16 full fetches to serve 1 MiB, one backend request per
    // 64 KiB on an API-backed mount.
    await ws.fs.writeFile('/big.bin', Buffer.alloc(1024 * 1024))
    const fresh = new MirageNFS(ws.fs)
    const fileid = await fresh.lookup(fresh.rootDir(), 'big.bin')
    let fetches = 0
    const real = ws.fs.readFile.bind(ws.fs)
    ws.fs.readFile = (path: string, opts?: unknown) => {
      fetches += 1
      return real(path, opts as never)
    }

    let served = 0
    for (let i = 0; i < 16; i += 1) {
      served += (await fresh.read(fileid, i * 65536, 65536)).byteLength
    }

    expect(served).toBe(1024 * 1024)
    expect(fetches).toBe(1)
  })

  it('resumes a listing whose cookie entry was removed', async () => {
    // The resume scan looked for the cookie's fileid and only stopped
    // skipping on an exact match, so removing that entry between pages
    // skipped the whole rest of the directory and the empty page read
    // as end-of-listing.
    await ws.fs.mkdir('/pages')
    for (const name of ['a', 'b', 'c', 'e', 'f']) {
      await ws.fs.writeFile(`/pages/${name}`, Buffer.from('x'))
    }
    const pages = await fs.lookup(root, 'pages')
    const page1 = await fs.readdir(pages, 0, 2)
    expect(page1.map((e) => e.name)).toEqual(['a', 'b'])

    await fs.remove(pages, 'b')

    const page2 = await fs.readdir(pages, page1.at(-1)?.cookie ?? 0)
    expect(page2.map((e) => e.name)).toEqual(['c', 'e', 'f'])
  })

  it('rejects a readdir cookie it never minted', async () => {
    // Silently returning nothing reads as end-of-directory; a client
    // can recover from an error by restarting the listing.
    await expect(fs.readdir(root, 999_999)).rejects.toThrow(StaleHandleError)
  })

  it('refuses a name that is not one component', async () => {
    // filename3 is a single component and nfsserve does not filter it,
    // so the delegate is the only guard. Traversal did not escape only
    // because nothing below normalizes '..', which is luck, not a check.
    await ws.fs.mkdir('/sub/deep')
    await ws.fs.writeFile('/sub/deep/b.txt', Buffer.from('x'))
    const sub = await fs.lookup(root, 'sub')

    await expect(fs.lookup(sub, 'deep/b.txt')).rejects.toThrow(/single path component/)
  })

  it('resolves . and .. itself', async () => {
    // The kernel resolves these above the filesystem for FUSE, which is
    // why MountCore never had to; over NFSv3 they are the server's job,
    // and ENOENT was a cold-cache hole.
    const sub = await fs.lookup(root, 'sub')

    expect(await fs.lookup(sub, '.')).toBe(sub)
    expect(await fs.lookup(sub, '..')).toBe(root)
    expect(await fs.lookup(root, '..')).toBe(root)
  })

  it('refuses a slashed name in every mutating op', async () => {
    await expect(fs.create(root, 'a/b')).rejects.toThrow(/single path component/)
    await expect(fs.mkdir(root, 'a/b')).rejects.toThrow(/single path component/)
    await expect(fs.remove(root, 'a/b')).rejects.toThrow(/single path component/)
    await expect(fs.symlink(root, 'a/b', 't')).rejects.toThrow(/single path component/)
    await expect(fs.rename(root, 'a/b', root, 'c')).rejects.toThrow(/single path component/)
  })

  it('bounds the total buffer across files', async () => {
    // maxBufferedBytes bounds one handle, so N files written at once
    // cost N times it and nothing bounded the sum: a `cp -r` of many
    // large files grew the process without limit.
    const bounded = new MirageNFS(
      ws.fs,
      new NFSConfig({ maxBufferedBytes: 1024, maxTotalBufferedBytes: 2048 }),
    )
    const boundedRoot = bounded.rootDir()
    for (let i = 0; i < 8; i += 1) {
      await ws.fs.writeFile(`/f${String(i)}`, Buffer.alloc(0))
      const fileid = await bounded.lookup(boundedRoot, `f${String(i)}`)
      await bounded.write(fileid, 0, Buffer.alloc(512, 1))
    }

    expect(bounded.bufferedBytes()).toBeLessThanOrEqual(2048)
  })

  it('keeps acknowledged writes when the truncate fails', async () => {
    // setattr clipped the buffer before the truncate landed, so a
    // denied or transient failure discarded acknowledged bytes while
    // the file kept its old length. Same shape as remove's drop.
    const fileid = await fs.lookup(root, 'a.txt')
    await fs.write(fileid, 0, Buffer.from('NEWDATA'))
    const real = ws.fs.truncate.bind(ws.fs)
    ws.fs.truncate = () => Promise.reject(new Error('permission denied'))

    await expect(fs.setattr(fileid, { size: 2 })).rejects.toThrow(/denied/)

    ws.fs.truncate = real
    await fs.flush(fileid)
    expect(await stored('/a.txt')).toBe('NEWDATA')
  })
})

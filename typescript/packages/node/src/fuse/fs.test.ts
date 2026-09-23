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

import { constants as fsConstants } from 'node:fs'
import type { Action, OpsResultContext, Policy } from '@struktoai/mirage-core/policy/index'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { ContentType, FileStat, FileType, MountMode } from '@struktoai/mirage-core/types'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { EEXIST } from './errors.ts'
import { MirageFS, XATTR_CREATE, XATTR_REPLACE, type FuseAttr } from './fs.ts'

const ENOENT = -2
const ENOTEMPTY = -66
const EACCES = -13
const EROFS = -30

// Invoke a MirageFS op through its ops() surface — covers the same dispatch
// path that @zkochan/fuse-native uses in production. Returns the callback args
// as a tuple — callers destructure: `const [code, value] = await callOp(...)`.
async function callOp<T extends unknown[] = [number, unknown?]>(
  mfs: MirageFS,
  name: string,
  ...args: unknown[]
): Promise<T> {
  const fn = (mfs.ops() as Record<string, (...a: unknown[]) => void>)[name]
  if (fn === undefined) throw new Error(`op ${name} not registered`)
  return new Promise<T>((resolve) => {
    fn(...args, (...rest: unknown[]) => {
      resolve(rest as T)
    })
  })
}

async function mkWs(): Promise<Workspace> {
  const ws = new Workspace(
    { '/data/': new RAMVFS(), '/extra/': new RAMVFS() },
    { mode: MountMode.WRITE },
  )
  await ws.shell("echo 'hello world' | tee /data/greeting.txt")
  await ws.shell("mkdir -p /data/sub && echo 'nested' > /data/sub/inner.txt")
  return ws
}

describe('MirageFS — getattr', () => {
  it('reports root as a directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o040000)
  })

  it('reports a mount-prefix path as a virtual directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o040000)
  })

  it('reports a file under a mount with correct size', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/greeting.txt')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe('hello world\n'.length)
  })

  it('returns ENOENT for missing files', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'getattr', '/data/missing.txt')
    expect(code).toBe(ENOENT)
  })

  it('rejects macOS metadata probes early with ENOENT', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'getattr', '/data/.DS_Store')
    expect(code).toBe(ENOENT)
  })
})

describe('MirageFS — readdir', () => {
  it('always prepends "." and ".." at root', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, names] = await callOp<[number, string[]]>(mfs, 'readdir', '/')
    expect(code).toBe(0)
    expect(names.slice(0, 2)).toEqual(['.', '..'])
    expect(names).toContain('data')
    expect(names).toContain('extra')
  })

  it('lists contents of a mount directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, names] = await callOp<[number, string[]]>(mfs, 'readdir', '/data')
    expect(code).toBe(0)
    expect(names.slice(0, 2)).toEqual(['.', '..'])
    expect(names).toContain('greeting.txt')
    expect(names).toContain('sub')
  })
})

describe('MirageFS — chmod/chown/utimens/access validate path existence', () => {
  it.each([
    ['chmod', [0o644]],
    ['chown', [0, 0]],
    ['utimens', [new Date(), new Date()]],
    ['access', [0]],
  ] as const)('%s returns ENOENT for missing path', async (op, extra) => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, op, '/data/missing.txt', ...extra)
    expect(code).toBe(ENOENT)
  })

  it.each([
    ['chmod', [0o644]],
    ['chown', [0, 0]],
    ['utimens', [new Date(), new Date()]],
    ['access', [0]],
  ] as const)('%s returns 0 for existing path', async (op, extra) => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, op, '/data/greeting.txt', ...extra)
    expect(code).toBe(0)
  })
})

describe('MirageFS — rmdir maps non-empty to ENOTEMPTY', () => {
  it('refuses to rmdir a directory with children', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'rmdir', '/data/sub')
    expect(code).toBe(ENOTEMPTY)
  })
})

describe('MirageFS — read-only mount write consistency', () => {
  it('rejects create and buffered flush through the same mount-mode gate', async () => {
    const vfs = new RAMVFS()
    const seedWs = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await seedWs.vfs.writeFile('/data/existing.txt', 'seed')

    const readonlyWs = new Workspace({ '/data/': vfs }, { mode: MountMode.READ })
    const mfs = new MirageFS(readonlyWs.vfs)

    const [createCode] = await callOp<[number]>(mfs, 'create', '/data/new.txt', 0o100644)
    expect(createCode).toBe(EROFS)

    // An O_TRUNC open is itself a write, so it is refused at open time
    // the way open(2) refuses one on a read-only filesystem.
    const [truncOpenCode] = await callOp<[number]>(
      mfs,
      'open',
      '/data/existing.txt',
      fsConstants.O_WRONLY | fsConstants.O_TRUNC,
    )
    expect(truncOpenCode).toBe(EROFS)

    const [openCode, fh] = await callOp<[number, number]>(
      mfs,
      'open',
      '/data/existing.txt',
      fsConstants.O_WRONLY,
    )
    expect(openCode).toBe(0)

    const bytes = Buffer.from('changed')
    const [writeBytes] = await callOp<[number]>(
      mfs,
      'write',
      '/data/existing.txt',
      fh,
      bytes,
      bytes.byteLength,
      0,
    )
    expect(writeBytes).toBe(bytes.byteLength)

    // The kernel reports byte acceptance before flush. Flush is the point where
    // Mirage commits buffered FUSE writes, so it must enforce the same READ-mode
    // restriction as create.
    const [flushCode] = await callOp<[number]>(mfs, 'flush', '/data/existing.txt', fh)
    expect(flushCode).toBe(EROFS)
    expect(new TextDecoder().decode(await seedWs.vfs.readFile('/data/existing.txt'))).toBe('seed')
  })
})

describe('MirageFS — drainOps()', () => {
  it('returns and clears the workspace op records buffer', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    // Trigger a few ops
    await callOp(mfs, 'getattr', '/data/greeting.txt')
    await callOp(mfs, 'readdir', '/data')
    const drained = mfs.drainOps()
    expect(Array.isArray(drained)).toBe(true)
    expect(mfs.drainOps()).toHaveLength(0)
  })

  it('accounts for writes too, not only reads', async () => {
    // The mount runs every op through the op facade, which is what
    // records them; a write issued straight at the dispatcher would
    // mutate the mount and leave drainOps reporting nothing.
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const bytes = Buffer.from('written through the mount\n')
    const [, fh] = await callOp<[number, number]>(mfs, 'create', '/data/fresh.txt', 0o100644)
    await callOp(mfs, 'write', '/data/fresh.txt', fh, bytes, bytes.byteLength, 0)
    await callOp(mfs, 'flush', '/data/fresh.txt', fh)
    const ops = mfs.drainOps().map((r) => r.op)
    expect(ops).toContain('create')
    expect(ops).toContain('write')
  })
})

describe('MirageFS — ops() registers access', () => {
  it('includes access in the returned ops map', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    expect(typeof mfs.ops().access).toBe('function')
  })
})

describe('MirageFS — size=null mounts (API-backed)', () => {
  // Simulates Trello/Linear/Slack: stat() returns size=null because the bytes
  // aren't known until the API is called. getattr reports 0 pre-open (never a
  // fake size); the mount's direct_io makes the kernel read to EOF anyway,
  // and attrTimeout '0' routes the post-open fstat to fgetattr, which serves
  // the real hydrated size. We can't prefetch on getattr — that would make
  // `ls` issue an API call per directory entry.

  function mkSizeNullWs(): Workspace {
    return new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  }

  it('getattr reports size 0 (no API fetch) when stat returns size=null', async () => {
    const ws = mkSizeNullWs()
    await ws.vfs.writeFile('/data/api.json', new TextEncoder().encode('content'))
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const readSpy = vi.spyOn(ws.vfs, 'readFile')
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/api.json')
    expect(code).toBe(0)
    expect(attr.size).toBe(0)
    // The point of reporting 0: getattr stays cheap.
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('open prefetches and read returns the actual bytes (kernel sequence)', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('payload from API')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    await callOp(mfs, 'getattr', '/data/api.json')
    const [openCode, fh] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    expect(openCode).toBe(0)
    const buf = Buffer.alloc(bytes.byteLength * 2)
    const [n] = await callOp<[number]>(mfs, 'read', '/data/api.json', fh, buf, buf.byteLength, 0)
    expect(n).toBe(bytes.byteLength)
    expect(buf.subarray(0, n).toString('utf-8')).toBe('payload from API')
  })

  it('read returns 0 past the actual data length (direct_io read past EOF)', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('short')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const buf = Buffer.alloc(64)
    const [eof] = await callOp<[number]>(
      mfs,
      'read',
      '/data/api.json',
      fh,
      buf,
      buf.byteLength,
      999,
    )
    expect(eof).toBe(0)
  })

  it('once a file has been opened, subsequent getattrs return the real size', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('cached now')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/api.json')
    expect(attr.size).toBe(bytes.byteLength)
  })

  it('fgetattr serves the real size from the open-hydrated handle', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('hydrated bytes')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'fgetattr', '/data/api.json', fh)
    expect(code).toBe(0)
    expect(attr.size).toBe(bytes.byteLength)
  })

  it('an O_TRUNC open elsewhere cuts the bytes a hydrated handle serves', async () => {
    // A reader hydrated the file at open; truncation through another
    // handle must not leave it serving the pre-truncation body.
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('hydrated bytes')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    const [, reader] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [, writer] = await callOp<[number, number]>(
      mfs,
      'open',
      '/data/api.json',
      fsConstants.O_WRONLY | fsConstants.O_TRUNC,
    )
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'fgetattr', '/data/api.json', reader)
    expect(code).toBe(0)
    expect(attr.size).toBe(0)
    const [readCode] = await callOp<[number]>(
      mfs,
      'read',
      '/data/api.json',
      reader,
      Buffer.alloc(100),
      100,
      0,
    )
    expect(readCode).toBe(0)
    await callOp(mfs, 'release', '/data/api.json', writer)
    await callOp(mfs, 'release', '/data/api.json', reader)
  })

  it('a flush refreshes the hydrated bytes of the handle that wrote', async () => {
    // A read-after-write through the same descriptor sees the write.
    const ws = mkSizeNullWs()
    await ws.vfs.writeFile('/data/api.json', new TextEncoder().encode('hydrated bytes'))
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', fsConstants.O_RDWR)
    const j = Buffer.from('J')
    await callOp(mfs, 'write', '/data/api.json', fh, j, j.byteLength, 0)
    await callOp(mfs, 'flush', '/data/api.json', fh)
    const out = Buffer.alloc(100)
    const [n] = await callOp<[number]>(mfs, 'read', '/data/api.json', fh, out, 100, 0)
    expect(out.subarray(0, n).toString()).toBe('Jydrated bytes')
    await callOp(mfs, 'release', '/data/api.json', fh)
  })

  it('a failed refresh after a truncate does not fail the truncate', async () => {
    // The truncation has landed by the time the hydrated reader is
    // refreshed; a backend hiccup there must not turn a committed
    // truncate into a failure. The reader just fetches again next time.
    const ws = mkSizeNullWs()
    await ws.vfs.writeFile('/data/api.json', new TextEncoder().encode('hydrated bytes'))
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const original = ws.vfs.readFile.bind(ws.vfs)
    let fail = false
    vi.spyOn(ws.vfs, 'readFile').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (fail) throw new Error('backend hiccup')
        return original(...args)
      },
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const mfs = new MirageFS(ws.vfs)
    const [, reader] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    fail = true
    const [code] = await callOp<[number]>(mfs, 'truncate', '/data/api.json', 0)
    expect(code).toBe(0)
    fail = false
    const out = Buffer.alloc(100)
    const [n] = await callOp<[number]>(mfs, 'read', '/data/api.json', reader, out, 100, 0)
    expect(n).toBe(0)
    await callOp(mfs, 'release', '/data/api.json', reader)
  })

  it('a nonzero truncate rehydrates a reader with the settled writes', async () => {
    // A truncate lands after another handle's buffered write, and the
    // hydrated reader must see both: the settled write and the cut.
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('hydrated bytes')
    await ws.vfs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const mfs = new MirageFS(ws.vfs)
    const [, reader] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [, writer] = await callOp<[number, number]>(
      mfs,
      'open',
      '/data/api.json',
      fsConstants.O_WRONLY,
    )
    const j = Buffer.from('J')
    await callOp(mfs, 'write', '/data/api.json', writer, j, j.byteLength, 0)
    const [truncCode] = await callOp<[number]>(mfs, 'truncate', '/data/api.json', 5)
    expect(truncCode).toBe(0)
    const [, attr] = await callOp<[number, FuseAttr]>(mfs, 'fgetattr', '/data/api.json', reader)
    expect(attr.size).toBe(5)
    const out = Buffer.alloc(100)
    const [n] = await callOp<[number]>(mfs, 'read', '/data/api.json', reader, out, 100, 0)
    expect(out.subarray(0, n).toString()).toBe('Jydra')
    await callOp(mfs, 'release', '/data/api.json', writer)
    await callOp(mfs, 'release', '/data/api.json', reader)
  })
})

describe('MirageFS — release flushes pending writes', () => {
  it('pending write_buf is persisted by release when no flush arrived', async () => {
    // The kext always issues FLUSH on close, but the macFUSE FSKit shim
    // issues WRITE then RELEASE with no FLUSH in between; dropping the
    // buffer at release silently lost data written through an fskit mount.
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/greeting.txt', 0)
    const data = Buffer.from('clobber')
    await callOp(mfs, 'write', '/data/greeting.txt', fh, data, data.byteLength, 0)
    const [releaseCode] = await callOp<[number]>(mfs, 'release', '/data/greeting.txt', fh)
    expect(releaseCode).toBe(0)
    const current = await ws.vfs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(current)).toBe('clobberorld\n')
  })

  it('flush persists the buffered writes', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/greeting.txt', 0)
    const data = Buffer.from('CLOBBER world\n')
    await callOp(mfs, 'write', '/data/greeting.txt', fh, data, data.byteLength, 0)
    await callOp(mfs, 'flush', '/data/greeting.txt', fh)
    await callOp(mfs, 'release', '/data/greeting.txt', fh)
    const after = await ws.vfs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(after)).toBe('CLOBBER world\n')
  })

  it('open forwards O_TRUNC so a shorter overwrite truncates', async () => {
    // The adapter used to drop the open flags, so a fuse3 O_TRUNC open
    // (no separate truncate op arrives) merged the new bytes over the
    // old body (#1032).
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [, fh] = await callOp<[number, number]>(
      mfs,
      'open',
      '/data/greeting.txt',
      fsConstants.O_WRONLY | fsConstants.O_TRUNC,
    )
    const data = Buffer.from('BB\n')
    await callOp(mfs, 'write', '/data/greeting.txt', fh, data, data.byteLength, 0)
    await callOp(mfs, 'flush', '/data/greeting.txt', fh)
    await callOp(mfs, 'release', '/data/greeting.txt', fh)
    const after = await ws.vfs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(after)).toBe('BB\n')
  })
})

describe('MirageFS — xattr', () => {
  it('round-trips set and get', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    await callOp(mfs, 'setxattr', '/data/greeting.txt', 'user.test', Buffer.from('value'), 0, 0)
    const [code, value] = await callOp<[number, Buffer?]>(
      mfs,
      'getxattr',
      '/data/greeting.txt',
      'user.test',
      0,
    )
    expect(code).toBe(0)
    expect(value?.toString()).toBe('value')
  })

  it('returns no value for a missing attribute', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code, value] = await callOp<[number, Buffer?]>(
      mfs,
      'getxattr',
      '/data/greeting.txt',
      'user.absent',
      0,
    )
    expect(code).toBe(0)
    expect(value).toBeUndefined()
  })

  it('lists and removes attributes', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    await callOp(mfs, 'setxattr', '/data/greeting.txt', 'user.one', Buffer.from('1'), 0, 0)
    await callOp(mfs, 'setxattr', '/data/greeting.txt', 'user.two', Buffer.from('2'), 0, 0)
    const [, list] = await callOp<[number, string[]]>(mfs, 'listxattr', '/data/greeting.txt')
    expect([...list].sort()).toEqual(['user.one', 'user.two'])
    await callOp(mfs, 'removexattr', '/data/greeting.txt', 'user.one')
    const [, after] = await callOp<[number, string[]]>(mfs, 'listxattr', '/data/greeting.txt')
    expect(after).toEqual(['user.two'])
  })

  it('accepts the container probe attribute', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [setCode] = await callOp<[number]>(
      mfs,
      'setxattr',
      '/data/greeting.txt',
      'user.containers._probe',
      Buffer.from('x'),
      0,
      0,
    )
    expect(setCode).toBe(0)
  })

  it('follows a rename and clears on unlink', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    await callOp(mfs, 'setxattr', '/data/greeting.txt', 'user.keep', Buffer.from('v'), 0, 0)
    await callOp(mfs, 'rename', '/data/greeting.txt', '/data/renamed.txt')
    const [, moved] = await callOp<[number, Buffer?]>(
      mfs,
      'getxattr',
      '/data/renamed.txt',
      'user.keep',
      0,
    )
    expect(moved?.toString()).toBe('v')
    await callOp(mfs, 'unlink', '/data/renamed.txt')
    // A new file at the same path must not inherit the deleted file's xattrs.
    await ws.shell("echo 'new' > /data/renamed.txt")
    const [, list] = await callOp<[number, string[]]>(mfs, 'listxattr', '/data/renamed.txt')
    expect(list).toEqual([])
  })

  it('is the same attribute every surface reads', async () => {
    // The kernel's attribute is the door's, not an advisory copy held for
    // the mount's lifetime: the shell and a guest read what the mountpoint
    // wrote, and the mountpoint reads what they wrote.
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    await callOp(mfs, 'setxattr', '/data/greeting.txt', 'user.kernel', Buffer.from('k'), 0, 0)
    const fromDoor = await ws.vfs.getxattr('/data/greeting.txt', 'user.kernel')
    expect(new TextDecoder().decode(fromDoor)).toBe('k')
    await ws.vfs.setxattr('/data/greeting.txt', 'user.door', new TextEncoder().encode('d'))
    const [, value] = await callOp<[number, Buffer?]>(
      mfs,
      'getxattr',
      '/data/greeting.txt',
      'user.door',
      0,
    )
    expect(value?.toString()).toBe('d')
  })

  it('hands the create and replace flags to the door', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const set = (name: string, flags: number) =>
      callOp<[number]>(mfs, 'setxattr', '/data/greeting.txt', name, Buffer.from('1'), 0, flags)
    expect((await set('user.once', XATTR_CREATE))[0]).toBe(0)
    expect((await set('user.once', XATTR_CREATE))[0]).toBe(-EEXIST)
    expect((await set('user.none', XATTR_REPLACE))[0]).toBeLessThan(0)
  })
})

describe('MirageFS — namespace links', () => {
  it('getattr reports a link with S_IFLNK and target length', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/greeting.txt /data/lnk')
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/lnk')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o120000)
    expect(attr.size).toBe('greeting.txt'.length)
  })

  it('readlink rewrites an absolute target relative to the link dir', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/sub/inner.txt /data/lnk')
    const mfs = new MirageFS(ws.vfs)
    const [code, target] = await callOp<[number, string]>(mfs, 'readlink', '/data/lnk')
    expect(code).toBe(0)
    expect(target).toBe('sub/inner.txt')
  })

  it('readlink on a non-link returns EINVAL', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'readlink', '/data/greeting.txt')
    expect(code).toBe(-22)
  })

  it('readdir lists link entries', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/greeting.txt /data/lnk')
    const mfs = new MirageFS(ws.vfs)
    const [code, entries] = await callOp<[number, string[]]>(mfs, 'readdir', '/data')
    expect(code).toBe(0)
    expect(entries).toContain('lnk')
  })

  it('read follows the link to the target content', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/greeting.txt /data/lnk')
    const mfs = new MirageFS(ws.vfs)
    const buf = Buffer.alloc(256)
    const [n] = await callOp<[number]>(mfs, 'read', '/data/lnk', 0, buf, 256, 0)
    expect(n).toBe('hello world\n'.length)
    expect(buf.subarray(0, n).toString()).toBe('hello world\n')
  })

  it('symlink creates a namespace link readable through FUSE', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'symlink', '/data/greeting.txt', '/data/lnk')
    expect(code).toBe(0)
    const [rlCode, target] = await callOp<[number, string]>(mfs, 'readlink', '/data/lnk')
    expect(rlCode).toBe(0)
    expect(target).toBe('greeting.txt')
  })

  it('unlink removes the link entry but keeps the target', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/greeting.txt /data/lnk')
    const mfs = new MirageFS(ws.vfs)
    const [code] = await callOp<[number]>(mfs, 'unlink', '/data/lnk')
    expect(code).toBe(0)
    const [lnkCode] = await callOp<[number]>(mfs, 'getattr', '/data/lnk')
    expect(lnkCode).toBe(ENOENT)
    const [fileCode] = await callOp<[number]>(mfs, 'getattr', '/data/greeting.txt')
    expect(fileCode).toBe(0)
  })

  it('scoped root displays link targets in mount-relative form', async () => {
    const ws = await mkWs()
    await ws.shell('ln -s /data/sub/inner.txt /data/sub/lnk')
    const mfs = new MirageFS(ws.vfs, { rootPrefix: '/data/sub' })
    const [code, target] = await callOp<[number, string]>(mfs, 'readlink', '/lnk')
    expect(code).toBe(0)
    expect(target).toBe('inner.txt')
  })
})

describe('MirageFS — stat attr overlay', () => {
  it('getattr honors chmod overlay bits', async () => {
    const ws = await mkWs()
    await ws.shell('chmod 640 /data/greeting.txt')
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/greeting.txt')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.mode & 0o7777).toBe(0o640)
  })

  it('getattr honors touched mtime', async () => {
    const ws = await mkWs()
    await ws.shell('touch -t 202603041200 /data/greeting.txt')
    const mfs = new MirageFS(ws.vfs)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/greeting.txt')
    expect(code).toBe(0)
    expect(attr.mtime.getTime()).toBe(Date.UTC(2026, 2, 4, 12, 0, 0))
  })
})

describe('MirageFS — session binding', () => {
  it("a bound tree enforces the session's view", async () => {
    const ws = await mkWs()
    await ws.shell("echo 'hidden' > /extra/secret.txt")
    const session = ws.createSession('narrow', { profile: { paths: { hide: ['/extra'] } } })

    const bound = new MirageFS(ws.vfs, { session })
    const [okCode, attr] = await callOp<[number, FuseAttr]>(bound, 'getattr', '/data/greeting.txt')
    expect(okCode).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o100000)
    const [deniedCode] = await callOp<[number]>(bound, 'getattr', '/extra/secret.txt')
    expect(deniedCode).toBeLessThan(0)

    const unbound = new MirageFS(ws.vfs)
    const [plainCode] = await callOp<[number, FuseAttr]>(unbound, 'getattr', '/extra/secret.txt')
    expect(plainCode).toBe(0)
  })

  it('a read-narrowed session reads through the bound tree but cannot create', async () => {
    const ws = await mkWs()
    const session = ws.createSession('ro', { mounts: { '/data': 'read' } })
    const bound = new MirageFS(ws.vfs, { session })

    const [openCode, fd] = await callOp<[number, number]>(bound, 'open', '/data/greeting.txt', 0)
    expect(openCode).toBe(0)
    const buf = Buffer.alloc(64)
    const readLen = await new Promise<number>((resolve) => {
      const fn = (bound.ops() as Record<string, (...a: unknown[]) => void>).read
      if (fn === undefined) throw new Error('read op missing')
      fn('/data/greeting.txt', fd, buf, 64, 0, resolve)
    })
    expect(buf.subarray(0, readLen).toString()).toContain('hello world')

    const [createCode] = await callOp<[number]>(bound, 'create', '/data/new.txt', 0o644)
    expect(createCode).toBeLessThan(0)
  })
})

describe('MirageFS — a policy deny on read surfaces EACCES', () => {
  it('postOps deny reports EACCES instead of an empty read', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/')
    vfs.store.files.set('/secret.txt', new TextEncoder().encode('TOPSECRET plans\n'))
    vfs.store.files.set('/clean.txt', new TextEncoder().encode('hello\n'))
    const redact: Policy = {
      postOps(ctx: OpsResultContext): Action | null {
        const data = ctx.result instanceof Uint8Array ? new TextDecoder().decode(ctx.result) : null
        if (ctx.op === 'read' && data?.includes('TOPSECRET') === true) {
          return { kind: 'deny', reason: 'redacted' }
        }
        return null
      },
    }
    const ws = new Workspace({ '/data/': vfs }, { mode: MountMode.READ, policies: [redact] })
    const mfs = new MirageFS(ws.vfs)

    const [openCode, fd] = await callOp<[number, number]>(mfs, 'open', '/data/secret.txt', 0)
    expect(openCode).toBe(0)
    const buf = Buffer.alloc(64)
    const [code] = await callOp<[number]>(mfs, 'read', '/data/secret.txt', fd, buf, 64, 0)
    expect(code).toBe(EACCES)

    const [cleanOpen, cleanFd] = await callOp<[number, number]>(mfs, 'open', '/data/clean.txt', 0)
    expect(cleanOpen).toBe(0)
    const [cleanLen] = await callOp<[number]>(mfs, 'read', '/data/clean.txt', cleanFd, buf, 64, 0)
    expect(buf.subarray(0, cleanLen).toString()).toBe('hello\n')
  })
})

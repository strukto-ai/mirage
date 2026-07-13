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

import { FileStat, FileType, MountMode, RAMResource } from '@struktoai/mirage-core'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { MirageFS, type FuseAttr } from './fs.ts'

const ENOENT = -2
const ENOTEMPTY = -66
const EACCES = -13

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
    { '/data/': new RAMResource(), '/extra/': new RAMResource() },
    { mode: MountMode.WRITE },
  )
  await ws.execute("echo 'hello world' | tee /data/greeting.txt")
  await ws.execute("mkdir -p /data/sub && echo 'nested' > /data/sub/inner.txt")
  return ws
}

describe('MirageFS — getattr', () => {
  it('reports root as a directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o040000)
  })

  it('reports a mount-prefix path as a virtual directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o040000)
  })

  it('reports a file under a mount with correct size', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/greeting.txt')
    expect(code).toBe(0)
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe('hello world\n'.length)
  })

  it('returns ENOENT for missing files', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code] = await callOp<[number]>(mfs, 'getattr', '/data/missing.txt')
    expect(code).toBe(ENOENT)
  })

  it('rejects macOS metadata probes early with ENOENT', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code] = await callOp<[number]>(mfs, 'getattr', '/data/.DS_Store')
    expect(code).toBe(ENOENT)
  })

  it('serves /.mirage/whoami as a file', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/.mirage/whoami')
    expect(code).toBe(0)
    expect(attr.size).toBeGreaterThan(0)
  })
})

describe('MirageFS — readdir', () => {
  it('always prepends "." and ".." at root', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, names] = await callOp<[number, string[]]>(mfs, 'readdir', '/')
    expect(code).toBe(0)
    expect(names.slice(0, 2)).toEqual(['.', '..'])
    expect(names).toContain('data')
    expect(names).toContain('extra')
    expect(names).toContain('.mirage')
  })

  it('lists /.mirage as a single-entry virtual dir with "." and ".."', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, names] = await callOp<[number, string[]]>(mfs, 'readdir', '/.mirage')
    expect(code).toBe(0)
    expect(names).toEqual(['.', '..', 'whoami'])
  })

  it('lists contents of a mount directory', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code, names] = await callOp<[number, string[]]>(mfs, 'readdir', '/data')
    expect(code).toBe(0)
    expect(names.slice(0, 2)).toEqual(['.', '..'])
    expect(names).toContain('greeting.txt')
    expect(names).toContain('sub')
  })
})

describe('MirageFS — whoami pseudo-file', () => {
  it('emits agent/cwd/mounts via read', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws, { agentId: 'test-agent-42' })
    const [code, fh] = await callOp<[number, number]>(mfs, 'open', '/.mirage/whoami', 0)
    expect(code).toBe(0)
    const buf = Buffer.alloc(256)
    const [bytesRead] = await callOp<[number]>(mfs, 'read', '/.mirage/whoami', fh, buf, 256, 0)
    const text = buf.subarray(0, bytesRead).toString('utf-8')
    expect(text).toContain('agent: test-agent-42')
    expect(text).toContain('cwd: /')
    expect(text).toContain('/data/')
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
    const mfs = new MirageFS(ws)
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
    const mfs = new MirageFS(ws)
    const [code] = await callOp<[number]>(mfs, op, '/data/greeting.txt', ...extra)
    expect(code).toBe(0)
  })
})

describe('MirageFS — rmdir maps non-empty to ENOTEMPTY', () => {
  it('refuses to rmdir a directory with children', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [code] = await callOp<[number]>(mfs, 'rmdir', '/data/sub')
    expect(code).toBe(ENOTEMPTY)
  })
})

describe('MirageFS — read-only mount write consistency', () => {
  it('rejects create and buffered flush through the same mount-mode gate', async () => {
    const resource = new RAMResource()
    const seedWs = new Workspace({ '/data/': resource }, { mode: MountMode.WRITE })
    await seedWs.fs.writeFile('/data/existing.txt', 'seed')

    const readonlyWs = new Workspace({ '/data/': resource }, { mode: MountMode.READ })
    const mfs = new MirageFS(readonlyWs)

    const [createCode] = await callOp<[number]>(mfs, 'create', '/data/new.txt', 0o100644)
    expect(createCode).toBe(EACCES)

    const [openCode, fh] = await callOp<[number, number]>(mfs, 'open', '/data/existing.txt', 0x8401)
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
    expect(flushCode).toBe(EACCES)
    expect(new TextDecoder().decode(await seedWs.fs.readFile('/data/existing.txt'))).toBe('seed')
  })
})

describe('MirageFS — drainOps()', () => {
  it('returns and clears the workspace op records buffer', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    // Trigger a few ops
    await callOp(mfs, 'getattr', '/data/greeting.txt')
    await callOp(mfs, 'readdir', '/data')
    const drained = mfs.drainOps()
    expect(Array.isArray(drained)).toBe(true)
    expect(mfs.drainOps()).toHaveLength(0)
  })
})

describe('MirageFS — ops() registers access', () => {
  it('includes access in the returned ops map', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    expect(typeof mfs.ops().access).toBe('function')
  })
})

describe('MirageFS — size=null resources (API-backed)', () => {
  // Simulates Trello/Linear/Slack: stat() returns size=null because the bytes
  // aren't known until the API is called. getattr reports 0 pre-open (never a
  // fake size); the mount's direct_io makes the kernel read to EOF anyway,
  // and attrTimeout '0' routes the post-open fstat to fgetattr, which serves
  // the real hydrated size. We can't prefetch on getattr — that would make
  // `ls` issue an API call per directory entry.

  function mkSizeNullWs(): Workspace {
    return new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
  }

  it('getattr reports size 0 (no API fetch) when stat returns size=null', async () => {
    const ws = mkSizeNullWs()
    await ws.fs.writeFile('/data/api.json', new TextEncoder().encode('content'))
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.JSON }),
    )
    const readSpy = vi.spyOn(ws.fs, 'readFile')
    const mfs = new MirageFS(ws)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/api.json')
    expect(code).toBe(0)
    expect(attr.size).toBe(0)
    // The point of reporting 0: getattr stays cheap.
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('open prefetches and read returns the actual bytes (kernel sequence)', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('payload from API')
    await ws.fs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.JSON }),
    )
    const mfs = new MirageFS(ws)
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
    await ws.fs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.JSON }),
    )
    const mfs = new MirageFS(ws)
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
    await ws.fs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.JSON }),
    )
    const mfs = new MirageFS(ws)
    await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [, attr] = await callOp<[number, FuseAttr]>(mfs, 'getattr', '/data/api.json')
    expect(attr.size).toBe(bytes.byteLength)
  })

  it('fgetattr serves the real size from the open-hydrated handle', async () => {
    const ws = mkSizeNullWs()
    const bytes = new TextEncoder().encode('hydrated bytes')
    await ws.fs.writeFile('/data/api.json', bytes)
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.JSON }),
    )
    const mfs = new MirageFS(ws)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/api.json', 0)
    const [code, attr] = await callOp<[number, FuseAttr]>(mfs, 'fgetattr', '/data/api.json', fh)
    expect(code).toBe(0)
    expect(attr.size).toBe(bytes.byteLength)
  })
})

describe('MirageFS — release does not auto-flush', () => {
  it('pending write_buf survives release (kernel issues flush first)', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/greeting.txt', 0)
    const data = Buffer.from('clobber')
    await callOp(mfs, 'write', '/data/greeting.txt', fh, data, data.byteLength, 0)
    const [releaseCode] = await callOp<[number]>(mfs, 'release', '/data/greeting.txt', fh)
    expect(releaseCode).toBe(0)
    // Without flush(), the file on disk is untouched.
    const current = await ws.fs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(current)).toBe('hello world\n')
  })

  it('flush persists the buffered writes', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
    const [, fh] = await callOp<[number, number]>(mfs, 'open', '/data/greeting.txt', 0)
    const data = Buffer.from('CLOBBER world\n')
    await callOp(mfs, 'write', '/data/greeting.txt', fh, data, data.byteLength, 0)
    await callOp(mfs, 'flush', '/data/greeting.txt', fh)
    await callOp(mfs, 'release', '/data/greeting.txt', fh)
    const after = await ws.fs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(after)).toBe('CLOBBER world\n')
  })
})

describe('MirageFS — xattr', () => {
  it('round-trips set and get', async () => {
    const ws = await mkWs()
    const mfs = new MirageFS(ws)
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
    const mfs = new MirageFS(ws)
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
    const mfs = new MirageFS(ws)
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
    const mfs = new MirageFS(ws)
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
    const mfs = new MirageFS(ws)
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
    await ws.execute("echo 'new' > /data/renamed.txt")
    const [, list] = await callOp<[number, string[]]>(mfs, 'listxattr', '/data/renamed.txt')
    expect(list).toEqual([])
  })
})

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
import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { ContentType, FileStat, FileType, MountMode } from '@struktoai/mirage-core/types'
import { type Clock, ManualClock } from '@struktoai/mirage-core/utils/clock'
import { mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { MountCore, PREFETCH_TTL_MS } from './core.ts'

const NAIVE_STAMP = '2026-01-02T03:04:05'

async function mkCore(): Promise<MountCore> {
  const ws = new Workspace(
    { '/data/': new RAMResource(), '/extra/': new RAMResource() },
    { mode: MountMode.WRITE },
  )
  await ws.execute("echo 'hello world' | tee /data/greeting.txt")
  await ws.execute("mkdir -p /data/sub && echo 'nested' > /data/sub/inner.txt")
  return new MountCore(ws.fs)
}

describe('MountCore', () => {
  it('refuses a symlink on hidden turf for a scoped session', async () => {
    // The R8 hole: a session-scoped kernel mount could create a link on
    // a mount the profile hides, because the FUSE symlink path wrote the
    // namespace table directly, at a layer no session view covers.
    const ws = new Workspace(
      { '/data/': new RAMResource(), '/extra/': new RAMResource() },
      { mode: MountMode.WRITE },
    )
    await ws.execute("echo 'hello' > /data/greeting.txt")
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/extra'] } } })
    const core = new MountCore(ws.fs, { session: sess })
    // The fs adapter enters the session context before every kernel
    // callback; the unit test binds the same way.
    await runWithSession(sess, async () => {
      await expect(core.symlink('/data/greeting.txt', '/extra/lk')).rejects.toMatchObject({
        code: 'EACCES',
      })
      await core.symlink('greeting.txt', '/data/lk')
    })
    expect(ws.namespace.isLink('/extra/lk')).toBe(false)
    expect(ws.namespace.readlink('/data/lk')).toBe('greeting.txt')
  })

  it('refuses to remove a link on hidden turf for a scoped session', async () => {
    // The other half of the R8 hole, open until unlink stopped calling
    // the namespace table directly: creation was routed through the op
    // door, removal still wrote the table at a layer no session view
    // covers, so a scoped mount could delete a link on a mount its
    // profile hides. ENOENT rather than the create's EACCES is the
    // no-name-leak rule: only an op that spells out a name it is
    // creating answers EACCES.
    const ws = new Workspace(
      { '/data/': new RAMResource(), '/extra/': new RAMResource() },
      { mode: MountMode.WRITE },
    )
    await ws.execute("echo 'classified' > /extra/secret.txt")
    await ws.execute('ln -s secret.txt /extra/lk')
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/extra'] } } })
    const core = new MountCore(ws.fs, { session: sess })
    await runWithSession(sess, async () => {
      await expect(core.unlink('/extra/lk')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    expect(ws.namespace.isLink('/extra/lk')).toBe(true)
  })

  it('removes a link and keeps its target', async () => {
    // The other side of routing removal through the door: an unscoped
    // mount still drops the link entry, and only that, the way
    // unlink(2) on a symlink leaves the pointee alone.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'body' > /data/f.txt")
    await ws.execute('ln -s f.txt /data/lk')
    const core = new MountCore(ws.fs)
    await core.unlink('/data/lk')
    expect(ws.namespace.isLink('/data/lk')).toBe(false)
    expect(new TextDecoder().decode((await ws.execute('cat /data/f.txt')).stdout)).toBe('body\n')
  })

  it('reports a file with its real size', async () => {
    const core = await mkCore()
    const attr = await core.getattr('/data/greeting.txt')
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe(12)
  })

  it('reports directories', async () => {
    const core = await mkCore()
    expect((await core.getattr('/data/sub')).mode & 0o170000).toBe(0o040000)
  })

  it('throws a plain error for a missing path, not an errno code', async () => {
    // An adapter classifies the error; the core does not know what a FUSE
    // error code is.
    const core = await mkCore()
    await expect(core.getattr('/data/nope.txt')).rejects.toThrow()
  })

  it('lists children with . and ..', async () => {
    const core = await mkCore()
    const entries = await core.readdir('/data')
    expect(entries.slice(0, 2)).toEqual(['.', '..'])
    expect(entries).toContain('greeting.txt')
    expect(entries).toContain('sub')
  })

  it('slices reads', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt')
    const head = await core.read('/data/greeting.txt', fh, 0, 5)
    expect(new TextDecoder().decode(head)).toBe('hello')
  })

  it('tracks and releases handles', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt')
    expect(core.handles.has(fh)).toBe(true)
    await core.release(fh)
    expect(core.handles.has(fh)).toBe(false)
  })

  it('flushes buffered writes on release when no flush arrived', async () => {
    // The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH in
    // between (the kext always flushes on close); dropping the buffer at
    // release silently lost data written through an fskit mount.
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt')
    const payload = new TextEncoder().encode('rewritten, longer than before\n')
    await core.write('/data/greeting.txt', fh, payload, 0)
    await core.release(fh)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('rewritten, longer than before\n')
  })

  it('drops the old body when the open carries O_TRUNC', async () => {
    // libfuse 3 negotiates atomic O_TRUNC, so the kernel never sends a
    // separate truncate before an O_TRUNC open; the flag on the open has
    // to do it. Ignoring it left `printf BB > f` holding BB plus the tail
    // of the longer body it replaced (#1032).
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    expect((await core.fgetattr('/data/greeting.txt', fh)).size).toBe(0)
    await core.write('/data/greeting.txt', fh, new TextEncoder().encode('BB\n'), 0)
    await core.release(fh)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it('settles writes buffered on another handle before an O_TRUNC open truncates', async () => {
    // A write the kernel already acknowledged on handle A precedes the
    // O_TRUNC open on handle B, so it must land before the truncation,
    // not stay queued to overwrite B's body when A is released.
    const core = await mkCore()
    const first = await core.open('/data/greeting.txt', fsConstants.O_WRONLY)
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const second = await core.open('/data/greeting.txt', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    await core.write('/data/greeting.txt', second, new TextEncoder().encode('BB\n'), 0)
    await core.release(second)
    await core.release(first)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it('settles a handle opened on the target when the O_TRUNC open comes through a link', async () => {
    // The dispatcher follows both paths to one file, so a handle opened on
    // the target and an O_TRUNC open through a link to it are the same
    // file: the queued write lands first and the truncation wins.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'hello world' | tee /data/greeting.txt")
    await ws.execute('ln -s greeting.txt /data/lk')
    const core = new MountCore(ws.fs)
    const first = await core.open('/data/greeting.txt', fsConstants.O_WRONLY)
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const second = await core.open('/data/lk', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    await core.write('/data/lk', second, new TextEncoder().encode('BB\n'), 0)
    await core.release(second)
    await core.release(first)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it('a prefetch in flight across a truncate re-reads rather than installing stale bytes', async () => {
    // The first open's read was out when the O_TRUNC open landed; what it
    // fetched is the old body, and installing it would let that handle
    // and later stats serve pre-truncation content.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.fs.writeFile('/data/api.json', new TextEncoder().encode('hydrated bytes'))
    vi.spyOn(ws.fs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const original = ws.fs.readFile.bind(ws.fs)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.spyOn(ws.fs, 'readFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      calls += 1
      if (calls === 1) await gate
      return original(...args)
    })
    // The O_TRUNC open hydrates through the same in-flight read, so the
    // gate opens once its truncation has landed rather than after it
    // returns.
    const realTruncate = ws.fs.truncate.bind(ws.fs)
    let truncated: () => void = () => undefined
    const truncateDone = new Promise<void>((resolve) => {
      truncated = resolve
    })
    vi.spyOn(ws.fs, 'truncate').mockImplementation(
      async (...args: Parameters<typeof realTruncate>) => {
        await realTruncate(...args)
        truncated()
      },
    )
    const core = new MountCore(ws.fs)
    const pending = core.open('/data/api.json')
    const opening = core.open('/data/api.json', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    await truncateDone
    release()
    const writer = await opening
    const reader = await pending
    expect((await core.fgetattr('/data/api.json', reader)).size).toBe(0)
    await core.release(writer)
    await core.release(reader)
  })

  it('queues an O_TRUNC open behind a flush that is still landing', async () => {
    // The flush detached its buffer and is awaiting the backend write when
    // the O_TRUNC open arrives. Truncating right away would let the flush
    // finish afterwards and restore the old body over the truncation.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'hello world' | tee /data/greeting.txt")
    const original = ws.fs.writeFile.bind(ws.fs)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.spyOn(ws.fs, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        calls += 1
        if (calls === 1) await gate
        return original(...args)
      },
    )
    const core = new MountCore(ws.fs)
    const first = await core.open('/data/greeting.txt', fsConstants.O_WRONLY)
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const flushing = core.flush('/data/greeting.txt', first)
    const opening = core.open('/data/greeting.txt', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    release()
    await flushing
    const second = await opening
    await core.write('/data/greeting.txt', second, new TextEncoder().encode('BB\n'), 0)
    await core.release(second)
    await core.release(first)
    const body = await ws.fs.readFile('/data/greeting.txt')
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it('an O_TRUNC open through a link drops the cached bytes of its target', async () => {
    // The target was opened and released as greeting.txt, leaving its
    // bytes in the TTL cache; truncating through the link must drop that
    // entry too, or the next stat of the target serves the old length.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'hello world' | tee /data/greeting.txt")
    await ws.execute('ln -s greeting.txt /data/lk')
    const realStat = ws.fs.stat.bind(ws.fs)
    vi.spyOn(ws.fs, 'stat').mockImplementation(async (path) => {
      const s = await realStat(path)
      return s.type === FileType.FILE
        ? new FileStat({ name: s.name, type: s.type, content: s.content })
        : s
    })
    const core = new MountCore(ws.fs)
    const fh = await core.open('/data/greeting.txt')
    await core.release(fh)
    expect((await core.getattr('/data/greeting.txt')).size).toBe(12)
    const writer = await core.open('/data/lk', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    await core.release(writer)
    expect((await core.getattr('/data/greeting.txt')).size).toBe(0)
  })

  it('keeps no prefetch generation once the prefetch has settled', async () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'hello world' | tee /data/greeting.txt")
    const core = new MountCore(ws.fs)
    const generations = (core as unknown as { prefetchGen: Map<string, number> }).prefetchGen
    for (const name of ['a', 'b', 'c']) {
      const fh = await core.create(`/data/${name}.txt`)
      await core.write(`/data/${name}.txt`, fh, new TextEncoder().encode(name), 0)
      await core.release(fh)
      await core.truncate(`/data/${name}.txt`, 0)
    }
    expect(generations.size).toBe(0)
  })

  it("keeps the other handle's buffer when the settlement flush is refused", async () => {
    // The acknowledged bytes must stay buffered so that handle's own
    // flush reports the refusal rather than succeeding over an empty
    // buffer.
    const resource = new RAMResource()
    const seed = new Workspace({ '/data/': resource }, { mode: MountMode.WRITE })
    await seed.fs.writeFile('/data/existing.txt', 'seed')
    const core = new MountCore(new Workspace({ '/data/': resource }, { mode: MountMode.READ }).fs)
    const first = await core.open('/data/existing.txt', fsConstants.O_WRONLY)
    await core.write('/data/existing.txt', first, new TextEncoder().encode('QUEUED'), 0)
    await expect(
      core.open('/data/existing.txt', fsConstants.O_WRONLY | fsConstants.O_TRUNC),
    ).rejects.toThrow()
    await expect(core.flush('/data/existing.txt', first)).rejects.toThrow()
    const body = await seed.fs.readFile('/data/existing.txt')
    expect(new TextDecoder().decode(body)).toBe('seed')
  })

  it('keeps the body when the open carries no O_TRUNC', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt', fsConstants.O_RDWR)
    await core.write('/data/greeting.txt', fh, new TextEncoder().encode('J'), 0)
    await core.release(fh)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('Jello world\n')
  })

  it('reports a link with the node row its own stamps live on', async () => {
    // A link has no backend inode, so the node table is the only place
    // its stamps live. Built from the target string alone, getattr
    // answered the mount's construction time for every link, so a
    // no-follow touch through the mount was invisible right after it
    // landed.
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute("echo 'hello' > /data/greeting.txt")
    await ws.execute('ln -s greeting.txt /data/lk')
    await ws.dispatch('setattr', '/data/lk', [], {
      mtime: '2020-01-02T03:04:05Z',
      nofollow: true,
    })
    const core = new MountCore(ws.fs)
    const attrs = await core.getattr('/data/lk')
    expect(attrs.mode).toBe(0o120777)
    expect(attrs.size).toBe('greeting.txt'.length)
    expect(attrs.mtime.getTime()).toBe(Date.parse('2020-01-02T03:04:05Z'))
  })

  it('throws EINVAL from readlink on a regular file', async () => {
    const core = await mkCore()
    let code: string | undefined
    try {
      core.readlink('/data/greeting.txt')
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('EINVAL')
  })

  it('signals ENOTEMPTY for a non-empty directory', async () => {
    const core = await mkCore()
    let code: string | undefined
    try {
      await core.rmdir('/data/sub')
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('ENOTEMPTY')
  })

  it('round-trips advisory xattrs', async () => {
    const core = await mkCore()
    core.setxattr('/data/greeting.txt', 'user.tag', Buffer.from('v1'))
    expect(core.getxattr('/data/greeting.txt', 'user.tag')?.toString()).toBe('v1')
    expect(core.listxattr('/data/greeting.txt')).toContain('user.tag')
    core.removexattr('/data/greeting.txt', 'user.tag')
    expect(core.listxattr('/data/greeting.txt')).toEqual([])
  })

  it('honors the root prefix when resolving', () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws.fs, { rootPrefix: '/data/' })
    expect(core.resolve('/')).toBe('/data')
    expect(core.resolve('/x.txt')).toBe('/data/x.txt')
  })

  it('reports EXDEV for a rename across two mounts', async () => {
    // A whole-workspace mount spans several backends; the kernel probes
    // rename first and falls back to copy+unlink only on EXDEV, so this
    // refusal is what keeps `mv` between two backends working.
    const core = await mkCore()
    await expect(core.rename('/data/greeting.txt', '/extra/greeting.txt')).rejects.toMatchObject({
      code: 'EXDEV',
    })
    const fh = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', fh, 0, 100)
    expect(new TextDecoder().decode(body)).toBe('hello world\n')
  })
})

describe('applyStatAttrs', () => {
  it('reads an offset-less overlay stamp as UTC', async () => {
    // The R6 acceptance pin: this translator answers the same epoch as
    // core's stat view for a naive stamp, instead of `new Date`'s
    // local-time reading, which put python FUSE and node FUSE apart by
    // the host's UTC offset for the same backend stamp.
    const core = await mkCore()
    const naive = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: NAIVE_STAMP,
    })
    const aware = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: `${NAIVE_STAMP}+00:00`,
    })
    const base = {
      mtime: new Date(0),
      atime: new Date(0),
      ctime: new Date(0),
      nlink: 1,
      size: 0,
      mode: 0o100644,
      uid: 0,
      gid: 0,
    }
    const gotNaive = core.applyStatAttrs({ ...base }, naive)
    const gotAware = core.applyStatAttrs({ ...base }, aware)
    expect(gotNaive.mtime.getTime()).toBe(gotAware.mtime.getTime())
    expect(gotNaive.mtime.getTime()).toBe(mtimeMs(naive))
  })

  it('lands an epoch-zero stamp instead of reading it as unknown', async () => {
    // 1970-01-01T00:00:00Z is a real answer, not a missing stamp: the
    // fold keys on null, so epoch zero overwrites the construction-time
    // default instead of leaving it in place.
    const core = await mkCore()
    const epoch = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '1970-01-01T00:00:00Z',
    })
    const base = {
      mtime: new Date(12345),
      atime: new Date(12345),
      ctime: new Date(12345),
      nlink: 1,
      size: 0,
      mode: 0o100644,
      uid: 0,
      gid: 0,
    }
    const got = core.applyStatAttrs({ ...base }, epoch)
    expect(got.mtime.getTime()).toBe(0)
    expect(got.ctime.getTime()).toBe(0)
  })
})

/**
 * A clock whose wall reading can jump while monotonic stands still.
 *
 * ManualClock moves both readings together, which is right for virtual
 * time passing but cannot express the case a deadline has to survive:
 * NTP stepping the system clock while no real time has elapsed.
 */
class SteppingClock implements Clock {
  wall = 1_700_000_000
  mono = 0

  now(): number {
    return this.wall
  }

  monotonic(): number {
    return this.mono
  }
}

describe('MountCore clock', () => {
  it('holds the prefetch TTL boundary on an injected clock', async () => {
    // The prefetch cache is a deadline in milliseconds, so an injected
    // clock is the only way to sit on the boundary exactly: fresh one
    // second before the TTL, gone the second it lands.
    const clock = new ManualClock()
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE, clock })
    await ws.execute("echo -n 'payload' > /u.json")
    const core = new MountCore(ws.fs)
    expect(await core.prefetch('/u.json')).not.toBeNull()
    clock.advance(PREFETCH_TTL_MS / 1000 - 1)
    expect(core.cachedData('/u.json')).not.toBeNull()
    expect(core.cachedSize('/u.json')).toBe(7)
    clock.advance(1)
    expect(core.cachedSize('/u.json')).toBeNull()
    expect(core.cachedData('/u.json')).toBeNull()
    expect(core.prefetchCache.has('/u.json')).toBe(false)
  })

  it('ignores a wall clock jump when judging the prefetch deadline', async () => {
    // The deadline is a duration, so it must be measured on the
    // monotonic reading. Reading wall clock instead would expire every
    // prefetched file the moment NTP stepped the system clock forward.
    const clock = new SteppingClock()
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE, clock })
    await ws.execute("echo -n 'payload' > /u.json")
    const core = new MountCore(ws.fs)
    expect(await core.prefetch('/u.json')).not.toBeNull()
    clock.wall += 10 * 365 * 24 * 3600
    expect(core.cachedData('/u.json')).not.toBeNull()
  })
})

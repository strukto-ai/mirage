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

import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { ContentType, FileStat, FileType, MountMode } from '@struktoai/mirage-core/types'
import { type Clock, ManualClock } from '@struktoai/mirage-core/utils/clock'
import { mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import { describe, expect, it } from 'vitest'
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

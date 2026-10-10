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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { ContentType, FileStat, FileType, MountMode } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enotsup, unnamedFsError } from '@struktoai/mirage-core/errors/fs'
import { DIR_SIZE, mtimeMs } from '@struktoai/mirage-core/utils/stat_view'
import { READ_CHUNK } from '@struktoai/mirage-core/runtime/handles/constants'
import { describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { MountCore } from './core.ts'

const NAIVE_STAMP = '2026-01-02T03:04:05'
const PAYLOAD = new TextEncoder().encode('payload-bytes')

/** A caching mount whose backend names no size, as an API mount does. */
class UnsizedRAM extends RAMVFS {
  override readonly cachesReads = true
  reads = 0

  constructor() {
    super()
    this.store.dirs.add('/')
    this.store.files.set('/u.json', PAYLOAD)
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const row = await super.stat(path)
    return row.type === FileType.DIRECTORY ? row : row.with({ size: null })
  }

  override read(...args: Parameters<RAMVFS['read']>): ReturnType<RAMVFS['read']> {
    this.reads += 1
    return super.read(...args)
  }
}

async function mkCore(): Promise<MountCore> {
  const ws = new Workspace(
    { '/data/': new RAMVFS(), '/extra/': new RAMVFS() },
    { mode: MountMode.WRITE },
  )
  await ws.shell("echo 'hello world' | tee /data/greeting.txt")
  await ws.shell("mkdir -p /data/sub && echo 'nested' > /data/sub/inner.txt")
  return new MountCore(ws.vfs)
}

describe('MountCore', () => {
  it('refuses a truncate the mount cannot do and keeps the bytes', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello' > /data/f.txt")
    const refused = enotsup('ram', 'truncate', '/data/f.txt')
    vi.spyOn(ws.vfs, 'truncate').mockRejectedValue(refused)
    await expect(new MountCore(ws.vfs).truncate('/data/f.txt', 2)).rejects.toBe(refused)
    expect(new TextDecoder().decode(await ws.vfs.read('/data/f.txt'))).toBe('hello\n')
  })

  it('runs every op under its session with no adapter binding it', async () => {
    // The SFTP entry point drives MountCore directly, with no FUSE adapter to
    // enter the session context, so the core binds its own session per
    // op, as Python's MountCore does.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'token' > /data/secret.txt")
    const sess = ws.createSession('agent', {
      profile: { commands: { deny: [{ reason: 'sealed', paths: ['/data/secret.txt'] }] } },
    })
    const readAll = async (core: MountCore): Promise<string> => {
      const fd = await core.open('/data/secret.txt')
      return new TextDecoder().decode(await core.read('/data/secret.txt', fd, 0, 64))
    }
    expect(await readAll(new MountCore(ws.vfs))).toBe('token\n')
    await expect(readAll(new MountCore(ws.vfs, { session: sess }))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('refuses a symlink on hidden turf for a scoped session', async () => {
    // The R8 hole: a session-scoped kernel mount could create a link on
    // a mount the profile hides, because the FUSE symlink path wrote the
    // namespace table directly, at a layer no session view covers. The
    // refusal is ENOENT: symlink is a create, and a create under a
    // hidden directory answers as every read of that directory does.
    const ws = new Workspace(
      { '/data/': new RAMVFS(), '/extra/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.shell("echo 'hello' > /data/greeting.txt")
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/extra'] } } })
    const core = new MountCore(ws.vfs, { session: sess })
    // The fs adapter enters the session context before every kernel
    // callback; the unit test binds the same way.
    await runWithSession(sess, async () => {
      await expect(core.symlink('/data/greeting.txt', '/extra/lk')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await core.symlink('greeting.txt', '/data/lk')
    })
    expect(ws.namespace.isLink('/extra/lk')).toBe(false)
    expect(ws.namespace.readlink('/data/lk')).toBe('greeting.txt')
  })

  it('refuses to remove a link on hidden turf for a scoped session', async () => {
    // The other half of the R8 hole, open until unlink stopped calling
    // the namespace table directly: creation was routed through the
    // dispatcher, removal still wrote the table at a layer no session view
    // covers, so a scoped mount could delete a link on a mount its
    // profile hides. ENOENT rather than the create's EACCES is the
    // no-name-leak rule: only an op that spells out a name it is
    // creating answers EACCES.
    const ws = new Workspace(
      { '/data/': new RAMVFS(), '/extra/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.shell("echo 'classified' > /extra/secret.txt")
    await ws.shell('ln -s secret.txt /extra/lk')
    const sess = ws.createSession('agent', { profile: { paths: { hide: ['/extra'] } } })
    const core = new MountCore(ws.vfs, { session: sess })
    await runWithSession(sess, async () => {
      await expect(core.unlink('/extra/lk')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    expect(ws.namespace.isLink('/extra/lk')).toBe(true)
  })

  it('removes a link and keeps its target', async () => {
    // The other side of routing removal through the dispatcher: an unscoped
    // mount still drops the link entry, and only that, the way
    // unlink(2) on a symlink leaves the pointee alone.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'body' > /data/f.txt")
    await ws.shell('ln -s f.txt /data/lk')
    const core = new MountCore(ws.vfs)
    await core.unlink('/data/lk')
    expect(ws.namespace.isLink('/data/lk')).toBe(false)
    expect(new TextDecoder().decode((await ws.shell('cat /data/f.txt')).stdout)).toBe('body\n')
  })

  it('writes a file the session may not read', async () => {
    // Writing at an offset is one write at the dispatcher, so a policy that
    // refuses reads leaves FUSE writes alone, as a write-only descriptor
    // takes pwrite(2). The flush used to read the file first, and a refused
    // read was taken for an empty file, so the write wiped what was there.
    const vfs = new RAMVFS()
    const ws = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await ws.shell("printf 'line1\\n' > /data/log")
    ws.policies.add({
      preVfs: (ctx) => (ctx.op === 'read' ? { kind: 'deny', reason: 'write-only' } : null),
    })
    const core = new MountCore(ws.vfs)
    const enc = new TextEncoder()
    await core.write('/data/log', -1, enc.encode('more\n'), 6)
    const fd = await core.open('/data/log', fsConstants.O_WRONLY)
    await core.write('/data/log', fd, enc.encode('a'), 11)
    await core.write('/data/log', fd, enc.encode('b\n'), 12)
    await core.release(fd)
    expect(new TextDecoder().decode(vfs.store.files.get('/log'))).toBe('line1\nmore\nab\n')
  })

  it('refreshes what it holds when a flush fails after a run landed', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('printf abcdefgh > /data/f')
    const realPwrite = ws.vfs.pwrite.bind(ws.vfs)
    vi.spyOn(ws.vfs, 'pwrite')
      .mockImplementationOnce(realPwrite)
      .mockRejectedValueOnce(unnamedFsError('EACCES', 'denied'))
    const core = new MountCore(ws.vfs)
    const dec = new TextDecoder()
    const enc = new TextEncoder()
    const reader = await core.open('/data/f', fsConstants.O_RDONLY)
    expect(dec.decode(await core.read('/data/f', reader, 0, 8))).toBe('abcdefgh')
    const fd = await core.open('/data/f', fsConstants.O_WRONLY)
    await core.write('/data/f', fd, enc.encode('X'), 0)
    await core.write('/data/f', fd, enc.encode('Y'), 5)
    await expect(core.flush('/data/f', fd)).rejects.toMatchObject({ code: 'EACCES' })
    expect(dec.decode(await core.read('/data/f', reader, 0, 8))).toBe('Xbcdefgh')
  })

  it('lands only the runs that failed when a flush is retried', async () => {
    const vfs = new RAMVFS()
    const ws = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await ws.shell('printf abcdefgh > /data/f')
    const realPwrite = ws.vfs.pwrite.bind(ws.vfs)
    const pwrite = vi
      .spyOn(ws.vfs, 'pwrite')
      .mockImplementationOnce(realPwrite)
      .mockRejectedValueOnce(unnamedFsError('EACCES', 'denied'))
    const core = new MountCore(ws.vfs)
    const enc = new TextEncoder()
    const fd = await core.open('/data/f', fsConstants.O_WRONLY)
    await core.write('/data/f', fd, enc.encode('Y'), 5)
    await core.write('/data/f', fd, enc.encode('X'), 0)
    await expect(core.flush('/data/f', fd)).rejects.toMatchObject({ code: 'EACCES' })
    await realPwrite('/data/f', enc.encode('W'), 5)
    await core.flush('/data/f', fd)
    expect(new TextDecoder().decode(vfs.store.files.get('/f'))).toBe('XbcdeWgh')
    expect(pwrite).toHaveBeenCalledTimes(3)
  })

  it('keeps the errno of a failed direct write', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('printf abcdefgh > /data/f')
    vi.spyOn(ws.vfs, 'pwrite').mockRejectedValueOnce(unnamedFsError('EACCES', 'denied'))
    const core = new MountCore(ws.vfs)
    await expect(core.write('/data/f', -1, new TextEncoder().encode('X'), 0)).rejects.toMatchObject(
      { code: 'EACCES' },
    )
  })

  it('reports a file with its real size', async () => {
    const core = await mkCore()
    const attr = await core.getattr('/data/greeting.txt')
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe(12)
  })

  it('reports directories', async () => {
    const core = await mkCore()
    const attr = await core.getattr('/data/sub')
    expect(attr.mode & 0o170000).toBe(0o040000)
    expect(attr.size).toBe(DIR_SIZE)
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
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello world' | tee /data/greeting.txt")
    await ws.shell('ln -s greeting.txt /data/lk')
    const core = new MountCore(ws.vfs)
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
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/api.json', new TextEncoder().encode('hydrated bytes'))
    vi.spyOn(ws.vfs, 'stat').mockResolvedValue(
      new FileStat({ name: 'api.json', type: FileType.FILE, content: ContentType.JSON }),
    )
    const original = ws.vfs.read.bind(ws.vfs)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.spyOn(ws.vfs, 'read').mockImplementation(async (...args: Parameters<typeof original>) => {
      calls += 1
      if (calls === 1) await gate
      return original(...args)
    })
    // The O_TRUNC open hydrates through the same in-flight read, so the
    // gate opens once its truncation has landed rather than after it
    // returns.
    const realTruncate = ws.vfs.truncate.bind(ws.vfs)
    let truncated: () => void = () => undefined
    const truncateDone = new Promise<void>((resolve) => {
      truncated = resolve
    })
    vi.spyOn(ws.vfs, 'truncate').mockImplementation(
      async (...args: Parameters<typeof realTruncate>) => {
        await realTruncate(...args)
        truncated()
      },
    )
    const core = new MountCore(ws.vfs)
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
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello world' | tee /data/greeting.txt")
    const original = ws.vfs.write.bind(ws.vfs)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.spyOn(ws.vfs, 'write').mockImplementation(async (...args: Parameters<typeof original>) => {
      calls += 1
      if (calls === 1) await gate
      return original(...args)
    })
    const core = new MountCore(ws.vfs)
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
    const body = await ws.vfs.read('/data/greeting.txt')
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it("takes a released file's size from the workspace cache", async () => {
    const vfs = new UnsizedRAM()
    const core = new MountCore(new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE }).vfs)
    expect((await core.getattr('/data/u.json')).size).toBe(0)
    let fh = await core.open('/data/u.json')
    expect(await core.read('/data/u.json', fh, 0, 1024)).toEqual(PAYLOAD)
    await core.release(fh)
    expect((await core.getattr('/data/u.json')).size).toBe(PAYLOAD.byteLength)
    fh = await core.open('/data/u.json')
    await core.release(fh)
    expect(vfs.reads).toBe(1)
  })

  it('an O_TRUNC open through a link leaves no stale size for its target', async () => {
    // The target was opened and released as u.json, leaving its bytes in
    // the workspace cache; truncating through the link must not leave the
    // old length for the next stat of the target.
    const ws = new Workspace({ '/data/': new UnsizedRAM() }, { mode: MountMode.WRITE })
    await ws.shell('ln -s u.json /data/lk')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/u.json')
    await core.release(fh)
    expect((await core.getattr('/data/u.json')).size).toBe(PAYLOAD.byteLength)
    const writer = await core.open('/data/lk', fsConstants.O_WRONLY | fsConstants.O_TRUNC)
    await core.release(writer)
    expect((await core.getattr('/data/u.json')).size).toBe(0)
  })

  it('keeps no hydration generation once the hydration has settled', async () => {
    const ws = new Workspace({ '/data/': new UnsizedRAM() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws.vfs)
    const generations = (core as unknown as { hydrationGen: Map<string, number> }).hydrationGen
    for (let i = 0; i < 3; i++) {
      const fh = await core.open('/data/u.json')
      await core.write('/data/u.json', fh, new TextEncoder().encode('x'), 0)
      await core.release(fh)
      await core.truncate('/data/u.json', 4)
    }
    expect(generations.size).toBe(0)
  })

  it('reads its own unflushed writes through a handle', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt', fsConstants.O_RDWR)
    const dec = new TextDecoder()
    expect(dec.decode(await core.read('/data/greeting.txt', fh, 0, 100))).toBe('hello world\n')
    await core.write('/data/greeting.txt', fh, new TextEncoder().encode('HELLO'), 0)
    await core.write('/data/greeting.txt', fh, new TextEncoder().encode('!'), 14)
    const want = 'HELLO world\n\0\0!'
    expect(dec.decode(await core.read('/data/greeting.txt', fh, 0, 100))).toBe(want)
    expect((await core.fgetattr('/data/greeting.txt', fh)).size).toBe(15)
    await core.release(fh)
    expect(dec.decode(await core.read('/data/greeting.txt', -1, 0, 100))).toBe(want)
  })

  it("keeps the other handle's buffer when the settlement flush is refused", async () => {
    // The acknowledged bytes must stay buffered so that handle's own
    // flush reports the refusal rather than succeeding over an empty
    // buffer.
    const vfs = new RAMVFS()
    const seed = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await seed.vfs.write('/data/existing.txt', 'seed')
    const core = new MountCore(new Workspace({ '/data/': vfs }, { mode: MountMode.READ }).vfs)
    const first = await core.open('/data/existing.txt', fsConstants.O_WRONLY)
    await core.write('/data/existing.txt', first, new TextEncoder().encode('QUEUED'), 0)
    await expect(
      core.open('/data/existing.txt', fsConstants.O_WRONLY | fsConstants.O_TRUNC),
    ).rejects.toThrow()
    await expect(core.flush('/data/existing.txt', first)).rejects.toThrow()
    const body = await seed.vfs.read('/data/existing.txt')
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
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello' > /data/greeting.txt")
    await ws.shell('ln -s greeting.txt /data/lk')
    await ws.dispatch('setattr', '/data/lk', [], {
      mtime: '2020-01-02T03:04:05Z',
      nofollow: true,
    })
    const core = new MountCore(ws.vfs)
    const attrs = await core.getattr('/data/lk')
    expect(attrs.mode).toBe(0o120777)
    expect(attrs.size).toBe('greeting.txt'.length)
    expect(attrs.mtime.getTime()).toBe(Date.parse('2020-01-02T03:04:05Z'))
  })

  it('throws EINVAL from readlink on a regular file', async () => {
    const core = await mkCore()
    await expect(core.readlink('/data/greeting.txt')).rejects.toMatchObject({ code: 'EINVAL' })
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

  it('round-trips xattrs through the dispatcher', async () => {
    const core = await mkCore()
    await core.setxattr('/data/greeting.txt', 'user.tag', new TextEncoder().encode('v1'))
    const value = await core.getxattr('/data/greeting.txt', 'user.tag')
    expect(new TextDecoder().decode(value)).toBe('v1')
    expect(await core.listxattr('/data/greeting.txt')).toContain('user.tag')
    await core.removexattr('/data/greeting.txt', 'user.tag')
    expect(await core.listxattr('/data/greeting.txt')).toEqual([])
  })

  it('refuses a missing attribute with ENODATA', async () => {
    const core = await mkCore()
    await expect(core.getxattr('/data/greeting.txt', 'user.absent')).rejects.toMatchObject({
      code: 'ENODATA',
    })
  })

  it('honors the root prefix when resolving', () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws.vfs, { rootPrefix: '/data/' })
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

describe('attrs', () => {
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
    const gotNaive = core.attrs(naive)
    const gotAware = core.attrs(aware)
    expect(gotNaive.mtime.getTime()).toBe(gotAware.mtime.getTime())
    expect(gotNaive.mtime.getTime()).toBe(mtimeMs(naive))
  })

  it('lands an epoch-zero stamp instead of reading it as unknown', async () => {
    // 1970-01-01T00:00:00Z is a real answer, not a missing stamp: the
    // translator keys on null, so epoch zero replaces the mount's start
    // time instead of reading as unknown.
    const core = await mkCore()
    const epoch = new FileStat({
      name: 'f',
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '1970-01-01T00:00:00Z',
    })
    const got = core.attrs(epoch)
    expect(got.mtime.getTime()).toBe(0)
    expect(got.ctime.getTime()).toBe(0)
  })
})

describe('open handles across rename', () => {
  it.each([false, true])(
    'keeps writes attached to the moved file (directory=%s)',
    async (directory) => {
      const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
      await ws.shell('mkdir /sub; echo nested > /sub/file')
      const core = new MountCore(ws.vfs)
      const fd = await core.open('/sub/file')
      await core.write('/sub/file', fd, new TextEncoder().encode('BEFORE'), 0)
      await core.rename(directory ? '/sub' : '/sub/file', '/moved')
      await core.write('/sub/file', fd, new TextEncoder().encode('AFTER'), 6)
      await core.release(fd)
      const target = directory ? '/moved/file' : '/moved'
      expect(new TextDecoder().decode(await core.read(target, -1, 0, 100))).toBe('BEFOREAFTER')
      await expect(core.getattr('/sub/file')).rejects.toThrow()
    },
  )
})

describe('MountCore chunks', () => {
  it('reads a large file a chunk at a time', async () => {
    // The kernel asks in small pieces; hydrating the whole file on the
    // first one moved all of it to answer a `head`. Mirrors Python's
    // test_a_large_file_reads_a_chunk_at_a_time.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/big.bin', new Uint8Array(3 * READ_CHUNK).fill(1))
    const core = new MountCore(ws.vfs)
    const fd = await core.open('/data/big.bin')
    const reads = vi.spyOn(ws.vfs, 'read')
    expect((await core.read('/data/big.bin', fd, 0, 4096)).length).toBe(4096)
    expect((await core.read('/data/big.bin', fd, 4096, 4096)).length).toBe(4096)
    expect((await core.read('/data/big.bin', fd, 3 * READ_CHUNK - 2, 4096)).length).toBe(2)
    expect(reads.mock.calls.map((call) => call[1])).toEqual([
      { offset: 0, size: READ_CHUNK },
      { offset: 3 * READ_CHUNK - 2, size: READ_CHUNK },
    ])
    await core.release(fd)
  })

  it('drops the chunk an open handle kept when the file changes', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'old'.repeat(READ_CHUNK))
    const core = new MountCore(ws.vfs)
    const reader = await core.open('/data/f.txt')
    expect(new TextDecoder().decode(await core.read('/data/f.txt', reader, 0, 3))).toBe('old')
    const writer = await core.open('/data/f.txt')
    await core.write('/data/f.txt', writer, new TextEncoder().encode('new'), 0)
    await core.release(writer)
    expect(new TextDecoder().decode(await core.read('/data/f.txt', reader, 0, 3))).toBe('new')
    await core.release(reader)
  })

  it.each(['rename', 'unlink'] as const)(
    'keeps an open handle reading past its chunk after a %s',
    async (change) => {
      // POSIX keeps an open descriptor on its file: a rename moves it and an
      // unlink leaves its bytes readable, chunks it has not fetched
      // included. Mirrors Python's test_an_open_chunked_handle_outlives.
      const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
      const body = Uint8Array.from({ length: 3 * READ_CHUNK }, (_, i) => i % 251)
      await ws.vfs.write('/data/big.bin', body)
      const core = new MountCore(ws.vfs)
      const fd = await core.open('/data/big.bin')
      expect(await core.read('/data/big.bin', fd, 0, 3)).toEqual(body.slice(0, 3))
      if (change === 'rename') await core.rename('/data/big.bin', '/data/moved.bin')
      else await core.unlink('/data/big.bin')
      const far = 2 * READ_CHUNK + 5
      expect(await core.read('/data/big.bin', fd, far, 4)).toEqual(body.slice(far, far + 4))
      await core.release(fd)
    },
  )

  it('holds with one read, and a refused read never blocks the removal', async () => {
    // One read serves every open handle; a read a policy refuses leaves
    // them chunked rather than refusing the unlink it allows. Mirrors
    // Python's test_holding_reads_once_and_never_blocks_the_removal.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    for (const name of ['/data/a.bin', '/data/b.bin']) {
      await ws.vfs.write(name, new Uint8Array(2 * READ_CHUNK).fill(1))
    }
    const core = new MountCore(ws.vfs)
    const shared = [await core.open('/data/a.bin'), await core.open('/data/a.bin')]
    for (const fd of shared) await core.read('/data/a.bin', fd, 0, 1)
    const reads = vi.spyOn(ws.vfs, 'read')
    await core.unlink('/data/a.bin')
    expect(reads).toHaveBeenCalledTimes(1)
    const refused = await core.open('/data/b.bin')
    await core.read('/data/b.bin', refused, 0, 1)
    reads.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await core.unlink('/data/b.bin')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    reads.mockRestore()
    await expect(ws.vfs.stat('/data/b.bin')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds an open back until the removal it raced is done', async () => {
    // FUSE can serve an open while an unlink holds the file. It waits for
    // the unlink, as the kernel orders an open and an unlink of one name,
    // and then finds the file gone; the early descriptor keeps its bytes.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const body = Uint8Array.from({ length: 3 * READ_CHUNK }, (_, i) => i % 251)
    await ws.vfs.write('/data/a.bin', body)
    const core = new MountCore(ws.vfs)
    const early = await core.open('/data/a.bin')
    await core.read('/data/a.bin', early, 0, 1)
    const real = ws.vfs.read.bind(ws.vfs)
    const late: Promise<number>[] = []
    const reads = vi.spyOn(ws.vfs, 'read').mockImplementation((path, options) => {
      if (options === undefined && late.length === 0) late.push(core.open('/data/a.bin'))
      return real(path, options)
    })
    await core.unlink('/data/a.bin')
    reads.mockRestore()
    expect(late).toHaveLength(1)
    await expect(late[0]).rejects.toMatchObject({ code: 'ENOENT' })
    const far = 2 * READ_CHUNK + 5
    expect(await core.read('/data/a.bin', early, far, 4)).toEqual(body.slice(far, far + 4))
  })

  it('reads nothing to hold a target when a link to it goes', async () => {
    // unlink(2) on a link takes the link entry, never the pointee's bytes.
    // Mirrors Python's test_removing_a_link_leaves_its_targets_handles_alone.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/real.bin', new Uint8Array(2 * READ_CHUNK).fill(1))
    await ws.shell('ln -s real.bin /data/alias')
    const core = new MountCore(ws.vfs)
    const fd = await core.open('/data/real.bin')
    await core.read('/data/real.bin', fd, 0, 1)
    const reads = vi.spyOn(ws.vfs, 'read')
    await core.unlink('/data/alias')
    expect(reads).not.toHaveBeenCalled()
    reads.mockRestore()
    await core.release(fd)
  })

  it('tells a session the command rules FUSE skips', () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const keys = { reason: 'keys', paths: ['/data/*.key'] }
      const ruled = ws.createSession('agent', {
        profile: { commands: { deny: [{ reason: 'no rm', commands: ['rm'] }, keys] } },
      })
      expect(new MountCore(ws.vfs, { session: ruled })).toBeInstanceOf(MountCore)
      expect(warn).toHaveBeenCalledTimes(1)
      const said = String(warn.mock.calls[0]?.[0])
      expect(said).toContain('commands.deny: no rm')
      expect(said).not.toContain('keys')
      warn.mockClear()
      const pathed = ws.createSession('pathed', { profile: { commands: { deny: [keys] } } })
      expect(new MountCore(ws.vfs, { session: pathed })).toBeInstanceOf(MountCore)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

it('refreshes generated documents through an already open handle', async () => {
  const ws = new Workspace(
    { '/': new RAMVFS(), '/secret': new RAMVFS() },
    { mode: MountMode.WRITE },
  )
  const session = ws.createSession('reader')
  await ws.skillMd('/SKILL.md', { sessionId: 'reader' })
  await ws.vfsMd('/VFS.md')
  const core = new MountCore(ws.vfs, { session })
  const skill = await core.open('/SKILL.md')
  expect(new TextDecoder().decode(await core.read('/SKILL.md', skill, 0, 100000))).toContain(
    'name: mirage',
  )
  await core.release(skill)
  const fd = await core.open('/VFS.md')
  const dec = new TextDecoder()
  expect(dec.decode(await core.read('/VFS.md', fd, 0, 100000))).toContain('/secret')
  await ws.setSessionProfile('reader', { paths: { hide: ['/secret'] } })
  const changed = await core.read('/VFS.md', fd, 0, 100000)
  expect(dec.decode(changed)).not.toContain('/secret')
  expect(dec.decode(changed)).toBe(await ws.vfsMd(undefined, { sessionId: 'reader' }))
  expect((await core.fgetattr('/VFS.md', fd)).size).toBe(changed.length)
  await ws.setSessionProfile('reader', { paths: { hide: ['/VFS.md'] } })
  await expect(core.read('/VFS.md', fd, 0, 100000)).rejects.toThrow()
  await core.release(fd)
  await ws.close()
})

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
import { runWithSession } from '../context/session_context.ts'
import { BaseVFS } from '../vfs/base.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { ContentType, FileStat, FileType, Limit, MountMode } from '../types.ts'
import type { PathSpec } from '../types.ts'
import type { Action, Policy, VfsContext } from '../policy/index.ts'
import { enotsup, erofs, unnamedFsError } from '../errors/fs.ts'
import { DIR_SIZE } from '../utils/stat_view.ts'
import { ByteSlice, MEMORY_LIMIT } from '../io/spool.ts'
import type { ByteSource } from '../io/types.ts'
import type { Handed } from '../vfs/types.ts'
import { READ_CHUNK } from '../runtime/handles/constants.ts'
import { openMode } from '../runtime/handles/index.ts'
import {
  Workspace as CoreWorkspace,
  type MountSpec,
  type WorkspaceOptions,
} from '../workspace/workspace/workspace.ts'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../test-utils.ts'
import { LISTING_CONCURRENCY } from './constants.ts'
import { MountCore } from './core.ts'
import type { MountAttrs } from './types.ts'
import type { Files } from '../workspace/files.ts'

/** The core's workspace with the test shell parser, as node's carries its own. */
class Workspace extends CoreWorkspace {
  constructor(mounts: Record<string, MountSpec>, options: WorkspaceOptions = {}) {
    super(mounts, { ...options })
  }
}

const PAYLOAD = new TextEncoder().encode('payload-bytes')

/** A store with no partial write: it keeps the base's truncate. */
class NoTruncateRAM extends RAMVFS {
  constructor() {
    super()
    Object.defineProperty(this, 'truncate', { value: Reflect.get(BaseVFS.prototype, 'truncate') })
  }
}

/** A mount whose writes are refused once `refused` is set: an open is
 * admitted, and the landing is what fails. */
class LandingRefusedRAM extends RAMVFS {
  refused = false

  override pwrite(...args: Parameters<RAMVFS['pwrite']>): ReturnType<RAMVFS['pwrite']> {
    if (this.refused) return Promise.reject(erofs(args[0]))
    return super.pwrite(...args)
  }

  override truncate(...args: Parameters<RAMVFS['truncate']>): ReturnType<RAMVFS['truncate']> {
    if (this.refused) return Promise.reject(erofs(args[0]))
    return super.truncate(...args)
  }
}

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

  it.each([[false], [true]])(
    'reads a file whole when its mount caps read (warm %s)',
    async (warm) => {
      // FUSE and SFTP read a small file whole and slice each chunk from it,
      // so a mount `read:` entry must not cut that read. Mirrors Python's
      // test_op_limit.py.
      const text = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}\n`).join('')
      const data = new TextEncoder().encode(text)
      const ram = new RAMVFS()
      Object.assign(ram, { cachesReads: warm })
      const ws = new Workspace(
        { '/data/': [ram, MountMode.WRITE, { read: new Limit({ maxLines: 3 }) }] },
        { mode: MountMode.WRITE },
      )
      try {
        await ws.vfs.write('/data/f.txt', data)
        if (warm) await ws.cache.set('/data/f.txt', data, { ttl: 600 })
        const core = new MountCore(ws.vfs)
        const fd = await core.open('/data/f.txt')
        let got = ''
        for (;;) {
          const piece = await core.read('/data/f.txt', fd, got.length, 64)
          if (piece.byteLength === 0) break
          got += new TextDecoder().decode(piece)
        }
        await core.release(fd)
        expect(got).toBe(text)
      } finally {
        await ws.close()
      }
    },
  )

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
      preVfs: (ctx) => (ctx.call.name === 'read' ? { kind: 'deny', reason: 'write-only' } : null),
    })
    const core = new MountCore(ws.vfs)
    const enc = new TextEncoder()
    await core.write('/data/log', -1, enc.encode('more\n'), 6)
    const fd = await core.open('/data/log', openMode(fsConstants.O_WRONLY, fsConstants))
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
    const reader = await core.open('/data/f', openMode(fsConstants.O_RDONLY, fsConstants))
    expect(dec.decode(await core.read('/data/f', reader, 0, 8))).toBe('abcdefgh')
    const fd = await core.open('/data/f', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/f', fd, enc.encode('X'), 0)
    await core.write('/data/f', fd, enc.encode('Y'), 5)
    await expect(core.flush('/data/f', fd)).rejects.toMatchObject({ code: 'EACCES' })
    expect(dec.decode(await ws.vfs.read('/data/f'))).toBe('Xbcdefgh')
    expect(dec.decode(await core.read('/data/f', reader, 0, 8))).toBe('XbcdeYgh')
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
    const fd = await core.open('/data/f', openMode(fsConstants.O_WRONLY, fsConstants))
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
    const fh = await core.open('/data/greeting.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    const payload = new TextEncoder().encode('rewritten, longer than before\n')
    await core.write('/data/greeting.txt', fh, payload, 0)
    await core.release(fh)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('rewritten, longer than before\n')
  })

  it.each(['sync', 'release'])(
    "lands two handles' writes in the order they were made (%s)",
    async (land) => {
      // The handle opened first writes inside bytes the other holds, and
      // lands first: the later write still wins, however the handles land,
      // and nothing lands before they do, though a read sees both at once.
      const core = await mkCore()
      const stored = async () =>
        new TextDecoder().decode(await core.read('/data/greeting.txt', -1, 0, 100))
      const landed = async () =>
        new TextDecoder().decode(await core.files.read('/data/greeting.txt'))
      const first = await core.open(
        '/data/greeting.txt',
        openMode(fsConstants.O_WRONLY, fsConstants),
      )
      const second = await core.open(
        '/data/greeting.txt',
        openMode(fsConstants.O_WRONLY, fsConstants),
      )
      await core.write('/data/greeting.txt', second, new TextEncoder().encode('oldold'), 0)
      await core.write('/data/greeting.txt', first, new TextEncoder().encode('new'), 2)
      expect(await landed()).toBe('hello world\n')
      expect(await stored()).toBe('olnewdworld\n')
      if (land === 'sync') {
        await core.sync()
      } else {
        await core.release(first)
        await core.release(second)
      }
      expect(await stored()).toBe('olnewdworld\n')
    },
  )

  it('leaves the file now at a name alone when an unlinked handle writes', async () => {
    // The old handle's file has no name left: the one now at that name is
    // another file, and its writes stay.
    const core = await mkCore()
    const old = await core.open('/data/greeting.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.unlink('/data/greeting.txt')
    const fresh = await core.create('/data/greeting.txt')
    await core.write('/data/greeting.txt', fresh, new TextEncoder().encode('new'), 0)
    await core.write('/data/greeting.txt', old, new TextEncoder().encode('old'), 0)
    await core.release(fresh)
    await core.release(old)
    const body = await core.read('/data/greeting.txt', -1, 0, 100)
    expect(new TextDecoder().decode(body)).toBe('new')
  })

  it('drops the old body when the open carries O_TRUNC', async () => {
    // libfuse 3 negotiates atomic O_TRUNC, so the kernel never sends a
    // separate truncate before an O_TRUNC open; the flag on the open has
    // to do it. Ignoring it left `printf BB > f` holding BB plus the tail
    // of the longer body it replaced (#1032).
    const core = await mkCore()
    const fh = await core.open(
      '/data/greeting.txt',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
    expect((await core.fgetattr('/data/greeting.txt', fh)).size).toBe(0)
    await core.write('/data/greeting.txt', fh, new TextEncoder().encode('BB\n'), 0)
    await core.release(fh)
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
    const first = await core.open('/data/greeting.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const second = await core.open(
      '/data/lk',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
    await core.write('/data/lk', second, new TextEncoder().encode('BB\n'), 0)
    await core.release(second)
    await core.release(first)
    const after = await core.open('/data/greeting.txt')
    const body = await core.read('/data/greeting.txt', after, 0, 100)
    await core.release(after)
    expect(new TextDecoder().decode(body)).toBe('BB\n')
  })

  it('meets a session handle through a link the default profile hides', async () => {
    // Handle keys are resolved outside the op, where the facade would judge
    // links by the default profile: one hiding the link must not split a
    // handle opened through it from one on its target, under a session
    // that sees both.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello world' | tee /data/greeting.txt")
    await ws.shell('ln -s greeting.txt /data/lk')
    await ws.setSessionProfile(ws.defaultSessionId, { paths: { hide: ['/data/lk'] } })
    const core = new MountCore(ws.vfs, { session: ws.createSession('agent', { profile: {} }) })
    expect(core.identity('/data/lk')).toBe(core.identity('/data/greeting.txt'))
    const first = await core.open('/data/greeting.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const second = await core.open(
      '/data/lk',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
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
    const opening = core.open(
      '/data/api.json',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
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
    const first = await core.open('/data/greeting.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/greeting.txt', first, new TextEncoder().encode('QUEUED'), 0)
    const flushing = core.flush('/data/greeting.txt', first)
    const opening = core.open(
      '/data/greeting.txt',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
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
    const writer = await core.open(
      '/data/lk',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
    await core.release(writer)
    expect((await core.getattr('/data/u.json')).size).toBe(0)
  })

  it('keeps no hydration generation once the hydration has settled', async () => {
    const ws = new Workspace({ '/data/': new UnsizedRAM() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws.vfs)
    const generations = (core as unknown as { hydrationGen: Map<string, number> }).hydrationGen
    for (let i = 0; i < 3; i++) {
      const fh = await core.open('/data/u.json', openMode(fsConstants.O_WRONLY, fsConstants))
      await core.write('/data/u.json', fh, new TextEncoder().encode('x'), 0)
      await core.release(fh)
      await core.truncate('/data/u.json', 4)
    }
    expect(generations.size).toBe(0)
  })

  it('replaces a file through a truncating open on a store that cannot truncate', async () => {
    const ws = new Workspace({ '/d/': new NoTruncateRAM() }, { mode: MountMode.WRITE })
    await ws.shell('echo hello > /d/f')
    const core = new MountCore(ws.vfs)
    const fh = await core.open(
      '/d/f',
      openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
    )
    await core.write('/d/f', fh, new TextEncoder().encode('new'), 0)
    await core.release(fh)
    expect(new TextDecoder().decode(await ws.vfs.read('/d/f'))).toBe('new')
    await core.truncate('/d/f', 1)
    expect(new TextDecoder().decode(await ws.vfs.read('/d/f'))).toBe('n')
  })

  it('stats the target through a handle opened on a link', async () => {
    const core = await mkCore()
    await core.files.symlink('/data/lnk', 'greeting.txt')
    const fh = await core.open('/data/lnk')
    const attr = await core.fgetattr('/data/lnk', fh)
    expect(attr.mode & 0o170000).toBe(0o100000)
    expect(attr.size).toBe('hello world\n'.length)
  })

  it('lands metadata made through a link path on the link itself', async () => {
    const core = await mkCore()
    await core.files.symlink('/data/lnk', 'greeting.txt')
    await core.files.symlink('/data/gone', 'missing.txt')
    await core.setattr('/data/lnk', null, 1234)
    await core.setattr('/data/gone', null, 4321)
    expect((await core.getattr('/data/lnk')).uid).toBe(1234)
    expect((await core.getattr('/data/gone')).uid).toBe(4321)
    expect((await core.getattr('/data/greeting.txt')).uid).not.toBe(1234)
  })

  it('shows a scoped mount root its own mode', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const core = new MountCore(ws.vfs, { rootPrefix: '/data' })
    await core.setattr('/', 0o700)
    expect((await core.getattr('/')).mode & 0o7777).toBe(0o700)
    expect((await new MountCore(ws.vfs).getattr('/')).mode & 0o170000).toBe(0o040000)
  })

  it('keeps times set on an open file over its buffered writes', async () => {
    // cp -p writes the copy, sets its times on the file it still holds
    // open, then closes it: the writes precede the times in POSIX order.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello world' > /data/f")
    const core = new MountCore(ws.vfs)
    const fd = await core.open('/data/f', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/f', fd, new TextEncoder().encode('copied'), 0)
    const when = new Date('2001-09-09T01:46:40.000Z')
    await core.setattr('/data/f', null, null, null, null, when)
    await core.release(fd)
    expect((await core.getattr('/data/f')).mtime.getTime()).toBe(when.getTime())
    expect(new TextDecoder().decode(await core.read('/data/f', -1, 0, 100))).toBe('copiedworld\n')
  })

  it('reads what a handle wrote while its flush is still landing', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("echo 'hello world' > /data/f")
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/f', openMode(fsConstants.O_RDWR, fsConstants))
    await core.read('/data/f', fh, 0, 100)
    await core.write('/data/f', fh, new TextEncoder().encode('HELLO'), 0)
    const realPwrite = ws.vfs.pwrite.bind(ws.vfs)
    let landed = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      landed = resolve
    })
    let sent = (): void => undefined
    const inFlight = new Promise<void>((resolve) => {
      sent = resolve
    })
    vi.spyOn(ws.vfs, 'pwrite').mockImplementation(async (...args) => {
      sent()
      await gate
      return realPwrite(...args)
    })
    const flushing = core.flush('/data/f', fh)
    // The flush has taken the buffer and its write is out.
    await inFlight
    const reading = core.read('/data/f', fh, 0, 100)
    landed()
    await flushing
    expect(new TextDecoder().decode(await reading)).toBe('HELLO world\n')
  })

  it('reads its own unflushed writes through a handle', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt', openMode(fsConstants.O_RDWR, fsConstants))
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
    const vfs = new LandingRefusedRAM()
    const seed = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await seed.vfs.write('/data/existing.txt', 'seed')
    vfs.refused = true
    const core = new MountCore(seed.vfs)
    const first = await core.open('/data/existing.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/existing.txt', first, new TextEncoder().encode('QUEUED'), 0)
    await expect(
      core.open(
        '/data/existing.txt',
        openMode(fsConstants.O_WRONLY | fsConstants.O_TRUNC, fsConstants),
      ),
    ).rejects.toThrow()
    await expect(core.flush('/data/existing.txt', first)).rejects.toThrow()
    const body = await seed.vfs.read('/data/existing.txt')
    expect(new TextDecoder().decode(body)).toBe('seed')
  })

  it('lets a handle go when its landing at release is refused', async () => {
    // As close(2): the refusal is reported and the handle is gone, rather
    // than kept open with bytes nothing will ever land.
    const vfs = new LandingRefusedRAM()
    const seed = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await seed.vfs.write('/data/existing.txt', 'seed')
    vfs.refused = true
    const core = new MountCore(seed.vfs)
    const fh = await core.open('/data/existing.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/data/existing.txt', fh, new TextEncoder().encode('REFUSED'), 0)
    await expect(core.release(fh)).rejects.toThrow()
    expect(core.handles.has(fh)).toBe(false)
    const body = await seed.vfs.read('/data/existing.txt')
    expect(new TextDecoder().decode(body)).toBe('seed')
  })

  it('keeps the body when the open carries no O_TRUNC', async () => {
    const core = await mkCore()
    const fh = await core.open('/data/greeting.txt', openMode(fsConstants.O_RDWR, fsConstants))
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
      const fd = await core.open('/sub/file', openMode(fsConstants.O_WRONLY, fsConstants))
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
    const writer = await core.open('/data/f.txt', openMode(fsConstants.O_WRONLY, fsConstants))
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
    const reads = vi
      .spyOn(ws.vfs, 'read')
      .mockImplementation((path, options?: { offset?: number; size?: number | null }) => {
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
    'name: workspace-commands',
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

it('renames and removes a link that loops, as rename(2) and unlink(2) act on the name', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  const core = new MountCore(ws.vfs)
  await core.symlink('loop', '/data/loop')
  await core.rename('/data/loop', '/data/spin')
  await core.symlink('loop', '/data/loop')
  await core.unlink('/data/loop')
  expect(ws.namespace.isLink('/data/loop')).toBe(false)
  expect(ws.namespace.isLink('/data/spin')).toBe(true)
})

it("stats what an unlinked file's handle wrote", async () => {
  const core = await mkCore()
  const fd = await core.open('/data/greeting.txt', openMode(fsConstants.O_RDWR, fsConstants))
  await core.read('/data/greeting.txt', fd, 0, 100)
  const longer = new TextEncoder().encode('a longer replacement')
  await core.write('/data/greeting.txt', fd, longer, 0)
  await core.unlink('/data/greeting.txt')
  expect((await core.fgetattr('/data/greeting.txt', fd)).size).toBe(longer.byteLength)
})

it('changes the target, not the link, when setattr follows', async () => {
  const core = await mkCore()
  await core.symlink('greeting.txt', '/data/lnk')
  await core.setattr('/data/lnk', null, 1234, null, null, new Date(1e12), true)
  const target = await core.getattr('/data/greeting.txt')
  expect([target.uid, target.mtime.getTime()]).toEqual([1234, 1e12])
  expect((await core.getattr('/data/lnk')).uid).not.toBe(1234)
})

/** A store that makes entries the way a disk mount under umask 077 does. */
class UmaskRAM extends RAMVFS {
  override async stat(path: PathSpec): Promise<FileStat> {
    const row = await super.stat(path)
    if (row.mode !== null) return row
    return row.with({ mode: row.type === FileType.DIRECTORY ? 0o700 : 0o600 })
  }
}

it("keeps a create's mode over the store's own umask", async () => {
  const core = new MountCore(
    new Workspace({ '/data/': new UmaskRAM() }, { mode: MountMode.WRITE }).vfs,
  )
  await core.release(await core.create('/data/f', 0o100644))
  await core.mkdir('/data/d', 0o755)
  expect((await core.getattr('/data/f')).mode & 0o7777).toBe(0o644)
  expect((await core.getattr('/data/d')).mode & 0o7777).toBe(0o755)
})

it('lands a create a policy refuses to stat', async () => {
  // The entry exists once the create returns: failing it then would make a
  // retry find it there.
  const vfs = new RAMVFS()
  const noStats: Policy = {
    preVfs: (ctx: VfsContext): Action | null =>
      ctx.call.name === 'stat' ? { kind: 'deny', reason: 'no stat' } : null,
  }
  const ws = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE, policies: [noStats] })
  const core = new MountCore(ws.vfs)
  await core.mkdir('/data/d', 0o700)
  await core.release(await core.create('/data/f', 0o100600))
  expect(vfs.store.dirs.has('/d')).toBe(true)
  expect(vfs.store.files.has('/f')).toBe(true)
})

it("holds an open through a link back until the link's removal is done", async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.shell('echo body > /data/a.txt; ln -s a.txt /data/lk')
  const core = new MountCore(ws.vfs)
  const real = ws.vfs.unlink.bind(ws.vfs)
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = (): void => undefined
  const out = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.spyOn(ws.vfs, 'unlink').mockImplementation(async (...args) => {
    entered()
    await gate
    return real(...args)
  })
  const removing = core.unlink('/data/lk')
  await out
  let opened = false
  const opening = core.open('/data/lk').finally(() => {
    opened = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(opened).toBe(false)
  release()
  await removing
  await expect(opening).rejects.toMatchObject({ code: 'ENOENT' })
})

/**
 * Hold the first call of `op` on `ws.vfs` until `go`: before it reaches the
 * store, or with `answered` after, its answer in flight. `out` settles once
 * it is held, and `calls` counts the calls of `op`.
 */
function holdFirst(
  ws: Workspace,
  op: 'pwrite' | 'read' | 'rename' | 'stat',
  answered = false,
): { out: Promise<void>; go: () => void; calls: () => number } {
  let go = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    go = resolve
  })
  let entered = (): void => undefined
  const out = new Promise<void>((resolve) => {
    entered = resolve
  })
  const real = (ws.vfs[op] as (...a: unknown[]) => Promise<unknown>).bind(ws.vfs)
  let calls = 0
  vi.spyOn(ws.vfs, op).mockImplementation((async (...args: unknown[]) => {
    calls += 1
    if (calls > 1) return real(...args)
    const answer = answered ? await real(...args) : undefined
    entered()
    await gate
    return answered ? answer : real(...args)
  }) as never)
  return { out, go, calls: () => calls }
}

it('ties a renamed handle to the destination a link names once the rename runs', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.shell('mkdir -p /data/a /data/b && printf hello > /data/f && ln -s a /data/lk')
  const core = new MountCore(ws.vfs)
  const enc = new TextEncoder()
  const fh = await core.open('/data/f', openMode(fsConstants.O_RDWR, fsConstants))
  await core.write('/data/f', fh, enc.encode('H'), 0)
  const held = holdFirst(ws, 'pwrite')
  const flushing = core.flush('/data/f', fh)
  await held.out
  const renaming = core.rename('/data/f', '/data/lk/f')
  await ws.shell('rm /data/lk && ln -s b /data/lk')
  held.go()
  await flushing
  await renaming
  await core.write('/data/f', fh, enc.encode('J'), 1)
  await core.release(fh)
  expect(new TextDecoder().decode(await ws.vfs.read('/data/b/f'))).toBe('HJllo')
  await expect(ws.vfs.stat('/data/a/f')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('lands a direct write still out before a truncate', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/f', new TextEncoder().encode('abc'))
  const held = holdFirst(ws, 'pwrite')
  const core = new MountCore(ws.vfs)
  const writing = core.write('/data/f', -1, new TextEncoder().encode('0123456789'), 0)
  await held.out
  const truncating = core.truncate('/data/f', 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  held.go()
  await writing
  await truncating
  expect((await ws.vfs.read('/data/f')).byteLength).toBe(0)
})

it('keeps nothing from a first read a change raced', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/f', new TextEncoder().encode('old bytes'))
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/f', openMode(fsConstants.O_RDWR, fsConstants))
  const held = holdFirst(ws, 'read', true)
  const reading = core.read('/data/f', fd, 0, 100)
  await held.out
  await core.truncate('/data/f', 0)
  held.go()
  expect(new TextDecoder().decode(await reading)).toBe('old bytes')
  expect((await core.read('/data/f', fd, 0, 100)).byteLength).toBe(0)
})

it('holds a release back until a flush still landing is done', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/f', new TextEncoder().encode('abc'))
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/f', openMode(fsConstants.O_WRONLY, fsConstants))
  await core.write('/data/f', fd, new TextEncoder().encode('X'), 0)
  const held = holdFirst(ws, 'pwrite')
  const first = core.flush('/data/f', fd)
  await held.out
  let released = false
  const releasing = core.release(fd).then(() => {
    released = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(released).toBe(false)
  held.go()
  await first
  await releasing
  expect(new TextDecoder().decode(await ws.vfs.read('/data/f'))).toBe('Xbc')
})

it('detaches the handles on a name an unlink or a rename takes', async () => {
  const core = await mkCore()
  const gone = await core.open('/data/greeting.txt')
  const linked = await core.open('/data/sub/inner.txt')
  await core.symlink('sub/inner.txt', '/data/lk')
  await core.unlink('/data/greeting.txt')
  await core.unlink('/data/lk')
  await core.write('/data/c.txt', -1, new TextEncoder().encode('new'), 0)
  const replaced = await core.open('/data/c.txt')
  await core.rename('/data/sub/inner.txt', '/data/c.txt')
  expect(core.handles.get(gone)?.detached).toBeDefined()
  expect(core.handles.get(replaced)?.detached).toBeDefined()
  expect(core.handles.get(linked)?.detached).toBeUndefined()
})

it('queues a flush a rename moved under the new name', async () => {
  // Queued under /a, the flush would write /b outside /b's queue, and a
  // truncate of /b could finish under it and be undone.
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/a', new TextEncoder().encode('abc'))
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/a', openMode(fsConstants.O_WRONLY, fsConstants))
  await core.write('/data/a', fd, new TextEncoder().encode('0123456789'), 0)
  const writes = holdFirst(ws, 'pwrite')
  const renames = holdFirst(ws, 'rename')
  const renaming = core.rename('/data/a', '/data/b')
  await renames.out
  const flushing = core.flush('/data/a', fd)
  await new Promise((resolve) => setTimeout(resolve, 0))
  renames.go()
  await renaming
  await writes.out
  const truncating = core.truncate('/data/b', 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  writes.go()
  await flushing
  await truncating
  expect((await ws.vfs.read('/data/b')).byteLength).toBe(0)
})

it('never lets a detached handle touch the file at its old name', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/a', new TextEncoder().encode('fresh'))
  await ws.vfs.write('/data/b', new TextEncoder().encode('stale-file'))
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/b', openMode(fsConstants.O_RDWR, fsConstants))
  await core.read('/data/b', fd, 0, 100)
  await core.write('/data/b', fd, new TextEncoder().encode('STALE'), 0)
  await core.rename('/data/a', '/data/b')
  await core.setattr('/data/b', null, null, null, null, new Date(1e12))
  expect((await core.fgetattr('/data/b', fd)).mtime.getTime()).not.toBe(1e12)
  expect(new TextDecoder().decode(await core.read('/data/b', fd, 0, 100))).toBe('STALE-file')
  await core.release(fd)
  expect(new TextDecoder().decode(await ws.vfs.read('/data/b'))).toBe('fresh')
})

it('keeps the file a detached handle never read', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/a', new TextEncoder().encode('fresh'))
  await ws.vfs.write('/data/b', new TextEncoder().encode('stale-file'))
  await ws.shell('chmod 600 /data/b')
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/b')
  await core.rename('/data/a', '/data/b')
  const attrs = await core.fgetattr('/data/b', fd)
  expect([attrs.size, attrs.mode & 0o7777]).toEqual([10, 0o600])
  expect(new TextDecoder().decode(await core.read('/data/b', fd, 0, 100))).toBe('stale-file')
})

it('holds the bytes of a removed file when only its stat is refused', async () => {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  const body = Uint8Array.from({ length: 3 * READ_CHUNK }, (_, i) => i % 251)
  await ws.vfs.write('/data/big.bin', body)
  const core = new MountCore(ws.vfs)
  const fd = await core.open('/data/big.bin')
  await core.read('/data/big.bin', fd, 0, 3)
  vi.spyOn(ws.vfs, 'stat').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await core.unlink('/data/big.bin')
  const far = 2 * READ_CHUNK + 5
  expect(await core.read('/data/big.bin', fd, far, 4)).toEqual(body.slice(far, far + 4))
})

it('makes a rename wait for an open already out', async () => {
  // The open has truncated and is reading the file back when a rename onto
  // its name starts: the rename takes the file the open made, and an open
  // replayed after it would truncate the file it put there.
  const vfs = new UnsizedRAM()
  vfs.store.files.set('/a', new TextEncoder().encode('fresh'))
  vfs.store.files.set('/b', new TextEncoder().encode('old'))
  const ws = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
  const core = new MountCore(ws.vfs)
  const reads = holdFirst(ws, 'read', true)
  const opening = core.open(
    '/data/b',
    openMode(fsConstants.O_RDWR | fsConstants.O_TRUNC, fsConstants),
  )
  await reads.out
  let renamed = false
  const renaming = core.rename('/data/a', '/data/b').finally(() => {
    renamed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(renamed).toBe(false)
  reads.go()
  const fd = await opening
  await renaming
  const dec = new TextDecoder()
  expect(dec.decode(await ws.vfs.read('/data/b'))).toBe('fresh')
  expect((await core.read('/data/b', fd, 0, 100)).byteLength).toBe(0)
})

it('makes a rename wait for an open of its source already out', async () => {
  // Registered after the rename moved the handles on its name, the open
  // would be left on a name that is gone.
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/a', new TextEncoder().encode('body'))
  const core = new MountCore(ws.vfs)
  const stats = holdFirst(ws, 'stat', true)
  const opening = core.open('/data/a')
  await stats.out
  let renamed = false
  const renaming = core.rename('/data/a', '/data/b').finally(() => {
    renamed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(renamed).toBe(false)
  stats.go()
  const fd = await opening
  await renaming
  expect(new TextDecoder().decode(await core.read('/data/b', fd, 0, 100))).toBe('body')
})

it('makes a flush onto a name a rename replaces wait for it', async () => {
  // Landing under the rename's hold would make what it read stale, and
  // reading again for as long as the file kept being written never ends.
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/a', new TextEncoder().encode('fresh'))
  await ws.vfs.write('/data/b', new TextEncoder().encode('old-body'))
  const core = new MountCore(ws.vfs)
  const reader = await core.open('/data/b')
  const writer = await core.open('/data/b', openMode(fsConstants.O_RDWR, fsConstants))
  await core.write('/data/b', writer, new TextEncoder().encode('NEW'), 0)
  const reads = holdFirst(ws, 'read', true)
  const renaming = core.rename('/data/a', '/data/b')
  await reads.out
  let flushed = false
  const flushing = core.flush('/data/b', writer).finally(() => {
    flushed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(flushed).toBe(false)
  reads.go()
  await renaming
  await flushing
  // One read of each view the handles hold: the stored bytes for the
  // writer, the rendering for the reader.
  expect(reads.calls()).toBe(2)
  const dec = new TextDecoder()
  // Both handles are on the file the rename took the name from, which the
  // writer's flush landed on, as POSIX keeps one inode for them.
  expect(dec.decode(await core.read('/data/b', reader, 0, 100))).toBe('NEW-body')
  expect(dec.decode(await core.read('/data/b', writer, 0, 100))).toBe('NEW-body')
  expect(dec.decode(await ws.vfs.read('/data/b'))).toBe('fresh')
})

describe('MountCore cached chunks and session revocation', () => {
  it.each(['hide', 'deny'] as const)(
    'rechecks %s before serving a warmed chunk',
    async (restriction) => {
      const path = '/data/chunked.bin'
      const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
      await ws.vfs.write(path, new Uint8Array(READ_CHUNK + 17).fill(23))
      const session = ws.createSession('chunk-reader')
      const core = new MountCore(ws.vfs, { session })
      const read = vi.spyOn(ws.vfs, 'read')
      const fd = await core.open(path)
      try {
        expect(await core.read(path, fd, 0, 8)).toEqual(new Uint8Array(8).fill(23))
        const calls = read.mock.calls.length
        expect(calls).toBe(1)
        await ws.setSessionProfile(
          'chunk-reader',
          restriction === 'hide'
            ? { paths: { hide: [path] } }
            : { commands: { deny: [{ reason: 'sealed', paths: [path] }] } },
        )
        await expect(core.read(path, fd, 1, 8)).rejects.toMatchObject({
          code: restriction === 'hide' ? 'ENOENT' : 'EACCES',
        })
        if (restriction === 'hide')
          await expect(core.fgetattr(path, fd)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(read).toHaveBeenCalledTimes(calls)
        await ws.setSessionProfile('chunk-reader', {})
        expect(await core.read(path, fd, 1, 8)).toEqual(new Uint8Array(8).fill(23))
        expect(read).toHaveBeenCalledTimes(calls)
      } finally {
        await core.release(fd)
        expect(core.handles.has(fd)).toBe(false)
        await ws.close()
      }
    },
  )
})

it('does not replace a hidden mount root with synthetic attributes', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() })
  const session = ws.createSession('reader', { profile: { paths: { hide: ['/data'] } } })
  const core = new MountCore(ws.vfs, { rootPrefix: '/data', session })
  try {
    await expect(core.getattr('/')).rejects.toMatchObject({ code: 'ENOENT' })
    await ws.setSessionProfile('reader', {})
    expect((await core.getattr('/')).mode & 0o170000).toBe(0o040000)
  } finally {
    await ws.close()
  }
})

it('judges the fetched row once when a buffered write sizes it', async () => {
  // The stat that fetched the row judged it; the size the handle's buffered
  // write adds is the handle's own, not a second stat.
  let stats = 0
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          preVfs: (ctx: VfsContext): Action | null => {
            if (ctx.call.name === 'stat') stats += 1
            return null
          },
        },
      ],
    },
  )
  try {
    await ws.vfs.write('/a.txt', new TextEncoder().encode('ab'))
    const core = new MountCore(ws.vfs)
    const fd = await core.open('/a.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/a.txt', fd, new TextEncoder().encode('longer'), 0)
    stats = 0
    expect((await core.fgetattr('/a.txt', fd)).size).toBe(6)
    expect(stats).toBe(1)
    await core.release(fd)
  } finally {
    await ws.close()
  }
})

/** A RAM mount whose next stat, once armed, answers the row it read only when the gate opens. */
class HeldStat extends RAMVFS {
  armed: Promise<void> | null = null
  entered: () => void = () => undefined

  override async stat(path: PathSpec): Promise<FileStat> {
    const row = await super.stat(path)
    const gate = this.armed
    this.armed = null
    if (gate !== null) {
      this.entered()
      await gate
    }
    return row
  }
}

it('keeps no row from a stat that was out across a change', async () => {
  const ram = new HeldStat()
  const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE })
  try {
    await ws.vfs.write('/a.txt', new TextEncoder().encode('abc'))
    const core = new MountCore(ws.vfs)
    const reader = await core.open('/a.txt', openMode(fsConstants.O_RDONLY, fsConstants))
    const writer = await core.open('/a.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    let open = (): void => undefined
    ram.armed = new Promise<void>((resolve) => {
      open = resolve
    })
    const entered = new Promise<void>((resolve) => {
      ram.entered = resolve
    })
    const late = core.fgetattr('/a.txt', reader)
    await entered
    await core.write('/a.txt', writer, new TextEncoder().encode('abcdef'), 0)
    await core.flush('/a.txt', writer)
    open()
    await late
    expect((await core.fstat(reader)).size).toBe(6)
    await core.release(writer)
    await core.release(reader)
  } finally {
    await ws.close()
  }
})

/** Holds the first batch of stats until the cap is full; its listing reads only readdir and getattr. */
class ListingCore extends MountCore {
  inFlight = 0
  peak = 0
  calls = 0
  private full: () => void = () => undefined
  private readonly started = new Promise<void>((resolve) => {
    this.full = resolve
  })

  constructor(
    files: Files,
    private readonly names: string[],
    private readonly refuse: string | null = null,
  ) {
    super(files)
  }

  override readdir(): Promise<string[]> {
    return Promise.resolve(['.', '..', ...this.names])
  }

  override async getattr(path: string): Promise<MountAttrs> {
    this.calls += 1
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      if (this.calls <= LISTING_CONCURRENCY) {
        if (this.inFlight === LISTING_CONCURRENCY) this.full()
        await this.started
      } else {
        await Promise.resolve()
      }
    } finally {
      this.inFlight -= 1
    }
    if (path.endsWith('gone')) throw Object.assign(new Error(path), { code: 'ENOENT' })
    if (this.refuse !== null && path.endsWith(this.refuse)) {
      throw Object.assign(new Error(path), { code: 'EACCES' })
    }
    return { size: path.length } as MountAttrs
  }
}

describe('MountCore listing', () => {
  it('stats entries together under the cap, leaving out one that vanished', async () => {
    // Each stat is, on an unindexed mount, a backend request: a wide
    // directory must not pay them one after another, nor put them all on
    // the wire at once.
    const ws = new Workspace({ '/': new RAMVFS() })
    try {
      const names = [...Array.from({ length: 40 }, (_, i) => `f${String(i)}`), 'gone']
      const core = new ListingCore(ws.vfs, names)
      const rows = await core.listing('/d')
      expect(rows.map(([name]) => name)).toEqual(['.', '..', ...names.slice(0, -1)])
      expect(rows[2]?.[1].size).toBe('/d/f0'.length)
      expect(core.peak).toBe(LISTING_CONCURRENCY)
    } finally {
      await ws.close()
    }
  })

  it('shares one cap between listings at once', async () => {
    const ws = new Workspace({ '/': new RAMVFS() })
    try {
      const core = new ListingCore(
        ws.vfs,
        Array.from({ length: 40 }, (_, i) => `f${String(i)}`),
      )
      await Promise.all([core.listing('/d'), core.listing('/d')])
      expect(core.peak).toBe(LISTING_CONCURRENCY)
    } finally {
      await ws.close()
    }
  })

  it('ends the listing at a refused stat without statting the rest', async () => {
    const ws = new Workspace({ '/': new RAMVFS() })
    try {
      const core = new ListingCore(
        ws.vfs,
        Array.from({ length: 100 }, (_, i) => `f${String(i)}`),
        '/d/f2',
      )
      await expect(core.listing('/d')).rejects.toMatchObject({ code: 'EACCES' })
      expect(core.inFlight).toBe(0)
      expect(core.calls).toBeLessThan(3 * LISTING_CONCURRENCY)
    } finally {
      await ws.close()
    }
  })
})

/** A RAM mount that counts the stats that reach it. */
class CountsStats extends RAMVFS {
  stats = 0

  override stat(path: PathSpec): Promise<FileStat> {
    this.stats += 1
    return super.stat(path)
  }
}

it('answers an fstat right after its open by the row the open fetched', async () => {
  // CPython stats a descriptor again right after opening it; the open's row
  // answers without a fetch, as a kernel's attr_timeout would, still judged
  // as a stat, where fgetattr fetches.
  let judged = 0
  const ram = new CountsStats()
  const ws = new Workspace(
    { '/': ram },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          preVfs: (ctx: VfsContext): Action | null => {
            if (ctx.call.name === 'stat') judged += 1
            return null
          },
        },
      ],
    },
  )
  try {
    await ws.vfs.write('/a.txt', new TextEncoder().encode('abc'))
    const core = new MountCore(ws.vfs)
    ram.stats = 0
    judged = 0
    const fd = await core.open('/a.txt', openMode(fsConstants.O_RDONLY, fsConstants))
    expect((await core.fstat(fd)).size).toBe(3)
    expect((await core.fstat(fd)).size).toBe(3)
    expect([ram.stats, judged]).toEqual([1, 3])
    expect((await core.fgetattr('/a.txt', fd)).size).toBe(3)
    expect(ram.stats).toBe(2)
    await core.release(fd)
  } finally {
    await ws.close()
  }
})

it('shows an fstat a change through the core at once, and one past it after a moment', async () => {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  const now = performance.now.bind(performance)
  try {
    await ws.vfs.write('/a.txt', new TextEncoder().encode('abc'))
    const core = new MountCore(ws.vfs)
    const reader = await core.open('/a.txt', openMode(fsConstants.O_RDONLY, fsConstants))
    const writer = await core.open('/a.txt', openMode(fsConstants.O_WRONLY, fsConstants))
    await core.write('/a.txt', writer, new TextEncoder().encode('abcdef'), 0)
    await core.flush('/a.txt', writer)
    expect((await core.fstat(reader)).size).toBe(6)
    const stamp = new Date('2001-02-03T04:05:06Z')
    await core.setattr('/a.txt', null, null, null, stamp, stamp)
    expect((await core.fstat(reader)).modified).toBe((await ws.vfs.stat('/a.txt')).modified)
    await ws.vfs.write('/a.txt', new TextEncoder().encode('x'))
    expect((await core.fstat(reader)).size).toBe(6)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 1000)
    expect((await core.fstat(reader)).size).toBe(1)
    await core.release(writer)
    await core.release(reader)
  } finally {
    vi.restoreAllMocks()
    await ws.close()
  }
})

it('judges a read that joins held bytes onto a fetch', async () => {
  // The fetch brings only what lies past the kept chunk and joins it on, so
  // postVfs must see the whole answer, the held prefix included.
  const judged: number[] = []
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          postVfs: (ctx) => {
            if (ctx.call.name === 'read' && ctx.result instanceof Uint8Array) {
              judged.push(ctx.result.byteLength)
            }
            return null
          },
        },
      ],
    },
  )
  try {
    await ws.vfs.write('/big.bin', new Uint8Array(2 * READ_CHUNK))
    const core = new MountCore(ws.vfs)
    const fd = await core.open('/big.bin', openMode(fsConstants.O_RDONLY, fsConstants))
    expect((await core.read('/big.bin', fd, 0, 8)).byteLength).toBe(8)
    judged.length = 0
    expect((await core.read('/big.bin', fd, 0, 2 * READ_CHUNK)).byteLength).toBe(2 * READ_CHUNK)
    expect(judged).toContain(2 * READ_CHUNK)
    await core.release(fd)
  } finally {
    await ws.close()
  }
})

/** A mount with no append of its own, as S3 has none. */
class NoAppendRAM extends RAMVFS {
  constructor() {
    super()
    Object.defineProperty(this, 'append', { value: Reflect.get(BaseVFS.prototype, 'append') })
  }
}

describe('MountCore opens', () => {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const flags = (bits: number): ReturnType<typeof openMode> => openMode(bits, fsConstants)

  it('lands two writers in the order they wrote', async () => {
    const core = await mkCore()
    const path = '/data/greeting.txt'
    const first = await core.open(path, flags(fsConstants.O_WRONLY | fsConstants.O_TRUNC))
    await core.write(path, first, enc.encode('0000'), 0)
    await core.release(first)
    const a = await core.open(path, flags(fsConstants.O_WRONLY))
    const b = await core.open(path, flags(fsConstants.O_WRONLY))
    await core.write(path, a, enc.encode('AAAA'), 0)
    await core.write(path, b, enc.encode('BB'), 0)
    await core.release(b)
    await core.release(a)
    expect(dec.decode(await core.read(path, -1, 0, 100))).toBe('BBAA')
  })

  it.each([
    [
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      '/data/greeting.txt',
      'EEXIST',
    ],
    [fsConstants.O_RDONLY, '/data/missing', 'ENOENT'],
    [fsConstants.O_WRONLY, '/data/sub', 'EISDIR'],
    [fsConstants.O_RDONLY, '/data/greeting.txt/', 'ENOTDIR'],
  ])('refuses an open as POSIX does (%i %s)', async (bits, path, code) => {
    const core = await mkCore()
    await expect(core.open(path, flags(bits))).rejects.toMatchObject({ code })
  })

  it('creates the file an open asks for, with its mode', async () => {
    const core = await mkCore()
    const fh = await core.open(
      '/data/new.txt',
      flags(fsConstants.O_WRONLY | fsConstants.O_CREAT),
      0o600,
    )
    await core.write('/data/new.txt', fh, enc.encode('made'), 0)
    await core.release(fh)
    const attrs = await core.getattr('/data/new.txt')
    expect([attrs.mode & 0o777, attrs.size]).toEqual([0o600, 4])
  })

  it('opens a directory for a read', async () => {
    const core = await mkCore()
    await expect(core.open('/data/sub')).rejects.toMatchObject({ code: 'EISDIR' })
    const fh = await core.open('/data/sub', { ...flags(fsConstants.O_RDONLY), directory: true })
    expect((await core.fgetattr('/data/sub', fh)).mode & fsConstants.S_IFMT).toBe(
      fsConstants.S_IFDIR,
    )
    await core.release(fh)
  })

  it('admits a writable open against the write rules before its first write', async () => {
    const vfs = new RAMVFS()
    const seed = new Workspace({ '/data/': vfs }, { mode: MountMode.WRITE })
    await seed.vfs.write('/data/a.txt', 'seed')
    const core = new MountCore(new Workspace({ '/data/': vfs }, { mode: MountMode.READ }).vfs)
    await expect(core.open('/data/a.txt', flags(fsConstants.O_WRONLY))).rejects.toMatchObject({
      code: 'EROFS',
    })
    const fh = await core.open('/data/a.txt')
    expect(dec.decode(await core.read('/data/a.txt', fh, 0, 100))).toBe('seed')
    await core.release(fh)
  })

  it('refuses the access a handle did not open for', async () => {
    const core = await mkCore()
    const path = '/data/greeting.txt'
    const reader = await core.open(path)
    const writer = await core.open(path, flags(fsConstants.O_WRONLY))
    await expect(core.write(path, reader, enc.encode('x'), 0)).rejects.toMatchObject({
      code: 'EBADF',
    })
    await expect(core.read(path, writer, 0, 1)).rejects.toMatchObject({ code: 'EBADF' })
    await core.release(reader)
    await core.release(writer)
  })

  it('reads the stored bytes through a writer and the rendering through a reader', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    render(ws.mount('/data/').vfs, '.tally', () => Promise.resolve(enc.encode('rendered')))
    await ws.vfs.write('/data/books.tally', '0123456789')
    const core = new MountCore(ws.vfs)
    const reader = await core.open('/data/books.tally')
    const writer = await core.open('/data/books.tally', flags(fsConstants.O_RDWR))
    expect(dec.decode(await core.read('/data/books.tally', reader, 0, 100))).toBe('rendered')
    expect(dec.decode(await core.read('/data/books.tally', writer, 0, 100))).toBe('0123456789')
    await core.release(reader)
    await core.release(writer)
  })

  it.each([
    ['native', () => new RAMVFS()],
    ['emulated', () => new NoAppendRAM()],
  ])('lands an appending handle after what others appended (%s)', async (_kind, make) => {
    const ws = new Workspace({ '/data/': make() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/log', 'one\n')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/log', flags(fsConstants.O_RDWR | fsConstants.O_APPEND))
    await core.write('/data/log', fh, enc.encode('two\n'), 0)
    expect(dec.decode(await core.read('/data/log', fh, 0, 100))).toBe('one\ntwo\n')
    await ws.vfs.append('/data/log', enc.encode('other\n'))
    await core.write('/data/log', fh, enc.encode('three\n'), 0)
    await core.release(fh)
    expect(dec.decode(await ws.vfs.read('/data/log'))).toBe('one\nother\ntwo\nthree\n')
  })

  it('appends past what its own landed writes added', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/log', 'abc')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/log', flags(fsConstants.O_RDWR | fsConstants.O_APPEND))
    await core.write('/data/log', fh, enc.encode('D'), 0)
    await core.flush('/data/log', fh)
    await core.write('/data/log', fh, enc.encode('E'), 0)
    expect(dec.decode(await core.read('/data/log', fh, 0, 100))).toBe('abcDE')
    expect((await core.fstat(fh)).size).toBe(5)
    await core.release(fh)
    expect(dec.decode(await ws.vfs.read('/data/log'))).toBe('abcDE')
  })

  it('keeps the file an open through a link reached when the link is replaced', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/a', 'aaaa')
    await ws.vfs.write('/data/b', 'bbbb')
    await ws.shell('ln -s a /data/lk')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/lk', flags(fsConstants.O_RDWR))
    await core.unlink('/data/lk')
    await ws.shell('ln -s b /data/lk')
    await core.write('/data/lk', fh, enc.encode('A'), 0)
    expect(dec.decode(await core.read('/data/lk', fh, 0, 100))).toBe('Aaaa')
    await core.release(fh)
    expect(dec.decode(await ws.vfs.read('/data/a'))).toBe('Aaaa')
    expect(dec.decode(await ws.vfs.read('/data/b'))).toBe('bbbb')
  })

  it('carries a handle along a rename through a link the rename moves', async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('mkdir -p /data/src /data/other && printf hello > /data/src/f')
    await ws.shell('ln -s /data/other /data/src/out')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/src/f', flags(fsConstants.O_RDWR))
    await core.rename('/data/src', '/data/src/out/moved')
    await core.write('/data/src/f', fh, enc.encode('X'), 0)
    await core.release(fh)
    expect(dec.decode(await ws.vfs.read('/data/other/moved/f'))).toBe('Xello')
  })

  it("reads a range of a file without a handle, another's writes laid over it", async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f', 'ABCDEFGH')
    const core = new MountCore(ws.vfs)
    const fh = await core.open('/data/f', flags(fsConstants.O_RDWR))
    await core.write('/data/f', fh, enc.encode('xy'), 0)
    expect(dec.decode(await core.read('/data/f', -1, 0, 3))).toBe('xyC')
    expect(dec.decode(await core.read('/data/f', -1, 3, 2))).toBe('DE')
    expect(dec.decode(await core.read('/data/f', -1, 6, 10))).toBe('GH')
    expect(dec.decode(await core.read('/data/f', -1, 9, 10))).toBe('')
    await core.release(fh)
  })

  it("folds a stream of writes into one run, another handle's write cut out of it", async () => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f', '')
    const core = new MountCore(ws.vfs)
    const a = await core.open('/data/f', flags(fsConstants.O_RDWR))
    const b = await core.open('/data/f', flags(fsConstants.O_RDWR))
    for (let i = 0; i < 200; i += 1) await core.write('/data/f', a, enc.encode('a'), i)
    expect(core.handles.get(a)?.writeBuf?.length).toBe(1)
    await core.write('/data/f', a, enc.encode('X'), 1)
    await core.write('/data/f', b, enc.encode('Z'), 2)
    await core.write('/data/f', a, enc.encode('cc'), 200)
    const written = `aXZ${'a'.repeat(197)}cc`
    expect(dec.decode(await core.read('/data/f', a, 0, 300))).toBe(written)
    await core.release(a)
    await core.release(b)
    expect(dec.decode(await ws.vfs.read('/data/f'))).toBe(written)
  })

  it('shares what an unlinked file holds among its handles', async () => {
    const core = await mkCore()
    const path = '/data/greeting.txt'
    const reader = await core.open(path)
    const writer = await core.open(path, flags(fsConstants.O_RDWR))
    await core.unlink(path)
    await core.write(path, writer, enc.encode('HELLO'), 0)
    await core.flush(path, writer)
    expect(dec.decode(await core.read(path, reader, 0, 100))).toBe('HELLO world\n')
    await core.ftruncate(writer, 5)
    expect(dec.decode(await core.read(path, reader, 0, 100))).toBe('HELLO')
    expect((await core.fstat(reader)).size).toBe(5)
    const fresh = await core.open(path, flags(fsConstants.O_RDWR | fsConstants.O_CREAT))
    expect(await core.read(path, fresh, 0, 100)).toEqual(new Uint8Array())
    for (const fh of [reader, writer, fresh]) await core.release(fh)
  })

  it('counts in fstat what a handle wrote and has not landed', async () => {
    const core = await mkCore()
    const path = '/data/greeting.txt'
    const fh = await core.open(path, flags(fsConstants.O_WRONLY))
    await core.write(path, fh, enc.encode('!'), 20)
    const row = await core.fstat(fh)
    expect([row.size, row.type]).toEqual([21, FileType.FILE])
    expect((await core.getattr(path)).size).toBe(21)
    expect((await core.files.read(path)).length).toBe(12)
    await core.ftruncate(fh, 3)
    expect((await core.fstat(fh)).size).toBe(3)
    await core.release(fh)
    expect(dec.decode(await core.read(path, -1, 0, 100))).toBe('hel')
    await expect(core.fstat(fh)).rejects.toMatchObject({ code: 'EBADF' })
  })
})

/** A store with no pwrite, as S3, that keeps which kind of body each write came with. */
class StreamedRAM extends RAMVFS {
  bodies: string[] = []

  constructor() {
    super()
    Object.defineProperty(this, 'pwrite', { value: Reflect.get(BaseVFS.prototype, 'pwrite') })
  }

  override write(
    path: PathSpec,
    data: ByteSource,
    signal?: AbortSignal,
    handed?: Handed,
    atomic = false,
  ): Promise<void> {
    this.bodies.push(data instanceof Uint8Array ? 'bytes' : 'stream')
    return super.write(path, data, signal, handed, atomic)
  }
}

describe('MountCore past the memory limit', () => {
  const BLOCK = Uint8Array.from({ length: 65536 }, (_, i) => i % 256)
  const repeat = (count: number): Uint8Array => {
    const out = new Uint8Array(BLOCK.byteLength * count)
    for (let i = 0; i < count; i++) out.set(BLOCK, i * BLOCK.byteLength)
    return out
  }
  const streamed = (): { core: MountCore; store: StreamedRAM } => {
    const store = new StreamedRAM()
    const ws = new Workspace({ '/data/': store }, { mode: MountMode.WRITE })
    return { core: new MountCore(ws.vfs), store }
  }
  const flags = (value: number) => openMode(value, fsConstants)
  const enc = new TextEncoder()
  const MiB = 1024 * 1024

  it('keeps the writes in a spool and lands them as one streamed write', async () => {
    const { core, store } = streamed()
    const fh = await core.open(
      '/data/f',
      flags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC),
    )
    for (let i = 0; i < 48; i++) await core.write('/data/f', fh, BLOCK, i * BLOCK.byteLength)
    await core.write('/data/f', fh, enc.encode('HEAD'), 0)
    const ctx = core.handles.get(fh)
    const writes = ctx?.writeBuf ?? []
    let held = 0
    for (const [, run] of writes) if (run instanceof Uint8Array) held += run.byteLength
    expect(writes[0]?.[1]).toBeInstanceOf(ByteSlice)
    expect(held).toBeLessThanOrEqual(MEMORY_LIMIT)
    const reader = await core.open('/data/f', flags(fsConstants.O_RDONLY))
    expect(await core.read('/data/f', reader, 2 * MiB, 8)).toEqual(BLOCK.subarray(0, 8))
    expect(await core.read('/data/f', reader, 0, 6)).toEqual(
      new Uint8Array([...enc.encode('HEAD'), ...BLOCK.subarray(4, 6)]),
    )
    store.bodies.length = 0
    await core.release(fh)
    expect(store.bodies).toEqual(['stream'])
    expect(ctx?.spool).toBeUndefined()
    const want = repeat(48)
    want.set(enc.encode('HEAD'), 0)
    expect(store.store.files.get('/f')).toEqual(want)
  })

  it('keeps the tail of a longer file a spooled write lands in', async () => {
    const { core, store } = streamed()
    store.store.files.set('/f', new Uint8Array(4 * MiB).fill(97))
    const fh = await core.open('/data/f', flags(fsConstants.O_WRONLY))
    for (let i = 0; i < 32; i++) await core.write('/data/f', fh, BLOCK, i * BLOCK.byteLength)
    await core.release(fh)
    const want = new Uint8Array(4 * MiB).fill(97)
    want.set(repeat(32), 0)
    expect(store.store.files.get('/f')).toEqual(want)
  })

  it("lands an appending handle's spooled writes at the end", async () => {
    const { core, store } = streamed()
    store.store.files.set('/f', enc.encode('head'))
    const fh = await core.open('/data/f', flags(fsConstants.O_WRONLY | fsConstants.O_APPEND))
    for (let i = 0; i < 24; i++) await core.write('/data/f', fh, BLOCK, 0)
    await core.release(fh)
    expect(store.store.files.get('/f')).toEqual(
      new Uint8Array([...enc.encode('head'), ...repeat(24)]),
    )
  })

  it('keeps the spooled writes of a landing that fails for the retry', async () => {
    const { core, store } = streamed()
    const fh = await core.open('/data/f', flags(fsConstants.O_WRONLY | fsConstants.O_CREAT))
    for (let i = 0; i < 24; i++) await core.write('/data/f', fh, BLOCK, i * BLOCK.byteLength)
    vi.spyOn(store, 'write').mockRejectedValueOnce(unnamedFsError('EACCES', 'denied'))
    await expect(core.flush('/data/f', fh)).rejects.toMatchObject({ code: 'EACCES' })
    await core.release(fh)
    expect(store.store.files.get('/f')).toEqual(repeat(24))
  })

  it('cuts what one handle holds in its spool where another writes', async () => {
    const { core, store } = streamed()
    const first = await core.open(
      '/data/f',
      flags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC),
    )
    for (let i = 0; i < 24; i++) await core.write('/data/f', first, BLOCK, i * BLOCK.byteLength)
    const second = await core.open('/data/f', flags(fsConstants.O_WRONLY))
    await core.write('/data/f', second, enc.encode('SECOND'), MiB)
    await core.release(second)
    await core.release(first)
    const want = repeat(24)
    want.set(enc.encode('SECOND'), MiB)
    expect(store.store.files.get('/f')).toEqual(want)
  })
})

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

import { existsSync, mkdtempSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getCurrentSession } from '@struktoai/mirage-core/context/session_context'
import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import { describe, expect, it } from 'vitest'
import { EINVAL, ENOENT } from '../mount/errors.ts'
import { ESTALE_WIRE, RenameIntoSelfError, StaleHandleError } from './errors.ts'
import {
  ADDON_ENV,
  ADDON_PACKAGE,
  awaitIsMount,
  buildDelegate,
  isMountPoint,
  lastResortArgs,
  loadAddon,
  mountArgs,
  mountOptions,
  prepareMountpoint,
  runUmount,
  umountArgs,
} from './mount.ts'
import { NFSConfig } from './config.ts'
import type { BoundedRunner, NFSDelegateTarget } from './mount.ts'
import type { DirEntry, NFSAttrs } from './types.ts'

const ATTRS: NFSAttrs = { fileid: 7, size: 3, isDir: false, isSymlink: false }

function target(overrides: Partial<NFSDelegateTarget> = {}): NFSDelegateTarget {
  return {
    lookup: () => Promise.resolve(7),
    getattr: () => Promise.resolve(ATTRS),
    read: () => Promise.resolve(Buffer.from('abc')),
    write: () => Promise.resolve(ATTRS),
    create: () => Promise.resolve(7),
    createExclusive: () => Promise.resolve(7),
    mkdir: () => Promise.resolve(7),
    remove: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    setSize: () => Promise.resolve(ATTRS),
    symlink: () => Promise.resolve(7),
    readlink: () => Promise.resolve('target.txt'),
    readdir: () => Promise.resolve([]),
    flushIdle: () => Promise.resolve(),
    ...overrides,
  }
}

describe('mountArgs', () => {
  it('takes the source host from the config', () => {
    // The server binds to config.host, so a config naming another
    // loopback alias would otherwise be mounted from an address
    // nothing is listening on.
    const argv = mountArgs('/tmp/m', 20490, '/docs', new NFSConfig({ host: '127.0.0.2' }), 'darwin')

    expect(argv).toContain('127.0.0.2:/docs')
    expect(argv).not.toContain('127.0.0.1:/docs')
  })

  it('defaults to loopback', () => {
    const argv = mountArgs('/tmp/m', 20490, '/docs', new NFSConfig(), 'darwin')

    expect(argv).toContain('127.0.0.1:/docs')
  })

  it('pins port, mountport and actimeo on darwin', () => {
    const argv = mountArgs('/tmp/m', 20490, '/docs', new NFSConfig(), 'darwin')
    expect(argv[0]).toBe('mount_nfs')
    const joined = argv.join(' ')
    expect(joined).toContain('port=20490')
    expect(joined).toContain('mountport=20490')
    expect(joined).toContain('actimeo=0')
    expect(argv.at(-2)).toBe('127.0.0.1:/docs')
    expect(argv.at(-1)).toBe('/tmp/m')
  })

  it('uses mount -t nfs on linux', () => {
    const argv = mountArgs('/tmp/m', 111, '/', new NFSConfig(), 'linux')
    expect(argv.slice(0, 3)).toEqual(['mount', '-t', 'nfs'])
    // linux spells the no-lock option without the trailing s
    expect(argv.join(' ')).toContain('nolock,')
    expect(argv.at(-2)).toBe('127.0.0.1:/')
  })

  it('carries the config options', () => {
    const argv = mountArgs('/tmp/m', 20490, '/', new NFSConfig({ timeo: 11 }), 'darwin')
    expect(argv[2]).toContain('timeo=11')
  })
})

describe('mountOptions', () => {
  it('carries the whole escape hatch on darwin', () => {
    const parts = mountOptions(20490, new NFSConfig(), 'darwin').split(',')
    expect(parts).toContain('soft')
    expect(parts).toContain('intr')
    expect(parts).toContain('timeo=50')
    expect(parts).toContain('retrans=3')
    expect(parts).toContain('deadtimeout=60')
  })

  it('omits intr on linux', () => {
    // Linux has ignored intr since 2.6.25; soft is the whole answer
    // there, and an option the kernel drops is noise in the argv.
    const parts = mountOptions(20490, new NFSConfig(), 'linux').split(',')
    expect(parts).toContain('soft')
    expect(parts).toContain('timeo=50')
    expect(parts).not.toContain('intr')
    expect(parts.some((part) => part.startsWith('deadtimeout='))).toBe(false)
  })

  it('honors a hard mount choice', () => {
    const config = new NFSConfig({ soft: false, deadTimeout: 0, timeo: 17, retrans: 9 })
    const parts = mountOptions(20490, config, 'darwin').split(',')
    expect(parts).not.toContain('soft')
    expect(parts.some((part) => part.startsWith('deadtimeout='))).toBe(false)
    expect(parts).toContain('timeo=17')
    expect(parts).toContain('retrans=9')
    // intr survives a hard mount on purpose: it is what makes the
    // blocked I/O killable, which is the only escape a hard mount has.
    expect(parts).toContain('intr')
  })
})

describe('umountArgs', () => {
  it('is plain umount on every platform', () => {
    expect(umountArgs('/tmp/m', false, 'linux')).toEqual(['umount', '/tmp/m'])
    expect(umountArgs('/tmp/m', false, 'darwin')).toEqual(['umount', '/tmp/m'])
  })

  it('forces with -f, which is the nfs escape', () => {
    expect(umountArgs('/tmp/m', true)).toEqual(['umount', '-f', '/tmp/m'])
  })
})

describe('lastResortArgs', () => {
  it('is lazy on linux and diskutil on darwin', () => {
    // macOS umount takes only -fv, so a lazy detach is not expressible
    // there; linux has no diskutil.
    expect(lastResortArgs('/tmp/m', 'linux')).toEqual(['umount', '-l', '/tmp/m'])
    expect(lastResortArgs('/tmp/m', 'darwin')).toEqual(['diskutil', 'unmount', 'force', '/tmp/m'])
  })
})

describe('runUmount', () => {
  it('walks every rung, then gives up', async () => {
    const calls: string[][] = []
    const refuse: BoundedRunner = (program, argv) => {
      calls.push([program, ...argv])
      return Promise.resolve(1)
    }
    await runUmount('/tmp/m', 1, refuse, 0)
    expect(calls.slice(0, 3)).toEqual([
      ['umount', '/tmp/m'],
      ['umount', '/tmp/m'],
      ['umount', '-f', '/tmp/m'],
    ])
    expect(calls[3]).toEqual(lastResortArgs('/tmp/m'))
  })

  it('retries a busy target before forcing', async () => {
    // EBUSY is usually a child that has not finished exiting, so the
    // same plain unmount answers a moment later.
    const calls: string[][] = []
    const codes = [1, 0]
    const busyThenFree: BoundedRunner = (program, argv) => {
      calls.push([program, ...argv])
      return Promise.resolve(codes.shift() ?? 1)
    }
    await runUmount('/tmp/m', 1, busyThenFree, 0)
    expect(calls).toEqual([
      ['umount', '/tmp/m'],
      ['umount', '/tmp/m'],
    ])
  })

  it('skips the retry when the first attempt hung', async () => {
    // A timeout is a wedged mount, not a busy one: repeating the plain
    // unmount would only spend the same wait again.
    const calls: string[][] = []
    const hangThenRefuse: BoundedRunner = (program, argv) => {
      calls.push([program, ...argv])
      return Promise.resolve(calls.length === 1 ? null : 1)
    }
    await runUmount('/tmp/m', 1, hangThenRefuse, 0)
    expect(calls.slice(0, 2)).toEqual([
      ['umount', '/tmp/m'],
      ['umount', '-f', '/tmp/m'],
    ])
    expect(calls[2]).toEqual(lastResortArgs('/tmp/m'))
  })

  it('stops at the first success', async () => {
    const calls: string[][] = []
    const accept: BoundedRunner = (program, argv) => {
      calls.push([program, ...argv])
      return Promise.resolve(0)
    }
    await runUmount('/tmp/m', 1, accept, 0)
    expect(calls).toEqual([['umount', '/tmp/m']])
  })
})

describe('prepareMountpoint', () => {
  it('creates and owns a temporary directory when unnamed', () => {
    const [path, owns] = prepareMountpoint()
    try {
      expect(owns).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    } finally {
      rmdirSync(path)
    }
  })

  it('keeps ownership with the caller for a named path', () => {
    const base = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    const wanted = join(base, 'mnt')
    try {
      const [path, owns] = prepareMountpoint(wanted)
      expect(path).toBe(wanted)
      expect(owns).toBe(false)
      expect(statSync(wanted).isDirectory()).toBe(true)
    } finally {
      rmdirSync(wanted)
      rmdirSync(base)
    }
  })
})

describe('awaitIsMount', () => {
  it('fails loudly when a probe never answers, not only when it answers false', async () => {
    // The stat of a mount whose server has stopped never resolves, so a
    // deadline checked only between probes is a deadline that never
    // fires. This is the regression that hung the battery.
    const never = () => new Promise<boolean>(() => undefined)
    await expect(awaitIsMount('/tmp/wedged', 0.2, never, 0.05)).rejects.toThrow(/wedged/)
  })

  it('fails loudly, naming the mountpoint, when no mount appears', async () => {
    await expect(awaitIsMount('/tmp/never', 0.05, () => Promise.resolve(false))).rejects.toThrow(
      '/tmp/never',
    )
  })

  it('returns as soon as the probe passes', async () => {
    await expect(awaitIsMount('/tmp/now', 1, () => Promise.resolve(true))).resolves.toBeUndefined()
  })

  it('reads an ordinary directory as not a mount', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    try {
      expect(await isMountPoint(dir)).toBe(false)
    } finally {
      rmdirSync(dir)
    }
  })

  it('never reads a symlink as a mount', async () => {
    // CPython's rule: a symlink can never be a mount point, and
    // following it would report the target's boundary as this path's.
    const base = mkdtempSync(join(tmpdir(), 'mirage-nfs-test-'))
    const link = join(base, 'link')
    symlinkSync(base, link)
    try {
      expect(await isMountPoint(link)).toBe(false)
    } finally {
      unlinkSync(link)
      rmdirSync(base)
    }
  })

  it('reads a filesystem root as a mount', async () => {
    // The other half of the rule: / shares its inode with /.., which is
    // how a root is told from an ordinary directory.
    expect(await isMountPoint('/')).toBe(true)
  })
})

describe('buildDelegate', () => {
  it('answers an id reply for lookup', async () => {
    const d = buildDelegate(target())
    expect(await d.lookup({ dirId: 1, name: 'a.txt' })).toEqual({ fileid: 7 })
  })

  it('classifies a backend failure onto an errno reply', async () => {
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const d = buildDelegate(
      target({
        lookup: () => Promise.reject(missing),
      }),
    )
    expect(await d.lookup({ dirId: 1, name: 'gone' })).toEqual({ errno: ENOENT })
  })

  it('answers a stale id with the wire table ESTALE, not the host errno', async () => {
    // bridge.rs maps 70 onto NFS3ERR_STALE; ESTALE is 116 on linux, so the
    // number has to come from the addon's table rather than node:os.
    const d = buildDelegate(
      target({
        getattr: () => Promise.reject(new StaleHandleError('unknown file id: 9')),
      }),
    )
    expect(ESTALE_WIRE).toBe(70)
    expect(await d.getattr({ id: 9 })).toMatchObject({ errno: ESTALE_WIRE })
  })

  it('carries every required attrs field on a failed attrs reply', async () => {
    // Attrs is a napi object whose fileid/size/isDir/isSymlink are NOT
    // Option, so a bare { errno } fails to deserialize on the rust side and
    // the client sees SERVERFAULT instead of the real condition.
    const d = buildDelegate(
      target({
        getattr: () => Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
      }),
    )
    expect(await d.getattr({ id: 9 })).toEqual({
      errno: ENOENT,
      fileid: 9,
      size: 0,
      isDir: false,
      isSymlink: false,
    })
  })

  it('refuses a rename into its own subtree with EINVAL', async () => {
    const d = buildDelegate(
      target({
        rename: () =>
          Promise.reject(new RenameIntoSelfError('cannot rename /d into its own subtree /d/x')),
      }),
    )
    expect(await d.rename({ fromDirId: 1, fromName: 'd', toDirId: 2, toName: 'x' })).toEqual({
      errno: EINVAL,
    })
  })

  it('answers read with the bytes and write with attrs', async () => {
    const seen: { offset: number; data: Buffer }[] = []
    const d = buildDelegate(
      target({
        read: (_id, offset, count) =>
          Promise.resolve(Buffer.from('x'.repeat(count) + String(offset))),
        write: (_id, offset, data) => {
          seen.push({ offset, data })
          return Promise.resolve(ATTRS)
        },
      }),
    )
    expect(await d.read({ id: 7, offset: 2, count: 3 })).toEqual({ data: Buffer.from('xxx2') })
    expect(await d.write({ id: 7, offset: 4, data: Buffer.from('hi') })).toEqual(ATTRS)
    expect(seen).toEqual([{ offset: 4, data: Buffer.from('hi') }])
  })

  it('passes an absent setattr size through as null', async () => {
    const sizes: (number | null)[] = []
    const d = buildDelegate(
      target({
        setSize: (_id, size) => {
          sizes.push(size)
          return Promise.resolve(ATTRS)
        },
      }),
    )
    await d.setSize({ id: 7, size: 12 })
    await d.setSize({ id: 7 })
    await d.setSize({ id: 7, size: null })
    expect(sizes).toEqual([12, null, null])
  })

  it('drops the cookie from a listing entry, which rides inside attrs', async () => {
    // DirEntryOut is { name, attrs } — vfs.rs reads the id off attrs.fileid,
    // so a per-entry fileid/cookie field would be silently ignored.
    const entries: DirEntry[] = [
      { name: 'a.txt', fileid: 7, cookie: 7, attrs: ATTRS },
      { name: 'b', fileid: 8, cookie: 8, attrs: { ...ATTRS, fileid: 8, isDir: true, size: 0 } },
    ]
    const d = buildDelegate(target({ readdir: () => Promise.resolve(entries) }))
    expect(await d.readdir({ dirId: 1, startAfter: 0, maxEntries: 10 })).toEqual({
      entries: [
        { name: 'a.txt', attrs: ATTRS },
        { name: 'b', attrs: { ...ATTRS, fileid: 8, isDir: true, size: 0 } },
      ],
    })
  })

  it('resumes a listing after the cookie the client returned', async () => {
    const asked: [number, number, number][] = []
    const d = buildDelegate(
      target({
        readdir: (dirid, cookie, maxEntries) => {
          asked.push([dirid, cookie, maxEntries])
          return Promise.resolve([])
        },
      }),
    )
    await d.readdir({ dirId: 3, startAfter: 42, maxEntries: 5 })
    expect(asked).toEqual([[3, 42, 5]])
  })

  it('answers readlink with text and remove/flushIdle with a unit reply', async () => {
    const d = buildDelegate(target())
    expect(await d.readlink({ id: 7 })).toEqual({ text: 'target.txt' })
    expect(await d.remove({ dirId: 1, name: 'a.txt' })).toEqual({})
    expect(await d.flushIdle({ id: 0 })).toEqual({})
  })

  it('never lets an idle-flush failure escape to the addon', async () => {
    const d = buildDelegate(
      target({
        flushIdle: () => Promise.reject(new Error('backend down')),
      }),
    )
    expect(await d.flushIdle({ id: 0 })).toEqual({ errno: 5 })
  })
})

describe('loadAddon', () => {
  it('names the addon and the override when it cannot be loaded', () => {
    expect(ADDON_ENV).toBe('MIRAGE_NFS_ADDON')
    const previous = process.env.MIRAGE_NFS_ADDON
    process.env.MIRAGE_NFS_ADDON = '/nonexistent/mirage_nfs_node.node'
    try {
      expect(() => loadAddon()).toThrow(ADDON_PACKAGE)
      expect(() => loadAddon()).toThrow(ADDON_ENV)
    } finally {
      if (previous === undefined) delete process.env.MIRAGE_NFS_ADDON
      else process.env.MIRAGE_NFS_ADDON = previous
    }
  })

  it('loads a locally built addon named by the override', () => {
    // The addon is not published yet, so this covers the path only on a
    // machine that has built it (integ points the same variable at it).
    const built = fileURLToPath(
      new URL('../../../mirage-nfs/mirage_nfs_node.node', import.meta.url),
    )
    if (!existsSync(built)) return
    const previous = process.env.MIRAGE_NFS_ADDON
    process.env.MIRAGE_NFS_ADDON = built
    try {
      expect(typeof loadAddon().start).toBe('function')
    } finally {
      if (previous === undefined) delete process.env.MIRAGE_NFS_ADDON
      else process.env.MIRAGE_NFS_ADDON = previous
    }
  })
})

describe('buildDelegate session binding', () => {
  it('lands every call on the ops facade with the session in force', async () => {
    // Not "the wrapper sets a store" -- that a call arriving from the
    // kernel reaches the adapter under the session, which is what makes
    // the grants apply.
    const seen: (Session | null)[] = []
    const session = { sessionId: 'agent' } as unknown as Session
    const delegate = buildDelegate(
      target({
        lookup: () => {
          seen.push(getCurrentSession())
          return Promise.resolve(7)
        },
      }),
      session,
    )

    await delegate.lookup({ dirId: 1, name: 'a.txt' })
    expect(seen).toEqual([session])
  })

  it('leaves the delegate unbound when no session is given', async () => {
    const seen: (Session | null)[] = []
    const delegate = buildDelegate(
      target({
        lookup: () => {
          seen.push(getCurrentSession())
          return Promise.resolve(7)
        },
      }),
    )

    await delegate.lookup({ dirId: 1, name: 'a.txt' })
    expect(seen).toEqual([null])
  })

  it('still answers the reply through the wrap', async () => {
    // runWithSession returns the promise, unlike the FUSE callback
    // table's void wrap; a delegate that swallowed it would answer
    // every op with undefined.
    const session = { sessionId: 'agent' } as unknown as Session
    const delegate = buildDelegate(target(), session)
    await expect(delegate.lookup({ dirId: 1, name: 'a.txt' })).resolves.toEqual({ fileid: 7 })
  })
})

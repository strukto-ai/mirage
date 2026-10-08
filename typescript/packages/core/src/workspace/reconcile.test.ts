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
import { GitHubAccessor } from '../accessor/github.ts'
import { read as githubRead } from '../core/github/read.ts'
import { stat as githubStat } from '../core/github/stat.ts'
import { IndexEntry } from '../cache/index/config.ts'
import { LISTING_TRUST_WINDOW } from '../cache/index/constants.ts'
import { shiftPerformanceNow } from '../cache/_test_util.ts'
import { ListingCheckStore, RAMIndexCacheStore } from '../cache/index/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import {
  type ReadSpec,
  DEFAULT_READ_TTL,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  ReadPolicy,
} from '../types.ts'
import type { MountEntry } from './mount/mount.ts'

const ENC = new TextEncoder()
import { enotsup } from '../errors/fs.ts'
import { Reconciler } from './reconcile.ts'
import { runInCommandScope } from '../cache/index/scope.ts'
import { ops } from '../test-utils.ts'
import { Workspace } from './workspace/workspace.ts'
import { VersionedVFS, versionedWorkspace } from './fixtures/versioned_vfs.ts'

function enoent(path: string): Error {
  return Object.assign(new Error(path), { code: 'ENOENT' })
}

function mountOf(ws: Workspace, path: string): MountEntry {
  return ws.namespace.mountFor(path)
}

// MountEntry.read is constructor-set. These are unit tests of the
// Reconciler itself -- they build it directly rather than going through a
// workspace -- so they pin the policy under test on the mount. The verdict
// that would refuse a RAM mount `fresh` runs at the workspace door, which
// this path bypasses.
function withFresh(mount: MountEntry): MountEntry {
  ;(mount as { read: ReadSpec }).read = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
  return mount
}

async function wsWithOverlay(): Promise<Workspace> {
  const ws = new Workspace({ '/data': new RAMVFS() })
  await ws.namespace.ensureLoaded()
  await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
  return ws
}

describe('Reconciler', () => {
  it('onGone for a file evicts its bytes and overlay', async () => {
    const ws = await wsWithOverlay()
    await ws.cache.set('/data/f.txt', ENC.encode('v1'))
    await ws.cache.set('/data/f.txt.bak', ENC.encode('keep'))
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.onGone([{ path: '/data/f.txt', folder: false }])
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    expect(await ws.cache.exists('/data/f.txt')).toBe(false)
    expect(await ws.cache.exists('/data/f.txt.bak')).toBe(true)
    await ws.close()
  })

  it('onGone for a folder takes its subtree but not links', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/sub', { mode: 0o700 })
    await ws.namespace.setAttrs('/data/sub/x', { mode: 0o600 })
    await ws.namespace.setAttrs('/data/sub2/x', { mode: 0o600 })
    await ws.namespace.symlink('/data/sub/link', '/data/t', 1)
    await ws.cache.set('/data/sub/x', ENC.encode('x'))
    await ws.cache.set('/data/sub2/x', ENC.encode('keep'))
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.onGone([{ path: '/data/sub', folder: true }])
    expect(ws.namespace.metaFor('/data/sub')).toBeNull()
    expect(ws.namespace.metaFor('/data/sub/x')).toBeNull()
    expect(ws.namespace.readlink('/data/sub/link')).toBe('/data/t')
    expect(ws.namespace.metaFor('/data/sub2/x')).not.toBeNull()
    expect(await ws.cache.exists('/data/sub/x')).toBe(false)
    expect(await ws.cache.exists('/data/sub2/x')).toBe(true)
    await ws.close()
  })

  it('onOpMissing GCs an orphaned overlay on a fresh mount + stat + ENOENT', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace)
    const mount = withFresh(mountOf(ws, '/data/f.txt'))
    await rec.onOpMissing(mount, 'stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
  })

  it('onOpMissing keeps an authoritative symlink', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.symlink('/data/link', '/data/t', 1)
    const rec = new Reconciler(ws.cache, ws.namespace)
    const mount = withFresh(mountOf(ws, '/data/link'))
    await rec.onOpMissing(mount, 'stat', '/data/link', enoent('/data/link'))
    expect(ws.namespace.readlink('/data/link')).toBe('/data/t')
    await ws.close()
  })

  // A mount that declined to revalidate also declines to GC on a miss:
  // an ENOENT here is not proof the backend said so, because several
  // backends answer a miss out of a live index.
  it('onOpMissing skips under bounded', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace)
    const mount = mountOf(ws, '/data/f.txt')
    await rec.onOpMissing(mount, 'stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing skips a non-revalidate op', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace)
    const mount = withFresh(mountOf(ws, '/data/f.txt'))
    await rec.onOpMissing(mount, 'write', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing ignores a non-ENOENT error', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace)
    const mount = withFresh(mountOf(ws, '/data/f.txt'))
    await rec.onOpMissing(mount, 'stat', '/data/f.txt', new Error('boom'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('mayServeListing trusts the index under bounded', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const mount = mountOf(ws, '/data/d')
    const rec = new Reconciler(ws.cache, ws.namespace)
    expect(await rec.mayServeListing(mount, '/data/d', null)).toBe(true)
    await ws.close()
  })

  // fresh re-lists anything listed before the command started; a listing
  // the command itself refreshed is served, so one ls costs one re-list.
  // Outside any command a listing is trusted only for the window.
  it("mayServeListing under fresh trusts only this command's writes", async () => {
    const clock = shiftPerformanceNow()
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const mount = withFresh(mountOf(ws, '/data/d'))
      const rec = new Reconciler(ws.cache, ws.namespace)
      const index = mount.index
      await index.setDir('/data/d', [])
      expect(await rec.mayServeListing(mount, '/data/d', null)).toBe(true)
      clock.advance(LISTING_TRUST_WINDOW * 1000)
      expect(await rec.mayServeListing(mount, '/data/d', null)).toBe(false)
      await runInCommandScope(async () => {
        expect(await rec.mayServeListing(mount, '/data/d', null)).toBe(false)
        await index.setDir('/data/d', [])
        expect(await rec.mayServeListing(mount, '/data/d', null)).toBe(true)
        expect(await rec.mayServeListing(mount, '/data/other', null)).toBe(false)
      })
    } finally {
      clock.spy.mockRestore()
      await ws.close()
    }
  })

  it('mayServeCached trusts the cache under bounded', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const mount = mountOf(ws, '/data/f.txt')
    const rec = new Reconciler(ws.cache, ws.namespace)
    expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
    await ws.close()
  })

  // The self-heal, and it must remove rather than merely decline. Nothing
  // stamped a bound before this policy existed, and a warm read short-
  // circuits rather than re-setting, so a bound-less entry that is only
  // refused would sit there and refetch on every read forever.
  it('mayServeCached drops a bound-less entry under bounded rather than refusing it', async () => {
    const ram = new RAMVFS()
    await ops(ram).write(PathSpec.fromStrPath('/f.txt'), ENC.encode('v1'))
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE })
    try {
      await ws.cache.set('/data/f.txt', ENC.encode('v1'))
      expect(await ws.cache.isUnbounded('/data/f.txt')).toBe(true)

      const mount = mountOf(ws, '/data/f.txt')
      expect(mount.read.policy).toBe(ReadPolicy.BOUNDED)
      const rec = new Reconciler(ws.cache, ws.namespace)
      expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
      expect(await ws.cache.exists('/data/f.txt')).toBe(false)

      // The refill's other half -- that the cold read which follows
      // stamps a bound -- needs a shell, so it lives in
      // cache_mount.test.ts where a parser is already wired.
    } finally {
      await ws.close()
    }
  })

  it('mayServeCached serves an entry that already carries a bound', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.cache.set('/data/f.txt', ENC.encode('v1'), { ttl: 600 })
      const mount = mountOf(ws, '/data/f.txt')
      const rec = new Reconciler(ws.cache, ws.namespace)
      expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
      expect(await ws.cache.exists('/data/f.txt')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('mayServeCached forces a re-read when the stat carries no fingerprint', async () => {
    // The path exists and is cached, so the only reason to refuse is the
    // verdict: RAM stats without a fingerprint, which is UNKNOWN, which
    // evicts. This used to be answered by a supportsSnapshot short-circuit
    // that never probed at all.
    const ram = new RAMVFS()
    await ops(ram).write(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': ram })
    try {
      const mount = withFresh(mountOf(ws, '/data/f.txt'))
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace)
      expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
      expect(await ws.cache.exists('/data/f.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('mayServeCached serves a fingerprinted live-only backend', async () => {
    // supportsSnapshot is about whether a mount can be snapshotted, not
    // about whether its stat carries a content token; box, dropbox, github,
    // ssh and dify stamp one without setting the flag. Reading the flag here
    // threw their verified entries away.
    const ram = new RAMVFS()
    await ops(ram).write(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': ram })
    try {
      const mount = withFresh(mountOf(ws, '/data/f.txt'))
      expect(mount.vfs.supportsSnapshot).not.toBe(true)
      vi.spyOn(mount, 'callOp').mockImplementation(() =>
        Promise.resolve(new FileStat({ name: 'f.txt', type: FileType.FILE, fingerprint: 'fp1' })),
      )
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace)
      expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
      expect(await ws.cache.exists('/data/f.txt')).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await ws.close()
    }
  })

  it('reconcileRead GCs an orphaned overlay when the backend reports gone', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = withFresh(mountOf(ws, '/data/gone.txt'))
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    await ws.close()
  })

  it('reconcileRead is a no-op without an overlay or cached copy', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const mount = withFresh(mountOf(ws, '/data/plain.txt'))
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.reconcileRead(mount, '/data/plain.txt')
    await ws.close()
  })

  it('reconcileRead GCs an overlay whose path the backend no longer has', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = withFresh(mountOf(ws, '/data/gone.txt'))
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    await ws.close()
  })

  it.each(['no_stat_op', 'flaky'])(
    'an unverifiable probe drops the entry (%s)',
    async (failure) => {
      // Both ways of failing to verify end at UNKNOWN -- drop the entry, read
      // cold -- and that is the whole behavioural contract. What separates
      // them is the log: a missing op is a permanent capability of the mount,
      // so warning on every read would be noise, while a throwing stat is an
      // anomaly worth surfacing. Asserting the log is what keeps the carve-out
      // from being dead weight.
      const ram = new RAMVFS()
      await ops(ram).write(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
      const ws = new Workspace({ '/data': ram })
      const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const mount = withFresh(mountOf(ws, '/data/f.txt'))
        vi.spyOn(mount, 'callOp').mockImplementation(() =>
          Promise.reject(
            failure === 'no_stat_op'
              ? enotsup('stubborn', 'stat', '/data/f.txt')
              : new Error('backend stat unavailable'),
          ),
        )
        await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), {
          fingerprint: 'fp1',
        })
        const rec = new Reconciler(ws.cache, ws.namespace)
        expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
        expect(await ws.cache.exists('/data/f.txt')).toBe(false)
        expect(logged.mock.calls.length > 0).toBe(failure === 'flaky')
      } finally {
        vi.restoreAllMocks()
        await ws.close()
      }
    },
  )

  it('reconcileRead skips under bounded', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
    await ws.close()
  })

  it.each(['bug', 'flaky'])(
    'reconcileRead never throws and drops the entry (%s)',
    async (failure) => {
      // Routing runs before any handler exists, so a throw here does not fail
      // one command: it takes the whole line, later pipeline stages and `;`
      // chains included. Every failure is absorbed -- including the classes
      // the gate may rethrow -- and what could not be verified is dropped, or
      // a metadata command would serve a stale size from it with no check.
      const ws = new Workspace({ '/data': new RAMVFS() })
      await ws.namespace.ensureLoaded()
      const mount = withFresh(mountOf(ws, '/data/f.txt'))
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.spyOn(mount, 'callOp').mockImplementation(() =>
        Promise.reject(
          failure === 'bug'
            ? new TypeError('probe bug')
            : Object.assign(new Error('backend stat unavailable'), { code: 'EIO' }),
        ),
      )
      try {
        await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
        const rec = new Reconciler(ws.cache, ws.namespace)
        await rec.reconcileRead(mount, '/data/f.txt')
        expect(await ws.cache.exists('/data/f.txt')).toBe(false)
      } finally {
        vi.restoreAllMocks()
        await ws.close()
      }
    },
  )
})

describe('unverified freshness probes', () => {
  it.each(['unknown', 'none', 'failed', 'fresh'])(
    '%s cannot silently certify cached bytes',
    async (probe) => {
      const ws = new Workspace({ '/data': new RAMVFS() })
      try {
        const path = '/data/f.txt'
        const mount = withFresh(mountOf(ws, path))
        Object.defineProperty(mount.vfs, 'supportsSnapshot', { value: true })
        vi.spyOn(mount, 'callOp').mockImplementation(() => {
          if (probe === 'failed') return Promise.reject(new Error('probe unavailable'))
          if (probe === 'none') return Promise.resolve(null)
          return Promise.resolve(
            new FileStat({
              name: 'f.txt',
              type: FileType.FILE,
              fingerprint: probe === 'fresh' ? 'fp1' : null,
            }),
          )
        })
        const rec = new Reconciler(ws.cache, ws.namespace)
        await ws.cache.set(path, new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
        if (probe === 'failed') {
          // A probe that cannot run is "cannot verify", not a refusal: the
          // entry is dropped and the caller reads cold, so one flaky stat
          // costs a refetch rather than the whole command.
          expect(await rec.mayServeCached(mount, path)).toBe(false)
          expect(await ws.cache.exists(path)).toBe(false)
        } else {
          expect(await rec.mayServeCached(mount, path)).toBe(probe === 'fresh')
          expect(await ws.cache.exists(path)).toBe(probe === 'fresh')
        }
        await ws.cache.set(path, new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
        // Routing-time reconcile drops what it could not verify and lets the
        // command run: it serves no bytes itself, and raising from here would
        // abort the whole line. The gate above is where a failed probe
        // refuses.
        await rec.reconcileRead(mount, path)
        expect(await ws.cache.exists(path)).toBe(probe === 'fresh')
      } finally {
        vi.restoreAllMocks()
        await ws.close()
      }
    },
  )
})

it.each(['gate', 'shell'])('reconciles GitHub IDs before the %s reread', async (surface) => {
  let sha = 'v1'
  const accessor = new GitHubAccessor({
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    transport: {
      get: (path) =>
        Promise.resolve(
          path.includes('/blobs/')
            ? { encoding: 'base64', content: btoa(path.split('/').pop() ?? '') }
            : { tree: [{ path: 'f.txt', type: 'blob', sha, size: 2 }], truncated: false },
        ),
      request: () => Promise.reject(new Error('unexpected request')),
    },
  })
  const vfs = new RAMVFS()
  Object.defineProperty(vfs, 'supportsSnapshot', { value: true })
  // Model GitHub's snapshot lifetime; RAM's zero TTL expires each listing immediately.
  const ws = new Workspace({ '/gh': vfs }, { index: { ttl: 86_400 } })
  try {
    const path = '/gh/f.txt'
    const scope = new PathSpec({ virtual: path, vfsPath: 'f.txt', directory: '/gh/' })
    const mount = withFresh(mountOf(ws, path))
    expect((await githubStat(accessor, scope, mount.indexStore)).fingerprint).toBe('v1')
    await ws.cache.set(path, new TextEncoder().encode('v1'), { fingerprint: 'v1' })
    vi.spyOn(mount, 'callOp').mockImplementation((_op, p, _args, kwargs) =>
      githubStat(accessor, p, kwargs?.index),
    )
    const rec = new Reconciler(ws.cache, ws.namespace)
    // An unchanged live object must not be mistaken for a missing path.
    expect(await rec.mayServeCached(mount, path)).toBe(true)
    sha = 'v2'
    if (surface === 'gate') expect(await rec.mayServeCached(mount, path)).toBe(false)
    else await rec.reconcileRead(mount, path)
    expect(new TextDecoder().decode(await githubRead(accessor, scope, mount.indexStore))).toBe('v2')
  } finally {
    vi.restoreAllMocks()
    await ws.close()
  }
})

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  're-list preserves a nested mount subtree (shared=%s, replacement=%s)',
  async (shared, replacement) => {
    const parent = new RAMVFS()
    const ws = new Workspace(
      { '/data': parent, '/data/sub/nested': shared ? parent : new RAMVFS() },
      { index: { ttl: 600 } },
    )
    try {
      await ws.namespace.ensureLoaded()
      const index = ws.mount('/data').index
      const nested = ws.mount('/data/sub/nested').index
      await index.setDir('/data', [
        ['sub', new IndexEntry({ id: 'sub', name: 'sub', resourceType: 'folder' })],
      ])
      await nested.setDir('/data/sub/nested', [
        ['file', new IndexEntry({ id: 'file', name: 'file', resourceType: 'file' })],
      ])
      await ws.cache.set('/data/sub/old', ENC.encode('old'))
      await ws.cache.set('/data/sub/nested/file', ENC.encode('keep'))
      await ws.namespace.setAttrs('/data/sub/old', { mode: 0o600 })
      await ws.namespace.setAttrs('/data/sub/nested/file', { mode: 0o640 })
      await index.setDir(
        '/data',
        replacement
          ? [['sub', new IndexEntry({ id: 'new', name: 'sub', resourceType: 'file' })]]
          : [],
      )
      if (replacement) expect((await index.get('/data/sub')).entry?.id).toBe('new')
      expect(await ws.cache.get('/data/sub/nested/file')).toEqual(ENC.encode('keep'))
      expect(ws.namespace.metaFor('/data/sub/nested/file')?.mode).toBe(0o640)
      expect((await nested.listDir('/data/sub/nested')).entries).toEqual(['/data/sub/nested/file'])
      expect((await nested.get('/data/sub/nested/file')).entry).toBeDefined()
      expect(await ws.cache.exists('/data/sub/old')).toBe(false)
      expect(ws.namespace.metaFor('/data/sub/old')).toBeNull()
    } finally {
      await ws.close()
    }
  },
)

it('batches a thousand vanished children in one cleanup', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { index: { ttl: 600 } })
  try {
    await ws.namespace.ensureLoaded()
    const mount = ws.mount('/data')
    const rows: [string, IndexEntry][] = Array.from({ length: 1000 }, (_, i) => [
      `file-${String(i)}`,
      new IndexEntry({ id: String(i), name: `file-${String(i)}`, resourceType: 'file' }),
    ])
    await mount.index.setDir('/data', rows)
    for (const [name] of rows) {
      await ws.cache.set(`/data/${name}`, ENC.encode('stale'))
      await ws.namespace.setAttrs(`/data/${name}`, { mode: 0o600 })
    }
    await ws.cache.set('/data/keeper', ENC.encode('keep'))
    await ws.namespace.setAttrs('/data/keeper', { mode: 0o640 })
    const manager = mount.cacheManager
    if (manager === null) throw new Error('mount has no cache manager')
    const lock = vi.spyOn(manager, 'withMutation')
    const scans = vi.spyOn(ws.namespace.nodes, Symbol.iterator)
    await mount.index.setDir('/data', [])
    expect(lock).toHaveBeenCalledTimes(1)
    expect(scans).toHaveBeenCalledTimes(1)
    expect([...ws.namespace.nodes.keys()]).toEqual(['/data/keeper'])
    expect(await ws.cache.get('/data/keeper')).toEqual(ENC.encode('keep'))
    expect(await ws.cache.exists('/data/file-0')).toBe(false)
    expect(await ws.cache.exists('/data/file-999')).toBe(false)
  } finally {
    await ws.close()
  }
})

it('batches overlapping folders and protects nested mounts', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS(), '/data/tree/nested': new RAMVFS() },
    { index: { ttl: 600 } },
  )
  try {
    await ws.namespace.ensureLoaded()
    const removed = ['/data/tree', '/data/tree/sub/old', '/data/tree2/old']
    const kept = ['/data/tree/nested/keep', '/data/treehouse/keep']
    for (const path of [...removed, ...kept]) {
      await ws.cache.set(path, ENC.encode('data'))
      await ws.namespace.setAttrs(path, { mode: 0o600 })
    }
    await ws.namespace.symlink('/data/tree/link', '/data/target', 1)
    const evict = vi.spyOn(ws.cache, 'evictPrefix')
    await ws.mount('/data').index.reportGone([
      { path: '/data/tree/sub', folder: true },
      { path: '/data/tree/sub/old', folder: false },
      { path: '/data/tree/', folder: true },
      { path: '/data/tree', folder: true },
      { path: '/data/tree2', folder: true },
      { path: '/data/tree/nested/keep', folder: false },
    ])
    expect(evict).toHaveBeenCalledTimes(2)
    expect(evict.mock.calls.map(([path]) => path).sort()).toEqual(['/data/tree/', '/data/tree2/'])
    for (const path of removed) {
      expect(await ws.cache.exists(path)).toBe(false)
      expect(ws.namespace.metaFor(path)).toBeNull()
    }
    for (const path of kept) {
      expect(await ws.cache.exists(path)).toBe(true)
      expect(ws.namespace.metaFor(path)).not.toBeNull()
    }
    expect(ws.namespace.readlink('/data/tree/link')).toBe('/data/target')
  } finally {
    await ws.close()
  }
})

// The gate reuses what routing got from the backend; a write in the same
// command retires that answer, so the next probe asks again and sees a
// deletion the remembered stat would have hidden.
it('a write in the command sends the next probe to the backend', async () => {
  const resource = new RAMVFS()
  resource.store.files.set('/f.txt', new TextEncoder().encode('v1'))
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })
  try {
    await ws.namespace.ensureLoaded()
    const mount = withFresh(mountOf(ws, '/data/f.txt'))
    await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
    const rec = new Reconciler(ws.cache, ws.namespace)
    const spec = PathSpec.fromStrPath('/data/f.txt')
    await runInCommandScope(async () => {
      await rec.reconcileRead(mount, '/data/f.txt')
      expect(mount.cacheManager?.probedStat(spec)?.size).toBe(2)
      resource.store.files.delete('/f.txt')
      await mount.cacheManager?.invalidateAfterWrite(PathSpec.fromStrPath('/data/g.txt'))
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      await expect(rec.mayServeCached(mount, '/data/f.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  } finally {
    await ws.close()
  }
})

describe('the gate reuses what routing got from the backend', () => {
  it('does not reuse an answer when a write completed during the probe', async () => {
    const ws = await wsWithOverlay()
    let captured = (): void => undefined
    let release = (): void => undefined
    const capturedPromise = new Promise<void>((resolve) => {
      captured = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    let fingerprint = 'fp1'
    let calls = 0
    try {
      const mount = withFresh(mountOf(ws, '/data/f.txt'))
      vi.spyOn(mount, 'callOp').mockImplementation(async () => {
        calls += 1
        const result = new FileStat({ name: 'f.txt', size: 2, type: FileType.FILE, fingerprint })
        if (calls === 1) {
          captured()
          await releasePromise
        }
        return result
      })
      await ws.cache.set('/data/f.txt', ENC.encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace)
      await runInCommandScope(async () => {
        const probing = rec.reconcileRead(mount, '/data/f.txt')
        await capturedPromise
        await mount.cacheManager?.invalidateAfterWrite(PathSpec.fromStrPath('/data/g.txt'))
        fingerprint = 'fp2'
        release()
        await probing
        expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
        expect(calls).toBe(2)
      })
    } finally {
      release()
      await ws.close()
    }
  })

  async function gated(): Promise<{
    ws: Workspace
    mount: MountEntry
    rec: Reconciler
    calls: () => number
  }> {
    const resource = new RAMVFS()
    resource.store.files.set('/f.txt', new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })
    await ws.namespace.ensureLoaded()
    const mount = withFresh(mountOf(ws, '/data/f.txt'))
    await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
    let calls = 0
    vi.spyOn(mount, 'callOp').mockImplementation(() => {
      calls += 1
      return Promise.resolve(
        new FileStat({ name: 'f.txt', size: 2, type: FileType.FILE, fingerprint: 'fp1' }),
      )
    })
    return { ws, mount, rec: new Reconciler(ws.cache, ws.namespace), calls: () => calls }
  }

  // Routing and the gate share the command: the gate compares the cache
  // against what routing got from the backend instead of asking again.
  it('reuses the routing probe', async () => {
    const { ws, mount, rec, calls } = await gated()
    try {
      await runInCommandScope(async () => {
        await rec.reconcileRead(mount, '/data/f.txt')
        expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
      })
      expect(calls()).toBe(1)
    } finally {
      await ws.close()
    }
  })

  // Reuse skips the round trip, never the verdict: a remembered token that
  // does not match the cached copy still evicts it.
  it('still compares a reused answer with the cache', async () => {
    const { ws, mount, rec, calls } = await gated()
    try {
      await runInCommandScope(async () => {
        mount.cacheManager?.noteProbed(
          PathSpec.fromStrPath('/data/f.txt'),
          new FileStat({ name: 'f.txt', size: 2, type: FileType.FILE, fingerprint: 'fp2' }),
        )
        expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
      })
      expect(await ws.cache.exists('/data/f.txt')).toBe(false)
      expect(calls()).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('asks the backend after a write in the command', async () => {
    const { ws, mount, rec, calls } = await gated()
    try {
      await runInCommandScope(async () => {
        await rec.reconcileRead(mount, '/data/f.txt')
        await mount.cacheManager?.invalidateAfterWrite(PathSpec.fromStrPath('/data/g.txt'))
        await rec.mayServeCached(mount, '/data/f.txt')
      })
      expect(calls()).toBe(2)
    } finally {
      await ws.close()
    }
  })

  // Native code (an external program, a remote runtime line) may have
  // changed the mount mid-command; the clear that follows it must retire what
  // routing saw, as a write in the command does.
  it('asks the backend after an external clear', async () => {
    const { ws, mount, rec, calls } = await gated()
    try {
      await runInCommandScope(async () => {
        await rec.reconcileRead(mount, '/data/f.txt')
        await ws.registry.invalidateAfterExternal()
        await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
        await rec.mayServeCached(mount, '/data/f.txt')
      })
      expect(calls()).toBe(2)
    } finally {
      await ws.close()
    }
  })

  // FUSE and the op door belong to no command, so nothing a command's probe
  // saw is reused for them.
  it('asks the backend outside a command', async () => {
    const { ws, mount, rec, calls } = await gated()
    try {
      await runInCommandScope(() => rec.reconcileRead(mount, '/data/f.txt'))
      await rec.mayServeCached(mount, '/data/f.txt')
      expect(calls()).toBe(2)
    } finally {
      await ws.close()
    }
  })
})

describe('the listing version gate', () => {
  // The raw store, so the write is not one the running command made.
  async function store(mount: MountEntry, folder: string, version: string | null): Promise<void> {
    await mount.indexStore.setDir(folder, [], null, { version })
  }

  async function inCommand(
    rec: Reconciler,
    mount: MountEntry,
    folder: string,
    version: string | null,
  ): Promise<boolean> {
    return runInCommandScope(() => rec.mayServeListing(mount, folder, version))
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }

  async function withVersioned(
    vfs: VersionedVFS,
    body: (ctx: ReturnType<typeof versionedWorkspace>) => Promise<void>,
  ): Promise<void> {
    const ctx = versionedWorkspace(vfs)
    try {
      await body(ctx)
    } finally {
      vfs.release()
      vi.restoreAllMocks()
      await ctx.ws.close()
    }
  }

  it("trusts this command's own listing unchecked", async () => {
    const vfs = new VersionedVFS('mount')
    await withVersioned(vfs, async ({ mount, rec }) => {
      await runInCommandScope(async () => {
        await mount.index.setDir('/m/a', [], null, { version: 'v1' })
        expect(await rec.mayServeListing(mount, '/m/a', 'v1')).toBe(true)
      })
      expect(vfs.stats).toEqual([])
    })
  })

  it('never checks a mount without versions', async () => {
    const vfs = new VersionedVFS('none')
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      expect(await inCommand(rec, mount, '/m/a', 'v1')).toBe(false)
      expect(vfs.stats).toEqual([])
    })
  })

  it('never checks a listing stored without a version', async () => {
    const vfs = new VersionedVFS('mount')
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', null)
      expect(await inCommand(rec, mount, '/m/a', null)).toBe(false)
      expect(vfs.stats).toEqual([])
    })
  })

  it('refuses a moved version and keeps the listing', async () => {
    // A refusal leaves the listing stored for the re-list to diff, and the
    // index is never cleared.
    const vfs = new VersionedVFS('mount', 'v2')
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      await mount.indexStore.put(
        '/m/f.txt',
        new IndexEntry({ id: 'f', name: 'f.txt', resourceType: 'file' }),
      )
      expect(await inCommand(rec, mount, '/m/a', 'v1')).toBe(false)
      expect(vfs.stats).toEqual(['/m'])
      const kept = await mount.indexStore.listDir('/m/a')
      expect(kept.entries).toEqual([])
      expect(kept.version).toBe('v1')
      expect((await mount.indexStore.get('/m/f.txt')).entry).not.toBeNull()
    })
  })

  it.each(['enoent', 'none'])('refuses what the check cannot confirm (%s)', async (outcome) => {
    const vfs = new VersionedVFS('mount')
    if (outcome === 'enoent') vfs.rejects = enoent('/m')
    else vfs.remote = null
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      expect(await inCommand(rec, mount, '/m/a', 'v1')).toBe(false)
      expect(vfs.stats).toEqual(['/m'])
      expect((await mount.indexStore.listDir('/m/a')).version).toBe('v1')
      const logged = warn.mock.calls.map((c) => String(c[0]))
      expect(logged).toEqual([])
    })
  })

  it.each([
    ['TypeError', () => new TypeError('bug')],
    ['ReferenceError', () => new ReferenceError('bug')],
  ])('lets a programming error escape (%s)', async (_name, make) => {
    const vfs = new VersionedVFS('mount')
    vfs.rejects = make()
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      await expect(inCommand(rec, mount, '/m/a', 'v1')).rejects.toThrow('bug')
    })
  })

  it('refuses silently without a stat op', async () => {
    const vfs = new VersionedVFS('mount')
    vfs.hasStat = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await withVersioned(vfs, async ({ mount, rec, asked }) => {
      await store(mount, '/m/a', 'v1')
      expect(await inCommand(rec, mount, '/m/a', 'v1')).toBe(false)
      expect(asked).toEqual(['stat'])
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('never shares a check sent before the command began', async () => {
    // Command C starts after A's check was sent, so that check may predate a
    // change C must see: C sends its own.
    const vfs = new VersionedVFS('mount')
    vfs.hold()
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      let sent = vfs.sent()
      const first = inCommand(rec, mount, '/m/a', 'v1')
      await sent
      sent = vfs.sent()
      const second = inCommand(rec, mount, '/m/a', 'v1')
      await sent
      vfs.release()
      expect(await first).toBe(true)
      expect(await second).toBe(true)
      expect(vfs.stats).toEqual(['/m', '/m'])
    })
  })

  it('stamps a check when it is sent', async () => {
    // Command D starts while A's check is in flight and gates after it lands.
    // The check was sent before D began, so its answer is not D's.
    const vfs = new VersionedVFS('mount')
    vfs.hold()
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      const sent = vfs.sent()
      const first = inCommand(rec, mount, '/m/a', 'v1')
      await sent
      await runInCommandScope(async () => {
        vfs.release()
        expect(await first).toBe(true)
        expect(await rec.mayServeListing(mount, '/m/a', 'v1')).toBe(true)
      })
      expect(vfs.stats).toEqual(['/m', '/m'])
    })
  })

  function gateWhenTold(
    rec: Reconciler,
    mount: MountEntry,
    entered: () => void,
    go: Promise<void>,
  ): Promise<boolean> {
    return runInCommandScope(async () => {
      entered()
      await go
      return rec.mayServeListing(mount, '/m/a', 'v1')
    })
  }

  function signals(n: number): { all: Promise<unknown>; marks: (() => void)[] } {
    const marks: (() => void)[] = []
    const all = Promise.all(
      Array.from(
        { length: n },
        () =>
          new Promise<void>((resolve) => {
            marks.push(resolve)
          }),
      ),
    )
    return { all, marks }
  }

  it('shares one check among commands already running', async () => {
    const vfs = new VersionedVFS('mount')
    vfs.hold()
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      let open = (): void => undefined
      const go = new Promise<void>((resolve) => {
        open = resolve
      })
      const { all, marks } = signals(7)
      const gates = marks.map((mark) => gateWhenTold(rec, mount, mark, go))
      await all
      const sent = vfs.sent()
      open()
      await sent
      await settle()
      vfs.release()
      expect(await Promise.all(gates)).toEqual(Array(7).fill(true))
      expect(vfs.stats).toEqual(['/m'])
    })
  })

  it('delivers a shared failure to each waiter on its own', async () => {
    // The python twin cancels one waiter; here the analogue is that the one
    // shared check's rejection is classified by each waiter, so none of them
    // throws and none is left hanging.
    const vfs = new VersionedVFS('mount')
    vfs.hold()
    vfs.rejects = new Error('backend down')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      let open = (): void => undefined
      const go = new Promise<void>((resolve) => {
        open = resolve
      })
      const { all, marks } = signals(2)
      const gates = marks.map((mark) => gateWhenTold(rec, mount, mark, go))
      await all
      const sent = vfs.sent()
      open()
      await sent
      await settle()
      vfs.release()
      expect(await Promise.all(gates)).toEqual([false, false])
      expect(vfs.stats).toEqual(['/m'])
    })
  })

  it('outside a command reuses a check for the window', async () => {
    const clock = shiftPerformanceNow()
    const vfs = new VersionedVFS('mount')
    await withVersioned(vfs, async ({ mount, rec }) => {
      await store(mount, '/m/a', 'v1')
      expect(await rec.mayServeListing(mount, '/m/a', 'v1')).toBe(true)
      expect(vfs.stats).toEqual(['/m'])
      clock.advance((LISTING_TRUST_WINDOW * 1000) / 2)
      expect(await rec.mayServeListing(mount, '/m/a', 'v1')).toBe(true)
      expect(vfs.stats).toEqual(['/m'])
      clock.advance(LISTING_TRUST_WINDOW * 1000)
      expect(await rec.mayServeListing(mount, '/m/a', 'v1')).toBe(true)
      expect(vfs.stats).toEqual(['/m', '/m'])
    })
  })

  it('forgets its checks when the store changes', async () => {
    const vfs = new VersionedVFS('mount')
    await withVersioned(vfs, async ({ mount }) => {
      await store(mount, '/m/a', 'v1')
      await runInCommandScope(async () => {
        expect((await mount.index.listDir('/m/a')).entries).toEqual([])
        expect(vfs.stats).toEqual(['/m'])
        const replacement = new RAMIndexCacheStore({ ttl: 600 })
        await replacement.setDir('/m/a', [], null, { version: 'v1' })
        ;(mount as { indexStore: IndexCacheStore }).indexStore = replacement
        expect((await mount.index.listDir('/m/a')).entries).toEqual([])
      })
      expect(vfs.stats).toEqual(['/m', '/m'])
    })
  })
})

// The probe stats through a scratch store whose only lead is the mount's own
// row: a backend with no path lookup (box) may address that id once, and
// must confirm what comes back.
it('the probe hints the mount index row', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() })
  try {
    await ws.namespace.ensureLoaded()
    const path = '/data/f.txt'
    const mount = withFresh(mountOf(ws, path))
    const row = new IndexEntry({ id: 'F1', name: 'f.txt', resourceType: 'file' })
    await mount.indexStore.setDir('/data', [['f.txt', row]])
    await mount.indexStore.setDir('/elsewhere', [['g.txt', row]])
    const held = (await mount.index.get(path)).entry
    expect(held).toBeDefined()
    expect((await mount.indexStore.get('/elsewhere/g.txt')).entry).toBeDefined()
    const seen: (IndexEntry | null)[] = []
    vi.spyOn(mount, 'callOp').mockImplementation(async (_op, _p, _args, kwargs) => {
      const index = kwargs?.index
      if (!(index instanceof ListingCheckStore))
        throw new Error('the probe passed no scratch index')
      // Hints come through the mount's view, whose ownership check keeps
      // a row outside the mount from passing as a lead.
      expect(await index.hint('/elsewhere/g.txt')).toBeNull()
      seen.push(await index.hint(path))
      return new FileStat({ name: 'f.txt', type: FileType.FILE, fingerprint: 'fp1' })
    })
    await ws.cache.set(path, new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
    const rec = new Reconciler(ws.cache, ws.namespace)
    expect(await rec.mayServeCached(mount, path)).toBe(true)
    expect(seen).toEqual([held])
  } finally {
    vi.restoreAllMocks()
    await ws.close()
  }
})

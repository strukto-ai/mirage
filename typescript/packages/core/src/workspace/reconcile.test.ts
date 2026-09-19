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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { ConsistencyPolicy, FileStat, FileType, PathSpec } from '../types.ts'
import type { MountEntry } from './mount/mount.ts'
import { enotsup } from '../utils/errors.ts'
import { Reconciler } from './reconcile.ts'
import { Workspace } from './workspace/workspace.ts'

function enoent(path: string): Error {
  return Object.assign(new Error(path), { code: 'ENOENT' })
}

function mountOf(ws: Workspace, path: string): MountEntry {
  return ws.namespace.mountFor(path)
}

async function wsWithOverlay(): Promise<Workspace> {
  const ws = new Workspace({ '/data': new RAMVFS() })
  await ws.namespace.ensureLoaded()
  await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
  return ws
}

describe('Reconciler', () => {
  it('onOpMissing GCs an orphaned overlay under ALWAYS + stat + ENOENT', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
  })

  it('onOpMissing keeps an authoritative symlink', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.symlink('/data/link', '/data/t', 1)
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/link', enoent('/data/link'))
    expect(ws.namespace.readlink('/data/link')).toBe('/data/t')
    await ws.close()
  })

  it('onOpMissing skips under LAZY', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.LAZY)
    await rec.onOpMissing('stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing skips a non-revalidate op', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('write', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing ignores a non-ENOENT error', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/f.txt', new Error('boom'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('mayServeCached trusts the cache under LAZY', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const mount = mountOf(ws, '/data/f.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.LAZY)
    expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
    await ws.close()
  })

  it('mayServeCached forces a re-read when the stat carries no fingerprint', async () => {
    // The path exists and is cached, so the only reason to refuse is the
    // verdict: RAM stats without a fingerprint, which is UNKNOWN, which
    // evicts. This used to be answered by a supportsSnapshot short-circuit
    // that never probed at all.
    const ram = new RAMVFS()
    await ram.writeFile(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': ram })
    try {
      const mount = mountOf(ws, '/data/f.txt')
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
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
    await ram.writeFile(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': ram })
    try {
      const mount = mountOf(ws, '/data/f.txt')
      expect(mount.vfs.supportsSnapshot).not.toBe(true)
      vi.spyOn(ws.opsRegistry, 'call').mockImplementation(() =>
        Promise.resolve(new FileStat({ name: 'f.txt', type: FileType.FILE, fingerprint: 'fp1' })),
      )
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
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
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    await ws.close()
  })

  it('reconcileRead is a no-op without an overlay or cached copy', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const mount = mountOf(ws, '/data/plain.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.reconcileRead(mount, '/data/plain.txt')
    await ws.close()
  })

  it('reconcileRead skips a cached path the gate will probe', async () => {
    // The gate owns cached-byte freshness; this owns overlay GC. Probing
    // here as well would stat twice for one warm read.
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    const mount = mountOf(ws, '/data/f.txt')
    const probed: string[] = []
    vi.spyOn(ws.opsRegistry, 'call').mockImplementation((_op, _res, _acc, scope) => {
      probed.push(scope.virtual)
      return Promise.resolve(null)
    })
    try {
      await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), { fingerprint: 'fp1' })
      const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)

      await rec.reconcileRead(mount, '/data/f.txt', true)
      expect(probed).toEqual([])

      await rec.reconcileRead(mount, '/data/f.txt', false)
      expect(probed).toEqual(['/data/f.txt'])
    } finally {
      vi.restoreAllMocks()
      await ws.close()
    }
  })

  it('reconcileRead still probes an overlay the gate cannot see', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    await rec.reconcileRead(mount, '/data/gone.txt', true)
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
      await ram.writeFile(PathSpec.fromStrPath('/f.txt'), new TextEncoder().encode('v1'))
      const ws = new Workspace({ '/data': ram })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const mount = mountOf(ws, '/data/f.txt')
        vi.spyOn(ws.opsRegistry, 'call').mockImplementation(() =>
          Promise.reject(
            failure === 'no_stat_op'
              ? enotsup('stubborn', 'stat', '/data/f.txt')
              : new Error('backend stat unavailable'),
          ),
        )
        await ws.cache.set('/data/f.txt', new TextEncoder().encode('v1'), {
          fingerprint: 'fp1',
        })
        const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
        expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
        expect(await ws.cache.exists('/data/f.txt')).toBe(false)
        expect(warn.mock.calls.length > 0).toBe(failure === 'flaky')
      } finally {
        vi.restoreAllMocks()
        await ws.close()
      }
    },
  )

  it('reconcileRead skips under LAZY', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.LAZY)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
    await ws.close()
  })
})

describe('unverified freshness probes', () => {
  it.each(['unknown', 'none', 'failed', 'fresh'])(
    '%s cannot silently certify cached bytes',
    async (probe) => {
      const ws = new Workspace({ '/data': new RAMVFS() })
      try {
        const path = '/data/f.txt'
        const mount = mountOf(ws, path)
        Object.defineProperty(mount.vfs, 'supportsSnapshot', { value: true })
        vi.spyOn(ws.opsRegistry, 'call').mockImplementation(() => {
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
        const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
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
    expect((await githubStat(accessor, scope, vfs.index)).fingerprint).toBe('v1')
    await ws.cache.set(path, new TextEncoder().encode('v1'), { fingerprint: 'v1' })
    vi.spyOn(ws.opsRegistry, 'call').mockImplementation((_op, _vfs, _accessor, p, _args, kwargs) =>
      githubStat(accessor, p, kwargs?.index),
    )
    const mount = mountOf(ws, path)
    const rec = new Reconciler(ws.cache, ws.namespace, ws.opsRegistry, ConsistencyPolicy.ALWAYS)
    // An unchanged live object must not be mistaken for a missing path.
    expect(await rec.mayServeCached(mount, path)).toBe(true)
    sha = 'v2'
    if (surface === 'gate') expect(await rec.mayServeCached(mount, path)).toBe(false)
    else await rec.reconcileRead(mount, path)
    expect(new TextDecoder().decode(await githubRead(accessor, scope, vfs.index))).toBe('v2')
  } finally {
    vi.restoreAllMocks()
    await ws.close()
  }
})

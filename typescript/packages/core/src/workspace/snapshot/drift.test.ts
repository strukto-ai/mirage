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

import { describe, expect, it } from 'vitest'
import {
  CONTENT_CHANGING_OPS,
  OpRecord,
  RETRACT_FINGERPRINT_OPS,
  STAMP_FINGERPRINT_OPS,
  SUBTREE_RETRACT_OPS,
} from '../../observe/record.ts'
import type { VFS } from '../../vfs/base.ts'
import { FileStat, FileType } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import { DriftPolicy } from '../../types.ts'
import {
  captureFingerprints,
  checkDrift,
  ContentDriftError,
  DriftQueue,
  installDriftState,
  liveOnlyMountPrefixes,
} from './drift.ts'

interface RegistryLike {
  tryMountFor(path: string): MountEntry | null
  allMounts(): readonly MountEntry[]
}

function makeMount(prefix: string, supportsSnapshot: boolean): MountEntry {
  const vfs: VFS = {
    kind: 's3',
    supportsSnapshot,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getState: () => ({ type: 's3' }),
    loadState: () => {
      // Nothing to take back.
    },
  }
  const m: Partial<MountEntry> & {
    prefix: string
    vfs: VFS
    revisions: Map<string, string>
  } = {
    prefix,
    vfs,
    revisions: new Map(),
  }
  return m as MountEntry
}

function makeStatFn(stats?: Record<string, FileStat>): (path: string) => Promise<FileStat> {
  return (path) => {
    const hit = stats?.[path]
    if (hit !== undefined) return Promise.resolve(hit)
    const err = new Error(`not found: ${path}`) as Error & { code: string }
    err.code = 'ENOENT'
    return Promise.reject(err)
  }
}

function makeRegistry(mounts: MountEntry[]): RegistryLike {
  return {
    // Longest prefix wins, as the real registry resolves: a first-match
    // walk hands `/s3/a` to a `/` mount whenever both are mounted, and
    // the mount-scoped subtree sweep is exactly what that hides.
    tryMountFor: (path: string): MountEntry | null => {
      const base = `${path.replace(/\/+$/, '')}/`
      let best: MountEntry | null = null
      for (const m of mounts) {
        if (base.startsWith(m.prefix) && (best === null || m.prefix.length > best.prefix.length)) {
          best = m
        }
      }
      return best
    },
    allMounts: () => mounts,
  }
}

function opRecord(
  op: string,
  path: string,
  fingerprint: string | null = null,
  revision: string | null = null,
  timestamp = 0,
): OpRecord {
  return new OpRecord({
    op,
    path,
    source: 's3',
    bytes: 0,
    timestamp,
    durationMs: 0,
    fingerprint,
    revision,
  })
}

function makeRecord(
  path: string,
  fingerprint: string | null = null,
  revision: string | null = null,
): OpRecord {
  return new OpRecord({
    op: 'read',
    path,
    source: 's3',
    bytes: 0,
    timestamp: 0,
    durationMs: 0,
    fingerprint,
    revision,
  })
}

describe('captureFingerprints', () => {
  it('emits one entry per distinct fingerprinted path on a snapshot-capable mount', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const records = [makeRecord('/s3/a', 'fp-a'), makeRecord('/s3/b', 'fp-b', 'rev-b')]
    const entries = captureFingerprints(records, registry)
    expect(entries).toEqual([
      { path: '/s3/a', mount_prefix: '/s3/', fingerprint: 'fp-a' },
      { path: '/s3/b', mount_prefix: '/s3/', fingerprint: 'fp-b', revision: 'rev-b' },
    ])
  })

  it('deduplicates by path; the last record wins', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-old'), makeRecord('/s3/a', 'fp-new')],
      registry,
    )
    expect(entries.length).toBe(1)
    expect(entries[0]?.fingerprint).toBe('fp-new')
  })

  it('skips reads with neither fingerprint nor revision', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints([makeRecord('/s3/a')], registry)
    expect(entries.length).toBe(0)
  })

  it('captures a write that carries a token', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints([opRecord('write', '/s3/a', 'fp-a')], registry)
    expect(entries).toEqual([{ path: '/s3/a', mount_prefix: '/s3/', fingerprint: 'fp-a' }])
  })

  it('skips an op that stamps no token at all', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    expect(captureFingerprints([opRecord('readdir', '/s3/a', 'fp-a')], registry).length).toBe(0)
  })

  it('retracts a pin when the object is removed', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [opRecord('write', '/s3/a', 'fp-a'), opRecord('unlink', '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it('a retraction takes the whole subtree with it', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [
        opRecord('write', '/s3/d/f', 'fp-f'),
        opRecord('write', '/s3/ab.txt', 'fp-ab'),
        opRecord('rm_r', '/s3/d'),
      ],
      registry,
    )
    // `/s3/ab.txt` is not under `/s3/d`, and a bare startswith would have
    // taken `/s3/d`'s sibling too.
    expect(entries.map((e) => e.path)).toEqual(['/s3/ab.txt'])
  })

  it('a sibling sharing a name prefix is not retracted', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [opRecord('write', '/s3/ab.txt', 'fp-ab'), opRecord('unlink', '/s3/a')],
      registry,
    )
    expect(entries.map((e) => e.path)).toEqual(['/s3/ab.txt'])
  })

  it('a mount-root retraction drops the mount, whichever way it is spelled', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    for (const rootPath of ['/s3', '/s3/']) {
      const entries = captureFingerprints(
        [opRecord('write', '/s3/a', 'fp-a'), opRecord('rm_r', rootPath)],
        registry,
      )
      expect(entries, rootPath).toEqual([])
    }
  })

  it('a re-write after a retraction pins the new token', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [
        opRecord('write', '/s3/a', 'fp-1'),
        opRecord('unlink', '/s3/a'),
        opRecord('write', '/s3/a', 'fp-2'),
      ],
      registry,
    )
    expect(entries).toEqual([{ path: '/s3/a', mount_prefix: '/s3/', fingerprint: 'fp-2' }])
  })

  it('a write that carries no token retracts the pin it cannot describe', () => {
    // gdrive's shape: it stamps a read fingerprint but records a tokenless
    // write, so the pre-write token must not survive the write.
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-read'), opRecord('write', '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it('an append retracts, since it never carries a token', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-read'), opRecord('append', '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it('a read reporting no token leaves the pin alone', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [opRecord('write', '/s3/a', 'fp-a'), makeRecord('/s3/a')],
      registry,
    )
    expect(entries).toEqual([{ path: '/s3/a', mount_prefix: '/s3/', fingerprint: 'fp-a' }])
  })

  it('replaces the entry whole, so a read revision cannot outlive it', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-read', 'rev-read'), opRecord('write', '/s3/a', 'fp-write')],
      registry,
    )
    expect(entries).toEqual([{ path: '/s3/a', mount_prefix: '/s3/', fingerprint: 'fp-write' }])
  })

  it('skips mounts that opt out of snapshot replay', () => {
    const mount = makeMount('/gmail/', false)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints([makeRecord('/gmail/inbox/1', 'fp-1')], registry)
    expect(entries.length).toBe(0)
  })
})

describe('captureFingerprints op sets', () => {
  const mount = makeMount('/s3/', true)
  const registry = makeRegistry([mount])

  it('a move retracts the destination pin too', () => {
    // `mv a b` replaces b's bytes with a's, so b's own token stops
    // describing its object. The src record alone would leave it pinned.
    const entries = captureFingerprints(
      [
        opRecord('write', '/s3/a', 'fp-a'),
        opRecord('write', '/s3/b', 'fp-b'),
        opRecord('rename', '/s3/a'),
        opRecord('rename', '/s3/b'),
      ],
      registry,
    )
    expect(entries).toEqual([])
  })

  it('a copy retracts the destination pin', () => {
    const entries = captureFingerprints(
      [
        opRecord('write', '/s3/a', 'fp-a'),
        opRecord('write', '/s3/b', 'fp-b'),
        opRecord('copy', '/s3/b'),
      ],
      registry,
    )
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it('holds exactly what the ladder needs', () => {
    // Each member is load-bearing: dropping one silently changes which
    // arm an op takes, and every behaviour test would still pass.
    expect([...STAMP_FINGERPRINT_OPS].sort()).toEqual(['create', 'read', 'truncate', 'write'])
    expect([...CONTENT_CHANGING_OPS].sort()).toEqual(['append', 'create', 'truncate', 'write'])
    expect([...RETRACT_FINGERPRINT_OPS].sort()).toEqual([
      'copy',
      'rename',
      'rename_prefix',
      'rm_r',
      'rmdir',
      'unlink',
    ])
    expect([...SUBTREE_RETRACT_OPS].sort()).toEqual(['rename_prefix', 'rm_r'])
  })

  it.each([...SUBTREE_RETRACT_OPS])('%s takes a descendant pin with it', (op) => {
    const entries = captureFingerprints(
      [opRecord('write', '/s3/a/b', 'fp-b'), opRecord(op, '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it.each([...RETRACT_FINGERPRINT_OPS].filter((op) => !SUBTREE_RETRACT_OPS.has(op)))(
    '%s leaves a descendant pin alone',
    (op) => {
      // On a keyed store `a` and `a/b` are both objects, and `rm a`
      // leaves `a/b` alone; only an op that can move a whole prefix
      // takes one.
      const entries = captureFingerprints(
        [opRecord('write', '/s3/a/b', 'fp-b'), opRecord(op, '/s3/a')],
        registry,
      )
      expect(entries.map((e) => e.path)).toEqual(['/s3/a/b'])
    },
  )

  it('a mount-root retraction leaves a nested mount alone', () => {
    // A nested mount's keys live in a different backend, so an op on the
    // parent never touched them. Worst at '/', where every virtual path
    // reads as being under the retracted root.
    const nested = makeRegistry([makeMount('/', true), makeMount('/s3/', true)])
    const entries = captureFingerprints(
      [opRecord('write', '/x', 'fp-x'), opRecord('write', '/s3/a', 'fp-a'), opRecord('rm_r', '/')],
      nested,
    )
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it('orders records by timestamp, not by position', () => {
    // A backend record reaches the list when its line ends, while an
    // `Ops` facade record appends as it happens, so a retraction can sit
    // ahead of the write it precedes in time.
    const entries = captureFingerprints(
      [opRecord('write', '/s3/a', 'fp-a', null, 2), opRecord('unlink', '/s3/a', null, null, 1)],
      registry,
    )
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it('keeps the order of records sharing one millisecond', () => {
    // The sort is stable, so an unlink and the rewrite that followed it
    // inside one millisecond do not swap.
    const entries = captureFingerprints(
      [opRecord('unlink', '/s3/a'), opRecord('write', '/s3/a', 'fp-new')],
      registry,
    )
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it('drops a pin for a content-changing op carrying a token it cannot use', () => {
    // `append` is in CONTENT_CHANGING but not in STAMP, so it never
    // reaches the stamping arm; a token on its record must not buy the
    // pre-append pin a reprieve it cannot use.
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-read'), opRecord('append', '/s3/a', 'fp-append')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it('pins an empty fingerprint that carries a revision beside it', () => {
    // The token test is truthiness, not null-ness: an empty string is no
    // token, but the revision beside it is one. `??` would read the
    // empty string as the answer and drop the pin.
    const entries = captureFingerprints([opRecord('write', '/s3/a', '', 'rev-1')], registry)
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it.each([...RETRACT_FINGERPRINT_OPS])('%s drops a pin', (op) => {
    const entries = captureFingerprints(
      [opRecord('write', '/s3/a', 'fp-a'), opRecord(op, '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })

  it.each([...STAMP_FINGERPRINT_OPS])('%s can set a pin', (op) => {
    const entries = captureFingerprints([opRecord(op, '/s3/a', 'fp-a')], registry)
    expect(entries.map((e) => e.path)).toEqual(['/s3/a'])
  })

  it.each([...CONTENT_CHANGING_OPS])('%s drops a pin it cannot describe', (op) => {
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-read'), opRecord(op, '/s3/a')],
      registry,
    )
    expect(entries).toEqual([])
  })
})

describe('liveOnlyMountPrefixes', () => {
  it('returns prefixes of mounts that opt out of snapshot replay', () => {
    const s3 = makeMount('/s3/', true)
    const gmail = makeMount('/gmail/', false)
    const registry = makeRegistry([s3, gmail])
    expect(liveOnlyMountPrefixes(registry)).toEqual(['/gmail/'])
  })

  it('excludes infrastructure prefixes /dev/ and /.bash_history/', () => {
    const dev = makeMount('/dev/', false)
    const history = makeMount('/.bash_history/', false)
    const registry = makeRegistry([dev, history])
    expect(liveOnlyMountPrefixes(registry)).toEqual([])
  })
})

describe('checkDrift', () => {
  it('no-op when live fingerprint matches recorded', async () => {
    const stats = { '/s3/a': new FileStat({ name: 'a', type: FileType.FILE, fingerprint: 'fp-a' }) }
    const mount = makeMount('/s3/', true)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/s3/a', 'fp-a'),
    ).resolves.toBeUndefined()
  })

  it('throws ContentDriftError when live differs from recorded', async () => {
    const stats = {
      '/s3/a': new FileStat({ name: 'a', type: FileType.FILE, fingerprint: 'fp-live' }),
    }
    const mount = makeMount('/s3/', true)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/s3/a', 'fp-snap'),
    ).rejects.toBeInstanceOf(ContentDriftError)
  })

  it('throws ContentDriftError with live=null when the path is gone', async () => {
    const mount = makeMount('/s3/', true)
    let caught: unknown = null
    try {
      await checkDrift(makeRegistry([mount]), makeStatFn(), '/s3/missing', 'fp-snap')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ContentDriftError)
    expect((caught as ContentDriftError).liveFingerprint).toBeNull()
  })

  it('no-op when live FileStat has null fingerprint (backend can not fingerprint)', async () => {
    const stats = { '/s3/a': new FileStat({ name: 'a', type: FileType.FILE, fingerprint: null }) }
    const mount = makeMount('/s3/', true)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/s3/a', 'fp-snap'),
    ).resolves.toBeUndefined()
  })

  it('no-op when mount opts out of snapshot replay', async () => {
    const stats = {
      '/gmail/a': new FileStat({ name: 'a', type: FileType.FILE, fingerprint: 'fp-live' }),
    }
    const mount = makeMount('/gmail/', false)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/gmail/a', 'fp-snap'),
    ).resolves.toBeUndefined()
  })
})

describe('installDriftState under DriftPolicy.OFF', () => {
  it('evicts the snapshot bytes before it returns', () => {
    // fromState is sync, so a fire-and-forget remove() would let the
    // very next read be served the bytes OFF exists to bypass.
    const evicted: string[] = []
    const cache = {
      evictPaths: (paths: Iterable<string>): void => {
        evicted.push(...paths)
      },
    }
    const drift = new DriftQueue()
    installDriftState(
      { tryMountFor: () => null, allMounts: () => [] },
      cache,
      drift,
      {
        fingerprints: [
          { path: '/d/a.txt', mount_prefix: '/d', fingerprint: 'f1' },
          { path: '/d/b.txt', mount_prefix: '/d', fingerprint: 'f2' },
        ],
      },
      DriftPolicy.OFF,
    )
    expect(evicted).toEqual(['/d/a.txt', '/d/b.txt'])
    expect(drift.pending).toBe(false)
  })
})

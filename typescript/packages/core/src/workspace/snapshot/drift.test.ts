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
import { OpRecord } from '../../observe/record.ts'
import type { Resource } from '../../resource/base.ts'
import { FileStat } from '../../types.ts'
import type { Mount } from '../mount/mount.ts'
import {
  captureFingerprints,
  checkDrift,
  ContentDriftError,
  liveOnlyMountPrefixes,
} from './drift.ts'

interface RegistryLike {
  mountFor(path: string): Mount | null
  allMounts(): readonly Mount[]
}

function makeMount(prefix: string, supportsSnapshot: boolean): Mount {
  const resource: Resource = {
    kind: 's3',
    supportsSnapshot,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  const m: Partial<Mount> & {
    prefix: string
    resource: Resource
    revisions: Map<string, string>
  } = {
    prefix,
    resource,
    revisions: new Map(),
  }
  return m as Mount
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

function makeRegistry(mounts: Mount[]): RegistryLike {
  return {
    mountFor: (path: string): Mount | null => {
      for (const m of mounts) {
        if (path.startsWith(m.prefix.replace(/\/$/, ''))) return m
      }
      return null
    },
    allMounts: () => mounts,
  }
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
      { path: '/s3/a', mountPrefix: '/s3/', fingerprint: 'fp-a' },
      { path: '/s3/b', mountPrefix: '/s3/', fingerprint: 'fp-b', revision: 'rev-b' },
    ])
  })

  it('deduplicates by path; first read wins', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints(
      [makeRecord('/s3/a', 'fp-old'), makeRecord('/s3/a', 'fp-new')],
      registry,
    )
    expect(entries.length).toBe(1)
    expect(entries[0]?.fingerprint).toBe('fp-old')
  })

  it('skips reads with neither fingerprint nor revision', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints([makeRecord('/s3/a')], registry)
    expect(entries.length).toBe(0)
  })

  it('skips non-read ops', () => {
    const mount = makeMount('/s3/', true)
    const registry = makeRegistry([mount])
    const writeRec = new OpRecord({
      op: 'write',
      path: '/s3/a',
      source: 's3',
      bytes: 1,
      timestamp: 0,
      durationMs: 0,
      fingerprint: 'fp-a',
    })
    expect(captureFingerprints([writeRec], registry).length).toBe(0)
  })

  it('skips mounts that opt out of snapshot replay', () => {
    const mount = makeMount('/gmail/', false)
    const registry = makeRegistry([mount])
    const entries = captureFingerprints([makeRecord('/gmail/inbox/1', 'fp-1')], registry)
    expect(entries.length).toBe(0)
  })
})

describe('liveOnlyMountPrefixes', () => {
  it('returns prefixes of mounts that opt out of snapshot replay', () => {
    const s3 = makeMount('/s3/', true)
    const gmail = makeMount('/gmail/', false)
    const registry = makeRegistry([s3, gmail])
    expect(liveOnlyMountPrefixes(registry)).toEqual(['/gmail/'])
  })

  it('excludes infrastructure prefixes /dev/ and /.sessions/', () => {
    const dev = makeMount('/dev/', false)
    const sessions = makeMount('/.sessions/', false)
    const registry = makeRegistry([dev, sessions])
    expect(liveOnlyMountPrefixes(registry)).toEqual([])
  })
})

describe('checkDrift', () => {
  it('no-op when live fingerprint matches recorded', async () => {
    const stats = { '/s3/a': new FileStat({ name: 'a', fingerprint: 'fp-a' }) }
    const mount = makeMount('/s3/', true)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/s3/a', 'fp-a'),
    ).resolves.toBeUndefined()
  })

  it('throws ContentDriftError when live differs from recorded', async () => {
    const stats = { '/s3/a': new FileStat({ name: 'a', fingerprint: 'fp-live' }) }
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
    const stats = { '/s3/a': new FileStat({ name: 'a', fingerprint: null }) }
    const mount = makeMount('/s3/', true)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/s3/a', 'fp-snap'),
    ).resolves.toBeUndefined()
  })

  it('no-op when mount opts out of snapshot replay', async () => {
    const stats = { '/gmail/a': new FileStat({ name: 'a', fingerprint: 'fp-live' }) }
    const mount = makeMount('/gmail/', false)
    await expect(
      checkDrift(makeRegistry([mount]), makeStatFn(stats), '/gmail/a', 'fp-snap'),
    ).resolves.toBeUndefined()
  })
})

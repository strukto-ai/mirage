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

import {
  IndexType,
  type IndexConfig,
  type RedisIndexConfig,
} from '@struktoai/mirage-core/cache/index/config'
import {
  type ReadSpec,
  DEFAULT_READ_TTL,
  MountMode,
  ReadPolicy,
} from '@struktoai/mirage-core/types'

const FRESH: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
const BOUNDED: ReadSpec = { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL }
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { applyIo } from '@struktoai/mirage-core/cache/file/io'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { Workspace } from '../../workspace.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'
import { S3VFS } from './s3.ts'

const BUCKET = 'cons-bucket'
const CHILD_BUCKET = 'cons-child-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

describe('S3 cache consistency (mocked)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
  })

  beforeEach(() => {
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v1'))
  })

  afterEach(() => {
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
  })

  afterAll(() => {
    mock.restore()
  })

  for (const type of [IndexType.RAM, IndexType.REDIS]) {
    it
      .skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined)
      .each(['shell', 'fs'])(`ALWAYS checks a warm ${type} index via %s`, async (surface) => {
      const index: IndexConfig | RedisIndexConfig =
        type === IndexType.REDIS
          ? {
              type,
              ...(process.env.REDIS_URL === undefined ? {} : { url: process.env.REDIS_URL }),
              keyPrefix: `consistency:${crypto.randomUUID()}:`,
            }
          : { type }
      const ws = new Workspace(
        { '/s3/': new S3VFS(makeConfig()) },
        {
          mode: MountMode.WRITE,
          read: FRESH,
          index,
        },
      )
      const store = ws.mount('/s3/').indexStore
      try {
        expect((await ws.shell('ls /s3/')).exitCode).toBe(0)
        expect((await store.get('/s3/c.txt')).entry).toBeDefined()
        expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
        expect(await ws.cache.exists('/s3/c.txt')).toBe(true)
        mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
        if (surface === 'shell') {
          expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v2')
        } else {
          expect(DEC.decode(await ws.vfs.read('/s3/c.txt'))).toBe('v2')
        }
        mock.store.objects(BUCKET).delete('c.txt')
        if (surface === 'shell') {
          const result = await ws.shell('cat /s3/c.txt')
          expect(result.exitCode).toBe(1)
          expect(result.stdout.byteLength).toBe(0)
        } else {
          await expect(ws.vfs.read('/s3/c.txt')).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        await store.clear()
        await ws.close()
      }
    })
  }

  it('fresh re-list keeps the deletion baseline after stat', async () => {
    mock.store.set(BUCKET, 'sub/a', ENC.encode('a'))
    mock.store.set(BUCKET, 'sub/b', ENC.encode('b'))
    const ws = new Workspace({ '/s3': new S3VFS(makeConfig()) }, { read: FRESH })
    try {
      for (const command of ['ls /s3/sub', 'cat /s3/sub/a', 'ls /s3']) {
        expect((await ws.shell(command)).exitCode).toBe(0)
      }
      await ws.namespace.setAttrs('/s3/sub/a', { mode: 0o600 })
      expect(await ws.cache.exists('/s3/sub/a')).toBe(true)
      mock.store.objects(BUCKET).delete('sub/a')
      expect(DEC.decode((await ws.shell('ls /s3/sub')).stdout)).toBe('b\n')
      expect(await ws.cache.exists('/s3/sub/a')).toBe(false)
      expect(ws.namespace.metaFor('/s3/sub/a')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('fresh revalidates a walk and a glob, not just a named operand', async () => {
    // The second door, the one every shell read uses. A recursive walk and
    // a glob never named their files as operands, so the registry's
    // pre-command reconcile never saw them. Warming has to go through
    // `cat`: `grep -r` fills no file cache of its own, so warming with it
    // would leave the cache empty and this would pass either way.
    mock.store.set(BUCKET, 'walk/a.txt', ENC.encode('v1\n'))
    mock.store.set(BUCKET, 'walk/b.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /s3/walk/a.txt')
      await ws.shell('cat /s3/walk/b.txt')
      mock.store.set(BUCKET, 'walk/b.txt', ENC.encode('v2\n'))
      expect(DEC.decode((await ws.shell('grep -r v /s3/walk/')).stdout)).toBe(
        '/s3/walk/a.txt:v1\n/s3/walk/b.txt:v2\n',
      )
      expect(DEC.decode((await ws.shell('cat /s3/walk/*.txt')).stdout)).toBe('v1\nv2\n')
    } finally {
      await ws.close()
    }
  })

  it('a walk costs one backend stat per file', async () => {
    // Zero without the gate: the walk never revalidated at all. This is the
    // assertion that distinguishes this PR from base, where the named-operand
    // cost does not.
    //
    // Three, not two: the two files plus the directory operand's own stat.
    // The python twin walks the mount root instead, where there is no
    // operand to stat, so its number is 2 for the same two files -- verified
    // that both languages cost 3 for this same subdirectory shape.
    mock.store.set(BUCKET, 'cost/a.txt', ENC.encode('v1\n'))
    mock.store.set(BUCKET, 'cost/b.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /s3/cost/a.txt')
      await ws.shell('cat /s3/cost/b.txt')
      mock.resetCalls()
      expect((await ws.shell('grep -r v /s3/cost/')).exitCode).toBe(0)
      expect(mock.commandCalls(HeadObjectCommand)).toBe(3)
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('a fan-out revalidates a descendant mount', async () => {
    // The fan-out calls mount.runCommand per leg, bypassing the registry's
    // pre-command reconcile entirely, so before the gate a descendant
    // mount's cached bytes were never revalidated at all.
    mock.store.set(BUCKET, 'p.txt', ENC.encode('v1\n'))
    mock.store.set(CHILD_BUCKET, 'c.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      {
        '/x/': new S3VFS(makeConfig()),
        '/x/y/': new S3VFS({ ...makeConfig(), bucket: CHILD_BUCKET }),
      },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /x/p.txt')
      await ws.shell('cat /x/y/c.txt')
      mock.store.set(BUCKET, 'p.txt', ENC.encode('v2\n'))
      mock.store.set(CHILD_BUCKET, 'c.txt', ENC.encode('v2\n'))
      const out = DEC.decode((await ws.shell('grep -r v /x/')).stdout)
      expect(out).toContain('/x/p.txt:v2')
      expect(out).toContain('/x/y/c.txt:v2')
    } finally {
      await ws.close()
    }
  })

  // #1101 Design §2: a read policy belongs to the mount. After an out-of-band
  // change, one line over a fresh and a bounded mount must print v2 and v1,
  // and only the fresh leg may reach the backend. The python twin in
  // test_fingerprint_spike.py says what each parameter tells apart.
  const SHAPES = {
    siblings: ['/a', '/b', 'grep -r v /a/ /b/'],
    nested: ['/x', '/x/y', 'grep -r v /x/'],
    'shared-vfs': ['/a', '/b', 'grep -r v /a/ /b/'],
  } as const
  const GRID = Object.keys(SHAPES).flatMap((shape) =>
    (['first', 'second'] as const).flatMap((freshSide) =>
      [ReadPolicy.FRESH, ReadPolicy.BOUNDED].map(
        (fallback) => [shape as keyof typeof SHAPES, freshSide, fallback] as const,
      ),
    ),
  )
  it.each(GRID)(
    'one line serves each mount under its own policy (%s, fresh %s, default %s)',
    async (shape, freshSide, fallback) => {
      const [first, second, line] = SHAPES[shape]
      const [fresh, bounded] = freshSide === 'first' ? [first, second] : [second, first]
      mock.store.set('fresh-bkt', 'f.txt', ENC.encode('v1\n'))
      mock.store.set('bounded-bkt', 'f.txt', ENC.encode('v1\n'))
      const freshVfs = new S3VFS({ ...makeConfig(), bucket: 'fresh-bkt' })
      const boundedVfs =
        shape === 'shared-vfs' ? freshVfs : new S3VFS({ ...makeConfig(), bucket: 'bounded-bkt' })
      const mount = (vfs: S3VFS, read: ReadSpec): Mount =>
        read.policy === fallback
          ? new Mount(vfs, { mode: MountMode.WRITE })
          : new Mount(vfs, { mode: MountMode.WRITE, read })
      const ws = new Workspace(
        {
          [`${fresh}/`]: mount(freshVfs, FRESH),
          [`${bounded}/`]: mount(boundedVfs, { policy: ReadPolicy.BOUNDED, ttl: 900 }),
        },
        { mode: MountMode.WRITE, read: { policy: fallback, ttl: DEFAULT_READ_TTL } },
      )
      try {
        await ws.shell(`ls ${first}/ ${second}/`)
        await ws.shell(`cat ${first}/f.txt`)
        await ws.shell(`cat ${second}/f.txt`)
        mock.store.set('fresh-bkt', 'f.txt', ENC.encode('v2\n'))
        mock.store.set('bounded-bkt', 'f.txt', ENC.encode('v2\n'))
        mock.resetCalls()
        const mark = ws.networkRecords.length
        const result = await ws.shell(line)
        const version = (prefix: string): string => (prefix === fresh ? 'v2' : 'v1')
        expect(result.exitCode).toBe(0)
        expect(DEC.decode(result.stdout)).toBe(
          `${first}/f.txt:${version(first)}\n${second}/f.txt:${version(second)}\n`,
        )
        const ledger = (Bucket: string): number[] => [
          mock.commandCalls(ListObjectsV2Command, { Bucket }),
          mock.commandCalls(HeadObjectCommand, { Bucket }),
          mock.commandCalls(GetObjectCommand, { Bucket }),
        ]
        // Any send here means the fresh mount's policy reached the bounded one.
        expect(ledger('bounded-bkt')).toEqual([0, 0, 0])
        // The fresh leg re-lists its folder once (Task 1.2: fresh checks
        // listings too), pays its gate probe and one refetch; a missing HEAD
        // means it was served without a check.
        expect(ledger('fresh-bkt')).toEqual([1, 1, 1])
        expect(ws.networkRecords.slice(mark).map((r) => [r.op, r.path])).toEqual([
          ['read', `${fresh}/f.txt`],
        ])
        mock.resetCalls()
        const single = await ws.shell(`cat ${bounded}/f.txt`)
        expect(DEC.decode(single.stdout)).toBe('v1\n')
        // v2 or any send here means the routing door read another policy.
        expect([...ledger('fresh-bkt'), ...ledger('bounded-bkt')]).toEqual([0, 0, 0, 0, 0, 0])
      } finally {
        await ws.close()
      }
    },
  )

  it('a snapshot-false mount still serves a verified cache', async () => {
    // The supportsSnapshot short-circuit is gone and must stay gone: it
    // dropped every cached copy on a mount declaring the flag false without
    // probing, though this mount's stat and read tokens are both the ETag.
    // Restoring it turns GetObject from 0 to 1, so the GET is the assertion
    // that matters; the stat count moves for unrelated reasons.
    class SnapshotFalseS3 extends S3VFS {
      override readonly supportsSnapshot: boolean = false
    }
    const ws = new Workspace(
      { '/s3/': new SnapshotFalseS3(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /s3/c.txt')
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('a tokenless entry costs one extra GET, then carries the ETag', async () => {
    // The measured price of storing no token instead of a fabricated md5.
    // On s3 the ETag of a simple unencrypted PUT *is* md5(content), so the
    // old fallback was a valid validator there -- the one backend where it
    // was. An entry that reaches the cache with no token can no longer
    // claim freshness, so the next read under `fresh` refetches once; after
    // that it carries the backend's own ETag and the read after it is
    // served from cache. The python twin is in test_fingerprint_spike.py,
    // where `Workspace.applyIo` is public; here the seed goes through
    // core's applyIo on the same cache.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await applyIo(
        ws.cache,
        new IOResult({ reads: { '/s3/c.txt': ENC.encode('v1') }, cache: ['/s3/c.txt'] }),
      )
      expect(await ws.cache.isFresh('/s3/c.txt', 'anything')).toBe(false)
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(GetObjectCommand)).toBe(1)
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
      // No assertion here about *which* token the refetch stamped: this
      // mock builds its ETag as md5(content) with an empty suffix, so the
      // backend's token and a fabricated md5 are the same string and the
      // claim cannot be tested on this fixture. It is pinned where the
      // suffix makes the two distinguishable -- write_fingerprint.test.ts.
    } finally {
      await ws.close()
    }
  })

  it('a key named like its mount is served from cache on the second read', async () => {
    // The cache matches the read record's path, so `/m/a.txt` would refetch.
    mock.store.set(BUCKET, 'm/a.txt', ENC.encode('v1'))
    const ws = new Workspace(
      { '/m': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /m/m/a.txt')).stdout)).toBe('v1')
      expect(DEC.decode((await ws.shell('cat /m/m/a.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(GetObjectCommand)).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('a warm read costs one probe', async () => {
    // A warm `cat` is one stat: the routing reconcile. cat's own operand stat
    // and the gate both reuse its answer for the rest of the command, so a
    // count cannot tell the gate on from off here; the gate's own reach -- the
    // reads routing never sees -- is pinned by 'fresh revalidates a walk and a
    // glob, not just a named operand'. Counting starts after the warm-up,
    // because a cold+warm total is the same either way.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /s3/c.txt')
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(HeadObjectCommand)).toBe(1)
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    } finally {
      await ws.close()
    }
  })

  // s3 and gridfs register their own stat rather than the generic's, so they
  // get the probe answer only if the override's adapter carries it: one HEAD,
  // the routing reconcile, where it cost two. The answer is served below every
  // guard: a trailing slash still refuses, and `nope/..` -- a directory only
  // the walk guard proves missing -- still answers ENOENT, as GNU does.
  for (const [line, code, out, err] of [
    ['stat -c %s /s3/c.txt', 0, '2\n', ''],
    ['stat /s3/c.txt/', 1, '', 'Not a directory'],
    ['stat -c %s /s3/nope/../c.txt', 1, '', 'No such file or directory'],
  ] as const) {
    it(`a warm keyed-store stat reuses the probe: ${line}`, async () => {
      const ws = new Workspace(
        { '/s3/': new S3VFS(makeConfig()) },
        { mode: MountMode.WRITE, read: FRESH },
      )
      try {
        await ws.shell('cat /s3/c.txt')
        mock.resetCalls()
        const result = await ws.shell(line)
        expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([code, out])
        expect(DEC.decode(result.stderr)).toContain(err)
        if (code === 0) expect(mock.commandCalls(HeadObjectCommand)).toBe(1)
      } finally {
        await ws.close()
      }
    })
  }

  it('bounded keeps serving the cached bytes after an out-of-band change', async () => {
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: BOUNDED },
    )
    const first = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(first.stdout)).toBe('v1')
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
    mock.resetCalls()
    const second = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(second.stdout)).toBe('v1')
    // One HEAD, and it is the operand's own stat, not a revalidation --
    // `cat` stats what it is given whatever the policy. No GET is the
    // half that matters: the bytes came from the cache. Serving 'v1'
    // alone would also be what a revalidation that fetched and compared
    // produced, so the count is what distinguishes them.
    expect(mock.commandCalls(HeadObjectCommand)).toBe(1)
    expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    await ws.close()
  })
  it('a walk under bounded costs no per-file stat', async () => {
    // The other side of 'a walk costs one backend stat per file'. The
    // same shape under `fresh` is 3: the directory operand's own stat
    // plus one per file. Under `bounded` only the operand's stat is
    // paid, so the two per-file revalidations are exactly what the
    // policy buys -- which is a claim only a call count can make.
    mock.store.set(BUCKET, 'bcost/a.txt', ENC.encode('v1\n'))
    mock.store.set(BUCKET, 'bcost/b.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: BOUNDED },
    )
    try {
      await ws.shell('cat /s3/bcost/a.txt')
      await ws.shell('cat /s3/bcost/b.txt')
      mock.resetCalls()
      expect((await ws.shell('grep -r v /s3/bcost/')).exitCode).toBe(0)
      expect(mock.commandCalls(HeadObjectCommand)).toBe(1)
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('keeps text content metadata after tee and touch', async () => {
    const ws = new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode: MountMode.WRITE })
    try {
      const result = await ws.shell('tee /s3/c.txt <<< x; touch /s3/c.txt; stat /s3/c.txt')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toMatch(/File: .*c\.txt\n {2}Size: 2 /)
      expect(DEC.decode(result.stdout)).toContain('regular file')
      expect(await ws.stat('/s3/c.txt')).toMatchObject({ content: 'text' })
    } finally {
      await ws.close()
    }
  })

  it('a routing probe failure never takes the line', async () => {
    // reconcileRead probes a warm named operand at routing, before any
    // handler exists. If that probe threw, the whole line would fail --
    // later `;` stages included -- with no operand named. It is best-effort
    // instead: the entry is dropped and the command reads the backend
    // itself, so `ls` lists, `cat` prints current bytes, and the stage
    // after the `;` still runs.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await ws.shell('cat /s3/c.txt')
      const mount = ws.mount('/s3')
      const real = mount.callOp.bind(mount)
      vi.spyOn(mount, 'callOp').mockImplementation((...args) =>
        args[0] === 'stat' ? Promise.reject(new TypeError('probe bug')) : real(...args),
      )
      const ls = await ws.shell('ls -l /s3/c.txt; echo survived')
      expect(ls.exitCode).toBe(0)
      expect(DEC.decode(ls.stdout).endsWith('/s3/c.txt\nsurvived\n')).toBe(true)
      const cat = await ws.shell('cat /s3/c.txt; echo survived')
      expect(cat.exitCode).toBe(0)
      expect(DEC.decode(cat.stdout)).toBe('v1survived\n')
      expect(warn.mock.calls.length > 0).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await ws.close()
    }
  })

  it('a metadata command reconciles its operand', async () => {
    // `ls` reads no bytes, so the cache gate never fires for it. Routing is
    // the one door a metadata command has to backend truth and must keep
    // probing there. The stat count cannot show it any more: ls's own operand
    // stat serves the routing probe's answer, so a warm `ls -l` is the probe
    // plus ls's readdir check of its operand, and with routing dark it is
    // ls's stat plus that same check -- two either way. What only the routing
    // probe does is evict a copy the backend replaced, so that is what this
    // pins.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, read: FRESH },
    )
    try {
      await ws.shell('cat /s3/c.txt')
      mock.resetCalls()
      expect((await ws.shell('ls -l /s3/c.txt')).exitCode).toBe(0)
      expect(await ws.cache.exists('/s3/c.txt')).toBe(true)
      mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
      expect((await ws.shell('ls -l /s3/c.txt')).exitCode).toBe(0)
      expect(await ws.cache.exists('/s3/c.txt')).toBe(false)
      expect(mock.commandCalls(HeadObjectCommand)).toBe(4)
    } finally {
      await ws.close()
    }
  })
})

describe('S3 listing lifetime: workspace index ttl meets the mount ttl', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
  })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mock.store.set(BUCKET, 'lt/a.txt', ENC.encode('a'))
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
  })

  afterAll(() => {
    mock.restore()
  })

  function ws(indexTtl: number, mountTtl: number): Workspace {
    return new Workspace(
      {
        '/s3/': new Mount(new S3VFS(makeConfig()), {
          mode: MountMode.WRITE,
          read: { policy: ReadPolicy.BOUNDED, ttl: mountTtl },
        }),
      },
      { index: { type: IndexType.RAM, ttl: indexTtl } },
    )
  }

  async function ls(w: Workspace): Promise<string> {
    const result = await w.shell('ls /s3/lt/')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
    return DEC.decode(result.stdout)
  }

  it('caps a day-long index at a two-second mount', async () => {
    const w = ws(86400, 2)
    try {
      expect(await ls(w)).toBe('a.txt\n')
      mock.store.set(BUCKET, 'lt/b.txt', ENC.encode('b'))
      const t0 = Date.now()
      // A warm `ls` still pays one LIST: the operand's own directory probe.
      mock.resetCalls()
      expect(await ls(w)).toBe('a.txt\n')
      const warm = mock.commandCalls(ListObjectsV2Command)
      mock.resetCalls()
      vi.setSystemTime(t0 + 1000)
      expect(await ls(w)).toBe('a.txt\n')
      expect(mock.commandCalls(ListObjectsV2Command)).toBe(warm)
      mock.resetCalls()
      vi.setSystemTime(t0 + 3000)
      expect(await ls(w)).toBe('a.txt\nb.txt\n')
      expect(mock.commandCalls(ListObjectsV2Command)).toBe(warm + 1)
    } finally {
      await w.close()
    }
  })

  it('keeps a shorter workspace index lifetime under a longer mount ttl', async () => {
    const w = ws(5, 600)
    try {
      expect(await ls(w)).toBe('a.txt\n')
      mock.store.set(BUCKET, 'lt/b.txt', ENC.encode('b'))
      vi.setSystemTime(Date.now() + 6000)
      expect(await ls(w)).toBe('a.txt\nb.txt\n')
    } finally {
      await w.close()
    }
  })
})

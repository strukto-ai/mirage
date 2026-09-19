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
import { ConsistencyPolicy, MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
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
      const vfs = new S3VFS(makeConfig())
      const ws = new Workspace(
        { '/s3/': vfs },
        {
          mode: MountMode.WRITE,
          consistency: ConsistencyPolicy.ALWAYS,
          index,
        },
      )
      try {
        expect((await ws.shell('ls /s3/')).exitCode).toBe(0)
        expect((await vfs.index.get('/s3/c.txt')).entry).toBeDefined()
        expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
        expect(await ws.cache.exists('/s3/c.txt')).toBe(true)
        mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
        if (surface === 'shell') {
          expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v2')
        } else {
          expect(DEC.decode(await ws.vfs.readFile('/s3/c.txt'))).toBe('v2')
        }
        mock.store.objects(BUCKET).delete('c.txt')
        if (surface === 'shell') {
          const result = await ws.shell('cat /s3/c.txt')
          expect(result.exitCode).toBe(1)
          expect(result.stdout.byteLength).toBe(0)
        } else {
          await expect(ws.vfs.readFile('/s3/c.txt')).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        await vfs.index.clear()
        await ws.close()
      }
    })
  }

  it('ALWAYS revalidates a walk and a glob, not just a named operand', async () => {
    // The second door, the one every shell read uses. A recursive walk and
    // a glob never named their files as operands, so the registry's
    // pre-command reconcile never saw them. Warming has to go through
    // `cat`: `grep -r` fills no file cache of its own, so warming with it
    // would leave the cache empty and this would pass either way.
    mock.store.set(BUCKET, 'walk/a.txt', ENC.encode('v1\n'))
    mock.store.set(BUCKET, 'walk/b.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
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
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
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
    // The fan-out calls mount.executeCmd per leg, bypassing the registry's
    // pre-command reconcile entirely, so before the gate a descendant
    // mount's cached bytes were never revalidated at all.
    mock.store.set(BUCKET, 'p.txt', ENC.encode('v1\n'))
    mock.store.set(CHILD_BUCKET, 'c.txt', ENC.encode('v1\n'))
    const ws = new Workspace(
      {
        '/x/': new S3VFS(makeConfig()),
        '/x/y/': new S3VFS({ ...makeConfig(), bucket: CHILD_BUCKET }),
      },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
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

  it('a metadata command keeps its own reconcile', async () => {
    // `ls` reads no bytes, so the gate never fires for it and the registry's
    // pre-command reconcile must not be skipped.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
    )
    try {
      await ws.shell('cat /s3/c.txt')
      mock.resetCalls()
      expect((await ws.shell('ls -l /s3/c.txt')).exitCode).toBe(0)
      expect(mock.commandCalls(HeadObjectCommand)).toBe(3)
    } finally {
      await ws.close()
    }
  })

  it('a warm read probes once, not twice', async () => {
    // Cost is the contract. `cat` stats its own operand before reading it,
    // so a warm read costs two HeadObjects: that stat plus the gate's
    // probe. Three means the registry reconciled an operand the gate was
    // going to probe anyway. Counting starts after the warm-up, because a
    // cold+warm total is the same number with and without the gate.
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
    )
    try {
      await ws.shell('cat /s3/c.txt')
      mock.resetCalls()
      expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
      expect(mock.commandCalls(HeadObjectCommand)).toBe(2)
      expect(mock.commandCalls(GetObjectCommand)).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('LAZY keeps serving the cached bytes after an out-of-band change', async () => {
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.LAZY },
    )
    const first = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(first.stdout)).toBe('v1')
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
    const second = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(second.stdout)).toBe('v1')
    await ws.close()
  })
  it('keeps stat type=text after tee and touch', async () => {
    const ws = new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode: MountMode.WRITE })
    try {
      const result = await ws.shell('tee /s3/c.txt <<< x; touch /s3/c.txt; stat /s3/c.txt')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toContain('name=c.txt size=2')
      expect(DEC.decode(result.stdout)).toContain('type=text')
    } finally {
      await ws.close()
    }
  })
})

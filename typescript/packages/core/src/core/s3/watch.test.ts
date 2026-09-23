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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, loadS3Module: vi.fn(), withClient: vi.fn() }
})

import { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { FileChangeKind, PathSpec, type WalkEntry } from '../../types.ts'
import * as clientMod from './client.ts'
import { buildDeltaHook, S3Walk } from './watch.ts'

class FakeCommand {
  constructor(readonly input: unknown) {}
}

interface StoredObject {
  key: string
  size: number
  etag: string
  modified?: Date | string
}

function mockListing(objects: StoredObject[]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    ListObjectsV2Command: FakeCommand,
  } as never)
  vi.mocked(clientMod.withClient).mockImplementation(async (_config, fn) => {
    const client = {
      send: () =>
        Promise.resolve({
          Contents: objects.map((obj) => ({
            Key: obj.key,
            Size: obj.size,
            LastModified: obj.modified ?? new Date('2026-03-31T00:00:00.000Z'),
            ETag: `"${obj.etag}"`,
          })),
          IsTruncated: false,
        }),
    }
    return (await fn(client as never)) as never
  })
}

function accessor(keyPrefix?: string): S3Accessor {
  return new S3Accessor({
    bucket: 'watch-bucket',
    region: 'us-east-1',
    keyPrefix,
  } as S3Config)
}

function root(virtual: string, vfsPath: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

async function collect(walk: S3Walk, spec: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(spec)) out.push(entry)
  return out
}

describe('S3Walk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('leads each file fingerprint with the ETag', async () => {
    mockListing([
      { key: 'data/a.txt', size: 5, etag: 'etag-a' },
      { key: 'data/b.txt', size: 4, etag: 'etag-b' },
    ])
    const entries = await collect(new S3Walk(accessor()), root('/s3/data', 'data'))
    const files = entries.filter((e) => !e.isDir)
    expect(files.map((e) => e.virtual).sort()).toEqual(['/s3/data/a.txt', '/s3/data/b.txt'])
    // The ETag leads the composite, which is what keeps two files of equal
    // size apart: LastModified is constant here, so the size alone would
    // collide across them.
    expect(files[0]?.fingerprint).toBe('etag-a|5')
    expect(files[1]?.fingerprint).toBe('etag-b|4')
    expect(files[0]?.size).toBe(5)
  })

  it('synthesizes intermediate directories', async () => {
    mockListing([{ key: 'data/sub/deep/x.txt', size: 1, etag: 'etag-x' }])
    const entries = await collect(new S3Walk(accessor()), root('/s3/data', 'data'))
    expect(entries.filter((e) => e.isDir).map((e) => e.virtual)).toEqual([
      '/s3/data/sub/deep',
      '/s3/data/sub',
    ])
  })

  it('reports an explicit marker as its own directory', async () => {
    mockListing([{ key: 'data/empty/', size: 0, etag: 'etag-marker' }])
    const entries = await collect(new S3Walk(accessor()), root('/s3/data', 'data'))
    expect(entries.filter((e) => e.isDir).map((e) => e.virtual)).toEqual(['/s3/data/empty'])
    expect(entries.filter((e) => !e.isDir)).toEqual([])
  })

  it('strips the key prefix', async () => {
    mockListing([{ key: 'team/x/data/a.txt', size: 5, etag: 'etag-a' }])
    const entries = await collect(new S3Walk(accessor('team/x/')), root('/s3/data', 'data'))
    expect(entries.filter((e) => !e.isDir).map((e) => e.virtual)).toEqual(['/s3/data/a.txt'])
  })
})

describe('s3 delta hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.123Z'])(
    'preserves persisted fallback fingerprints for %s',
    async (stamp) => {
      mockListing([{ key: 'a.txt', size: 5, etag: '', modified: new Date(stamp) }])
      const checkpoint = JSON.stringify({ '/s3/a.txt': `${stamp}|5` })
      const hook = buildDeltaHook(accessor())
      const spec = root('/s3', '')
      const unchanged = await hook.pull(spec, checkpoint)
      expect(unchanged.changes).toEqual([])
      expect(unchanged.checkpoint).toBe(checkpoint)
      mockListing([
        { key: 'a.txt', size: 5, etag: '', modified: new Date(Date.parse(stamp) + 1000) },
      ])
      const changed = await hook.pull(spec, checkpoint)
      expect(changed.changes.map((c) => c.kind)).toEqual([FileChangeKind.UPDATE])
    },
  )

  it('reports nothing on the baseline pull, then create and update', async () => {
    mockListing([{ key: 'data/a.txt', size: 5, etag: 'etag-a' }])
    const hook = buildDeltaHook(accessor())
    const spec = root('/s3/data', 'data')
    const first = await hook.pull(spec, null)
    expect(first.changes).toEqual([])

    mockListing([
      { key: 'data/a.txt', size: 5, etag: 'etag-a2' },
      { key: 'data/new.txt', size: 3, etag: 'etag-new' },
    ])
    const second = await hook.pull(spec, first.checkpoint)
    expect(Object.fromEntries(second.changes.map((c) => [c.path.virtual, c.kind]))).toEqual({
      '/s3/data/a.txt': FileChangeKind.UPDATE,
      '/s3/data/new.txt': FileChangeKind.CREATE,
    })
  })

  it('detects a delete', async () => {
    mockListing([
      { key: 'data/a.txt', size: 5, etag: 'etag-a' },
      { key: 'data/b.txt', size: 4, etag: 'etag-b' },
    ])
    const hook = buildDeltaHook(accessor())
    const spec = root('/s3/data', 'data')
    const first = await hook.pull(spec, null)

    mockListing([{ key: 'data/a.txt', size: 5, etag: 'etag-a' }])
    const second = await hook.pull(spec, first.checkpoint)
    expect(second.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.DELETE, '/s3/data/b.txt'],
    ])
  })

  it('treats a rewrite of identical bytes as no change', async () => {
    mockListing([{ key: 'data/a.txt', size: 5, etag: 'etag-a' }])
    const hook = buildDeltaHook(accessor())
    const spec = root('/s3/data', 'data')
    const first = await hook.pull(spec, null)
    const second = await hook.pull(spec, first.checkpoint)
    expect(second.changes).toEqual([])
  })

  it('frames a changed path against the mount', async () => {
    mockListing([{ key: 'data/a.txt', size: 5, etag: 'etag-a' }])
    const hook = buildDeltaHook(accessor())
    const spec = root('/s3/data', 'data')
    const first = await hook.pull(spec, null)
    mockListing([{ key: 'data/a.txt', size: 5, etag: 'etag-a2' }])
    const second = await hook.pull(spec, first.checkpoint)
    expect(second.changes[0]?.path.virtual).toBe('/s3/data/a.txt')
    expect(second.changes[0]?.path.vfsPath).toBe('data/a.txt')
  })
})

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
  return { ...actual, loadS3Module: vi.fn(), createS3Client: vi.fn() }
})

import type { FindOptions } from '../../vfs/base.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { S3Accessor } from '../../accessor/s3.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './client.ts'
import { find } from './find.ts'

class FakeCommand {
  constructor(readonly input: unknown) {}
}

function mockListing(keys: [string, number][]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    ListObjectsV2Command: FakeCommand,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: () =>
      Promise.resolve({
        Contents: keys.map(([key, size]) => ({ Key: key, Size: size })),
        IsTruncated: false,
      }),
  } as never)
}

function spec(vfsPath: string): PathSpec {
  if (vfsPath !== '') {
    return new PathSpec({
      vfsPath,
      virtual: '/mnt/' + vfsPath,
      directory: '/mnt/',
    })
  }
  return new PathSpec({ vfsPath: '', virtual: '/mnt', directory: '/' })
}

function runFind(
  keys: [string, number][],
  options: FindOptions = {},
  vfsPath = 'data',
): Promise<string[]> {
  mockListing(keys)
  const accessor = new S3Accessor({ bucket: 'b' } as S3Config)
  return find(accessor, spec(vfsPath), options)
}

describe('s3 core find', () => {
  beforeEach(() => {
    vi.mocked(clientMod.loadS3Module).mockReset()
    vi.mocked(clientMod.createS3Client).mockReset()
  })

  it('synthesizes implicit dirs from key prefixes', async () => {
    await expect(runFind([['data/a/b.txt', 3]], { type: 'd' })).resolves.toEqual([
      '/data',
      '/data/a',
    ])
  })

  it('drops synthesized dirs for -type f', async () => {
    await expect(runFind([['data/a/b.txt', 3]], { type: 'f' })).resolves.toEqual(['/data/a/b.txt'])
  })

  it('gives an orphan marker its parent chain', async () => {
    await expect(runFind([['data/a/b/', 0]], { type: 'd' })).resolves.toEqual([
      '/data',
      '/data/a',
      '/data/a/b',
    ])
  })

  it('emits no duplicates when a marker and files coexist', async () => {
    await expect(
      runFind(
        [
          ['data/a/', 0],
          ['data/a/x.txt', 1],
        ],
        { type: 'd' },
      ),
    ).resolves.toEqual(['/data', '/data/a'])
  })

  it('emits a file shadowed by an implicit dir once', async () => {
    const keys: [string, number][] = [
      ['data/a', 1],
      ['data/a/b.txt', 2],
    ]
    await expect(runFind(keys)).resolves.toEqual(['/data', '/data/a', '/data/a/b.txt'])
    await expect(runFind(keys, { type: 'd' })).resolves.toEqual(['/data', '/data/a'])
    await expect(runFind(keys, { type: 'f' })).resolves.toEqual(['/data/a', '/data/a/b.txt'])
  })

  it('-empty matches a marker-only start dir', async () => {
    await expect(runFind([['data/', 0]], { empty: true })).resolves.toEqual(['/data'])
  })

  it('-empty rejects a populated start dir', async () => {
    await expect(runFind([['data/x.txt', 3]], { empty: true })).resolves.toEqual([])
  })

  it('-empty still matches empty files', async () => {
    await expect(runFind([['data/x.txt', 0]], { empty: true })).resolves.toEqual(['/data/x.txt'])
  })

  it('maxDepth prunes synthesized dirs by depth', async () => {
    await expect(runFind([['data/a/b/c.txt', 1]], { maxDepth: 1 })).resolves.toEqual([
      '/data',
      '/data/a',
    ])
  })

  it('-name matches an implicit dir', async () => {
    await expect(runFind([['data/logs/x.txt', 1]], { name: 'logs' })).resolves.toEqual([
      '/data/logs',
    ])
  })

  it('synthesizes up to the mount root start', async () => {
    await expect(runFind([['a/b.txt', 2]], { type: 'd' }, '')).resolves.toEqual(['/', '/a'])
  })
})

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
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { RedisIndexCacheStore } from '../../cache/index/redis.ts'
import { PathSpec } from '../../types.ts'
import { populateIndex } from './tree.ts'
import { read } from './read.ts'
import { stat } from './stat.ts'
import type { GitHubTreeItem } from './client.ts'

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `github direct lookups with ${backend}`,
    () => {
      for (const truncated of [false, true]) {
        for (const deleted of [false, true]) {
          for (const reader of [stat, read]) {
            it(`${reader.name} refreshes after invalidation (truncated=${String(truncated)}, deleted=${String(deleted)})`, async () => {
              const url = process.env.REDIS_URL
              const index =
                backend === 'ram'
                  ? new RAMIndexCacheStore()
                  : new RedisIndexCacheStore({
                      ...(url === undefined ? {} : { url }),
                      keyPrefix: `github-stat:${crypto.randomUUID()}:`,
                    })
              const oldTree = {
                src: { path: 'src', type: 'tree', sha: 'old-tree', size: null },
                'src/main.py': { path: 'src/main.py', type: 'blob', sha: 'old-blob', size: 3 },
              }
              const folder: GitHubTreeItem = { path: 'src', type: 'tree', sha: 'new-tree' }
              const files: GitHubTreeItem[] = deleted
                ? []
                : [{ path: 'main.py', type: 'blob', sha: 'new-blob', size: 9 }]
              const tree = [folder, ...files.map((file) => ({ ...file, path: `src/${file.path}` }))]
              const get = vi.fn((path: string, params?: Record<string, string>) => {
                if (path.endsWith('/git/blobs/new-blob')) {
                  return Promise.resolve({ content: btoa('new bytes'), encoding: 'base64' })
                }
                if (path.endsWith('/git/trees/main')) {
                  return Promise.resolve({
                    tree: params?.recursive === '1' ? tree : [folder],
                    truncated: false,
                  })
                }
                if (path.endsWith('/git/trees/new-tree')) return Promise.resolve({ tree: files })
                throw new Error(`Unexpected request: ${path}`)
              })
              const accessor = new GitHubAccessor({
                transport: { get, request: vi.fn() },
                owner: 'acme',
                repo: 'proj',
                ref: 'main',
                defaultBranch: 'main',
              })
              accessor.truncated = truncated
              const path = new PathSpec({
                vfsPath: 'src/main.py',
                virtual: '/repo/src/main.py',
                directory: '/repo/src',
              })
              try {
                await populateIndex(index, oldTree, '/repo')
                const cached = await stat(accessor, path, index)
                expect(cached.fingerprint).toBe('old-blob')
                expect(cached.size).toBe(3)
                expect(get).not.toHaveBeenCalled()
                await index.invalidate()
                for (let i = 0; i < 2; i++) {
                  if (deleted) {
                    await expect(reader(accessor, path, index)).rejects.toMatchObject({
                      code: 'ENOENT',
                    })
                  } else if (reader === stat) {
                    const result = await stat(accessor, path, index)
                    expect(result.size).toBe(9)
                    expect(result.fingerprint).toBe('new-blob')
                    expect(result.extra).toEqual({ sha: 'new-blob' })
                  } else {
                    expect(new TextDecoder().decode(await read(accessor, path, index))).toBe(
                      'new bytes',
                    )
                  }
                }
                const trees = get.mock.calls.filter(([p]) => p.includes('/git/trees/'))
                expect(trees.map(([p]) => p.split('/').at(-1))).toEqual(
                  truncated ? ['main', 'new-tree'] : ['main'],
                )
                const blobs = get.mock.calls.filter(([p]) => p.includes('/git/blobs/'))
                expect(blobs).toHaveLength(reader === read && !deleted ? 2 : 0)
              } finally {
                await index.clear()
                await index.close()
              }
            })
          }
        }
      }
    },
  )
}

it('propagates a parent refresh failure', async () => {
  const accessor = new GitHubAccessor({
    transport: {
      get: vi.fn().mockRejectedValue(new Error('github unavailable')),
      request: vi.fn(),
    },
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
  })
  await expect(
    stat(accessor, PathSpec.fromStrPath('/missing.py'), new RAMIndexCacheStore()),
  ).rejects.toThrow('github unavailable')
})

for (const backend of ['ram', 'redis']) {
  it.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `parallel snapshot readers share one replacement with ${backend}`,
    async () => {
      const url = process.env.REDIS_URL
      const index =
        backend === 'ram'
          ? new RAMIndexCacheStore()
          : new RedisIndexCacheStore({
              ...(url === undefined ? {} : { url }),
              keyPrefix: `parallel-github:${crypto.randomUUID()}:`,
            })
      const tree = [{ path: 'a.txt', type: 'blob', sha: 'new', size: 9 }]
      const get = vi.fn(async () => {
        await Promise.resolve()
        return { tree, truncated: false }
      })
      const accessor = new GitHubAccessor({
        transport: { get, request: vi.fn() },
        owner: 'acme',
        repo: 'repo',
        ref: 'main',
        defaultBranch: 'main',
      })
      const path = new PathSpec({
        virtual: '/repo/a.txt',
        directory: '/repo',
        vfsPath: 'a.txt',
      })
      try {
        await populateIndex(
          index,
          { 'a.txt': { path: 'a.txt', type: 'blob', sha: 'old', size: 3 } },
          '/repo',
        )
        await index.invalidate()
        const results = await Promise.all(
          Array.from({ length: 8 }, () => stat(accessor, path, index)),
        )
        expect(results.map((row) => row.fingerprint)).toEqual(
          Array.from({ length: 8 }, () => 'new'),
        )
        expect(get).toHaveBeenCalledTimes(1)
      } finally {
        await index.clear()
        await index.close()
      }
    },
  )
}

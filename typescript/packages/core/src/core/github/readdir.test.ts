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
import { IndexEntry } from '../../cache/index/config.ts'
import { FileType, PathSpec } from '../../types.ts'
import { populateIndex } from './tree.ts'
import { readdir } from './readdir.ts'
import { read } from './read.ts'
import { stat } from './stat.ts'
import type { GitHubTransport } from './client.ts'

const TREE = [
  { path: 'README.md', type: 'blob' as const, sha: 'eee', size: 50 },
  { path: 'src', type: 'tree' as const, sha: 'aaa' },
  { path: 'src/main.py', type: 'blob' as const, sha: 'bbb', size: 120 },
]

function accessorFor(probe: { trees: number }): GitHubAccessor {
  const transport = {
    get: () => {
      probe.trees += 1
      return Promise.resolve({ tree: TREE, truncated: false })
    },
  } as unknown as GitHubTransport
  return new GitHubAccessor({
    transport,
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
  })
}

const TREE_MAP = {
  src: { path: 'src', type: 'tree', sha: 'aaa', size: null },
  'src/main.py': { path: 'src/main.py', type: 'blob', sha: 'bbb', size: 120 },
}

async function seeded(): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await populateIndex(index, TREE_MAP, '')
  return index
}

function spec(p: string): PathSpec {
  return new PathSpec({ vfsPath: p.slice(1), virtual: p, directory: p })
}

describe('github readdir freshness', () => {
  // The index *is* the listing here, seeded once from the recursive tree,
  // so an expired one is a tree that aged out rather than a repository that
  // emptied: before the refill `ls` exited 0 with no output once the
  // day-long TTL lapsed, and reported the mount root missing after a write
  // invalidated it.
  it('refetches the tree when the listing expired', async () => {
    const index = await seeded()
    await index.invalidate()
    const probe = { trees: 0 }
    expect(await readdir(accessorFor(probe), spec('/'), index)).toEqual(['/README.md', '/src'])
    expect(probe.trees).toBe(1)
  })

  it('does not refetch on a real miss', async () => {
    const index = await seeded()
    const probe = { trees: 0 }
    await expect(readdir(accessorFor(probe), spec('/nope'), index)).rejects.toThrow()
    expect(probe.trees).toBe(0)
  })
})

for (const backend of ['ram', 'redis']) {
  for (const replacement of ['tree', 'blob', 'missing']) {
    it.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
      `resolves an expired truncated-tree directory from the current ref (${backend}, ${replacement})`,
      async () => {
        const url = process.env.REDIS_URL
        const index =
          backend === 'ram'
            ? new RAMIndexCacheStore()
            : new RedisIndexCacheStore({
                ...(url === undefined ? {} : { url }),
                keyPrefix: `github-contract:${crypto.randomUUID()}:`,
              })
        const get = vi.fn((path: string) => {
          if (path.endsWith('/git/blobs/new-nested')) {
            return Promise.resolve({ content: 'cmVwbGFjZW1lbnQ=', encoding: 'base64' })
          }
          if (path.endsWith('/git/trees/main')) {
            return Promise.resolve({ tree: [{ path: 'src', type: 'tree', sha: 'new-src' }] })
          }
          if (path.endsWith('/git/trees/new-src')) {
            return Promise.resolve({
              tree:
                replacement === 'missing'
                  ? []
                  : [{ path: 'nested', type: replacement, sha: 'new-nested' }],
            })
          }
          if (path.endsWith('/git/trees/new-nested')) {
            return Promise.resolve({
              tree: [{ path: 'new.py', type: 'blob', sha: 'new', size: 2 }],
            })
          }
          throw new Error(`Unexpected request: ${path}`)
        })
        const accessor = new GitHubAccessor({
          transport: { get, request: vi.fn() },
          owner: 'acme',
          repo: 'proj',
          ref: 'main',
          defaultBranch: 'main',
        })
        accessor.truncated = true
        try {
          await index.setDir('/repo', [
            ['src', new IndexEntry({ id: 'old-src', name: 'src', resourceType: 'folder' })],
          ])
          await index.setDir('/repo/src', [
            [
              'nested',
              new IndexEntry({ id: 'old-nested', name: 'nested', resourceType: 'folder' }),
            ],
          ])
          await index.setDir('/repo/src/nested', [], new Date(Date.now() - 1000))
          const path = new PathSpec({
            vfsPath: 'src/nested',
            virtual: '/repo/src/nested',
            directory: '/repo/src/nested',
          })
          if (replacement === 'tree') {
            for (let i = 0; i < 2; i++) {
              expect(await readdir(accessor, path, index)).toEqual(['/repo/src/nested/new.py'])
            }
            expect(get.mock.calls.map(([p]) => p.split('/').at(-1))).toEqual([
              'main',
              'new-src',
              'new-nested',
            ])
          } else {
            await expect(readdir(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
            if (replacement === 'blob') {
              expect((await stat(accessor, path, index)).type).toBe(FileType.FILE)
              expect(new TextDecoder().decode(await read(accessor, path, index))).toBe(
                'replacement',
              )
            } else {
              await expect(stat(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
              await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
            }
            expect(
              get.mock.calls
                .filter(([p]) => p.includes('/git/trees/'))
                .map(([p]) => p.split('/').at(-1)),
            ).toEqual(['main', 'new-src'])
          }
        } finally {
          await index.clear()
          await index.close()
        }
      },
    )
  }
}

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `complete refill with ${backend}`,
    () => {
      it.each(['missing', 'blob'])('removes obsolete directories: %s', async (replacement) => {
        const url = process.env.REDIS_URL
        const index =
          backend === 'ram'
            ? new RAMIndexCacheStore()
            : new RedisIndexCacheStore({
                ...(url === undefined ? {} : { url }),
                keyPrefix: `github-obsolete:${crypto.randomUUID()}:`,
              })
        const get = vi.fn(() =>
          Promise.resolve({
            tree:
              replacement === 'missing' ? [] : [{ path: 'src', type: 'blob', sha: 'new', size: 3 }],
            truncated: false,
          }),
        )
        const accessor = new GitHubAccessor({
          transport: { get, request: vi.fn() },
          owner: 'acme',
          repo: 'proj',
          ref: 'main',
          defaultBranch: 'main',
        })
        const path = new PathSpec({
          vfsPath: 'src',
          virtual: '/repo/src',
          directory: '/repo/src',
        })
        try {
          await index.setDir('/other', [
            ['keep', new IndexEntry({ id: 'keep', name: 'keep', resourceType: 'file' })],
          ])
          await index.setDir('/repo', [
            ['src', new IndexEntry({ id: 'old', name: 'src', resourceType: 'folder' })],
          ])
          await index.setDir('/repo/src', [
            ['old.py', new IndexEntry({ id: 'old-file', name: 'old.py', resourceType: 'file' })],
          ])
          await index.invalidate()
          for (let i = 0; i < 2; i++)
            await expect(readdir(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(get).toHaveBeenCalledTimes(1)
          expect((await index.get('/repo/src/old.py')).entry).toBeUndefined()
          expect((await index.get('/other/keep')).entry?.id).toBe('keep')
        } finally {
          await index.clear()
          await index.close()
        }
      })
    },
  )
}

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `truncated refill with ${backend}`,
    () => {
      for (const prefix of ['', '/repo']) {
        for (const partialChildren of [false, true]) {
          for (const refresh of [false, true]) {
            it(`fetches complete listings (prefix=${prefix}, partial=${String(partialChildren)}, refresh=${String(refresh)})`, async () => {
              const url = process.env.REDIS_URL
              const index =
                backend === 'ram'
                  ? new RAMIndexCacheStore()
                  : new RedisIndexCacheStore({
                      ...(url === undefined ? {} : { url }),
                      keyPrefix: `github-refill:${crypto.randomUUID()}:`,
                    })
              const folder = { path: 'docs', type: 'tree', sha: 'docs-sha' }
              const partialTree = partialChildren
                ? [folder, { path: 'docs/first.md', type: 'blob', sha: 'first', size: 1 }]
                : [folder]
              const get = vi.fn((path: string, params?: Record<string, string>) => {
                if (params?.recursive === '1')
                  return Promise.resolve({ tree: partialTree, truncated: true })
                if (path.endsWith('/git/trees/main')) return Promise.resolve({ tree: [folder] })
                if (path.endsWith('/git/trees/docs-sha'))
                  return Promise.resolve({
                    tree: [
                      { path: 'first.md', type: 'blob', sha: 'first', size: 1 },
                      { path: 'second.md', type: 'blob', sha: 'second', size: 2 },
                    ],
                  })
                throw new Error(`Unexpected request: ${path}`)
              })
              const accessor = new GitHubAccessor({
                transport: { get, request: vi.fn() },
                owner: 'acme',
                repo: 'proj',
                ref: 'main',
                defaultBranch: 'main',
              })
              const root = prefix || '/'
              const rootPath = new PathSpec({ vfsPath: '', virtual: root, directory: root })
              const docs = `${prefix}/docs`
              const docsPath = new PathSpec({
                vfsPath: 'docs',
                virtual: docs,
                directory: docs,
              })
              try {
                if (refresh) {
                  await index.setDir(root, [])
                  await index.invalidate()
                }
                for (let i = 0; i < 2; i++) {
                  expect(await readdir(accessor, rootPath, index)).toEqual([docs])
                  expect(await readdir(accessor, docsPath, index)).toEqual([
                    `${docs}/first.md`,
                    `${docs}/second.md`,
                  ])
                }
                expect(
                  get.mock.calls.filter(([, params]) => params?.recursive === '1'),
                ).toHaveLength(1)
                expect(
                  get.mock.calls
                    .filter(([, params]) => params?.recursive !== '1')
                    .map(([path]) => path.split('/').at(-1)),
                ).toEqual(['main', 'main', 'docs-sha'])
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

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

import { ListingCheckStore } from '@struktoai/mirage-core/cache/index/ram'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import * as repo from './repo.ts'
import { stat, tree } from './stat.ts'
import { codeOf, ps, rowAt, walking } from './_test_util.ts'

beforeEach(() => {
  vi.spyOn(repo, 'headCommit').mockResolvedValue('')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Stat a path the way the mount does: handed the row its folder lists.
async function statAt(accessor: HfHubAccessor, path: PathSpec): Promise<FileStat> {
  return stat(accessor, path, await rowAt(accessor, path))
}

describe('stat', () => {
  it('reports size and the oid as fingerprint', async () => {
    const result = await statAt(walking(), ps('a.txt'))
    expect([result.size, result.fingerprint]).toEqual([7, 'oid-a'])
  })

  it('leaves mtime null when the row carries none', async () => {
    // A Hub file's only mtime is its last commit, and a bare listing carries
    // none. Null is honest; a repo-wide timestamp on every file would not be.
    expect((await statAt(walking(), ps('a.txt'))).modified).toBeNull()
  })

  it('reports a directory with no row of its own', async () => {
    const accessor = walking([{ type: 'file', oid: 'o', size: 1, path: 'd/b.txt' }])
    const result = await statAt(accessor, ps('d'))
    expect([result.name, result.type]).toEqual(['d', 'directory'])
  })

  it('reports the mount root as a directory', async () => {
    const result = await stat(walking(), ps(''))
    expect([result.name, result.type]).toEqual(['/', 'directory'])
  })

  it('reports ENOENT for a missing path', async () => {
    expect(await codeOf(() => statAt(walking(), ps('nope')))).toBe('ENOENT')
  })

  it('carries no token for an empty oid', async () => {
    const accessor = walking([{ type: 'file', oid: '', size: 1, path: 'e.txt' }])
    expect((await statAt(accessor, ps('e.txt'))).fingerprint).toBeNull()
  })
})

// An LFS row whose git oid, LFS sha and xet hash all differ: the stat's token
// has to be the oid, the same kind a tree row carries.
const LFS_ROW = {
  type: 'file',
  oid: 'O',
  size: 7,
  path: 'a.txt',
  lfs: { oid: 'L' },
  xetHash: 'X',
}

describe('the gate check', () => {
  // No test here may reach the real Hub: a walk nobody expected answers an
  // empty tree, which the assertions then catch.
  function checked(path: PathSpec): Promise<FileStat> {
    return stat(walking([]), path, null, new ListingCheckStore())
  }

  it('asks for one path', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([LFS_ROW])
    const result = await checked(ps('a.txt'))
    expect(post).toHaveBeenCalledTimes(1)
    expect(client.hubGetResponse).not.toHaveBeenCalled()
    expect(post.mock.calls[0]?.[2]).toEqual({ paths: ['a.txt'], expand: false })
    expect([result.size, result.fingerprint]).toEqual([7, 'O'])
  })

  it('asks nothing for an unhanded path outside a check', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([LFS_ROW])
    expect(await codeOf(() => stat(walking([]), ps('a.txt')))).toBe('ENOENT')
    expect(post).not.toHaveBeenCalled()
    expect(client.hubGetResponse).not.toHaveBeenCalled()
  })

  it('reports a missing path as ENOENT without a walk', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue([])
    expect(await codeOf(() => checked(ps('nope')))).toBe('ENOENT')
    expect(post).toHaveBeenCalledTimes(1)
    expect(client.hubGetResponse).not.toHaveBeenCalled()
  })

  it('reports a directory', async () => {
    vi.spyOn(client, 'hubPost').mockResolvedValue([
      { type: 'directory', oid: 'tree-d', size: 0, path: 'd' },
    ])
    expect((await checked(ps('d'))).type).toBe('directory')
    expect(client.hubGetResponse).not.toHaveBeenCalled()
  })

  it.each([null, {}, { error: 'unavailable' }, ''])(
    'does not treat a malformed response %j as absence',
    async (answer) => {
      vi.spyOn(client, 'hubPost').mockResolvedValue(answer)
      await expect(checked(ps('a.txt'))).rejects.toThrow(client.HfHubError)
    },
  )

  it('refuses rows for another path', async () => {
    // An answer about some other path is not an answer about this one; it
    // must not read as absence, which reconcile would turn into a delete.
    vi.spyOn(client, 'hubPost').mockResolvedValue([
      { type: 'file', oid: 'x', size: 1, path: 'A.TXT' },
    ])
    await expect(checked(ps('a.txt'))).rejects.toBeInstanceOf(client.HfHubError)
  })

  it.each([
    [401, ''],
    [403, ''],
    [404, 'RepoNotFound'],
    [404, 'RevisionNotFound'],
  ])('reports a refused %i %s as permission denied', async (status, code) => {
    // Not absence (which reconcile turns into a delete) and not a raw Hub error
    // (which a recursive walk cannot step past).
    vi.spyOn(client, 'hubPost').mockRejectedValue(new client.HfHubError('nope', status, code))
    expect(await codeOf(() => checked(ps('a.txt')))).toBe('EACCES')
    expect(client.hubGetResponse).not.toHaveBeenCalled()
  })

  it('keeps a server failure a hub error', async () => {
    vi.spyOn(client, 'hubPost').mockRejectedValue(new client.HfHubError('boom', 500))
    const err = await checked(ps('a.txt')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(client.HfHubError)
    expect(String(err)).toContain('boom')
  })
})

describe('tree', () => {
  it('lists every entry below the mount root in one walk', async () => {
    const accessor = walking()
    const rows = await tree(accessor, ps(''))
    expect(client.hubGetResponse).toHaveBeenCalledTimes(1)
    expect([...(rows?.keys() ?? [])].sort()).toEqual(['a.txt', 'd', 'd/b.txt'])
    expect(rows?.get('a.txt')).toEqual(await statAt(accessor, ps('a.txt')))
    expect(rows?.get('d')?.type).toBe('directory')
    expect(rows?.get('d/b.txt')?.size).toBe(3)
  })

  it('keys a subtree below its own root', async () => {
    const rows = await tree(walking(), ps('d'))
    expect([...(rows?.keys() ?? [])]).toEqual(['b.txt'])
    expect(rows?.get('b.txt')?.fingerprint).toBe('oid-b')
  })

  it('names the directories the listing only implies', async () => {
    const accessor = walking([{ type: 'file', oid: 'o', size: 1, path: 'd/e/b.txt' }])
    const rows = await tree(accessor, ps(''))
    expect([...(rows?.keys() ?? [])].sort()).toEqual(['d', 'd/e', 'd/e/b.txt'])
    expect(rows?.get('d/e')?.type).toBe('directory')
  })

  it.each(['a.txt', 'nope'])('leaves the walk for %s, a file or nothing', async (path) => {
    expect(await tree(walking(), ps(path))).toBeNull()
  })

  it('reports a refused repository as permission denied', async () => {
    const accessor = walking()
    vi.spyOn(client, 'hubGetResponse').mockRejectedValue(new client.HfHubError('gated', 403))
    expect(await codeOf(() => tree(accessor, ps('')))).toBe('EACCES')
  })
})

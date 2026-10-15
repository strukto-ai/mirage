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

import type { DirListing } from '@struktoai/mirage-core/types'
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as client from './client.ts'
import * as repo from './repo.ts'
import { readdir } from './readdir.ts'
import { codeOf, ps, walking } from './_test_util.ts'

function names(listing: DirListing): string[] {
  return listing.entries.map((row) => row.name)
}

let head: MockInstance<typeof repo.headCommit>

beforeEach(() => {
  // The head a listing asks for before its walk is answered locally: ''
  // walks the branch and versions nothing.
  head = vi.spyOn(repo, 'headCommit').mockResolvedValue('')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readdir', () => {
  it('lists the root and a subdirectory', async () => {
    const accessor = walking()
    expect(names(await readdir(accessor, ps('')))).toEqual(['a.txt', 'd'])
    expect(names(await readdir(accessor, ps('d')))).toEqual(['b.txt'])
  })

  it('seeds every folder below from one walk', async () => {
    const listing = await readdir(walking(), ps(''))
    expect(
      Object.fromEntries([...listing.seeds].map(([k, v]) => [k, v.map((r) => r.name)])),
    ).toEqual({ d: ['b.txt'] })
  })

  it('reports ENOTDIR for a file and for a path under one', async () => {
    // GNU `ls /f.txt/x` reports Not a directory, not absence.
    const accessor = walking()
    expect(await codeOf(() => readdir(accessor, ps('a.txt')))).toBe('ENOTDIR')
    expect(await codeOf(() => readdir(accessor, ps('a.txt/x')))).toBe('ENOTDIR')
  })

  it('reports ENOENT for a missing path however deep', async () => {
    const accessor = walking()
    expect(await codeOf(() => readdir(accessor, ps('nope')))).toBe('ENOENT')
    expect(await codeOf(() => readdir(accessor, ps('nope/deeper')))).toBe('ENOENT')
  })

  it('lists nothing for an empty repo', async () => {
    expect(names(await readdir(walking([]), ps('')))).toEqual([])
  })

  it('lists a directory only a path implies', async () => {
    // A page boundary can deliver a child before its parent's own row.
    const listing = await readdir(
      walking([
        { type: 'file', oid: 'o', size: 1, path: 'd/e/b.txt' },
        { type: 'directory', oid: 't', size: 0, path: 'd' },
      ]),
      ps(''),
    )
    expect(names(listing)).toEqual(['d'])
    expect(listing.seeds.get('d')?.map((row) => row.name)).toEqual(['e'])
  })

  it('walks at the head it names and versions the listing by it', async () => {
    head.mockResolvedValue('c0ffee')
    const accessor = walking()
    const walk = vi.mocked(client.hubGetResponse)
    const listing = await readdir(accessor, ps(''))
    expect(String(walk.mock.calls[0]?.[1])).toContain('/tree/c0ffee')
    expect(listing.version).toBe('c0ffee')
  })

  it('walks the branch unversioned when the Hub names no head', async () => {
    const accessor = walking()
    const walk = vi.mocked(client.hubGetResponse)
    const listing = await readdir(accessor, ps(''))
    expect(String(walk.mock.calls[0]?.[1])).toContain('/tree/main')
    expect(listing.version).toBeNull()
  })

  it('raises a failing head without a walk', async () => {
    head.mockRejectedValue(new client.HfHubError('boom', 500))
    const accessor = walking()
    await expect(readdir(accessor, ps(''))).rejects.toThrow('boom')
    expect(client.hubGetResponse).not.toHaveBeenCalled()
  })

  it('reports a refused tree walk as permission denied', async () => {
    const accessor = walking()
    vi.mocked(client.hubGetResponse).mockRejectedValue(new client.HfHubError('nope', 401))
    expect(await codeOf(() => readdir(accessor, ps('')))).toBe('EACCES')
  })

  it('walks one page for a repository that fits in it', async () => {
    await readdir(walking(), ps(''))
    expect(client.hubGetResponse).toHaveBeenCalledTimes(1)
  })
})

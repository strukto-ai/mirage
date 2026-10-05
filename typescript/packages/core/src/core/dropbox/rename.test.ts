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
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, dropboxRpc: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { runWithCacheManager, type CacheInvalidator } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import * as client from './client.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import type { DropboxEntry } from './api.ts'
import { rename } from './rename.ts'
import { FakeDropboxRpc, fileEntry, folderEntry } from './_test_util.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('dropbox rename conflict probe', () => {
  it('is bounded to one entry', async () => {
    // The probe is bounded, not a full listing: listFolder follows every
    // continuation cursor, so asking it with a small page size made one
    // request per child to answer a yes/no.
    const fake = new FakeDropboxRpc({
      entries: [fileEntry('a.txt'), fileEntry('b.txt'), fileEntry('c.txt')],
      metadata: folderEntry('dst'),
      moveErrors: [new DropboxApiError('conflict', 409, 'to/conflict/folder/...')],
    })
    vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
    await expect(rename(makeAccessor(), spec('/src'), spec('/dst'))).rejects.toBeInstanceOf(
      DropboxApiError,
    )
    expect(fake.listLimits).toEqual([1])
    expect(fake.listRequests).toBe(1)
    expect(fake.deleted).toEqual([])
  })
})

function recorder(): [CacheInvalidator, string[]] {
  const seen: string[] = []
  const manager = {
    invalidateAfterUnlink: (path: PathSpec) => {
      seen.push(`unlink ${path.virtual}`)
      return Promise.resolve()
    },
    invalidateSubtree: (path: PathSpec) => {
      seen.push(`subtree ${path.virtual}`)
      return Promise.resolve()
    },
    invalidateAncestors: () => Promise.resolve(),
  } as unknown as CacheInvalidator
  return [manager, seen]
}

async function moved(fake: FakeDropboxRpc): Promise<string[]> {
  vi.mocked(client.dropboxRpc).mockImplementation(fake.handle)
  const [manager, seen] = recorder()
  await runWithCacheManager(manager, () => rename(makeAccessor(), spec('/a'), spec('/b')))
  return seen
}

const conflict = (kind: string): DropboxApiError =>
  new DropboxApiError('conflict', 409, `to/conflict/${kind}/...`)

describe('dropbox rename invalidation', () => {
  it.each([
    ['a file', {}, ['unlink /a', 'unlink /b']],
    ['a folder', { moved: folderEntry('b') }, ['subtree /a', 'subtree /b']],
    [
      'an item with no type',
      { moved: { name: 'b' } as DropboxEntry },
      ['subtree /a', 'subtree /b'],
    ],
    ['an empty reply', { moved: null }, ['subtree /a', 'subtree /b']],
    [
      'a file over an empty folder',
      { metadata: folderEntry('b'), moveErrors: [conflict('folder')] },
      ['unlink /a', 'subtree /b'],
    ],
    [
      'a file over an entry of no known kind',
      { metadata: { name: 'b' } as DropboxEntry, moveErrors: [conflict('other')] },
      ['unlink /a', 'subtree /b'],
    ],
    [
      'a file over a file',
      { metadata: fileEntry('b'), moveErrors: [conflict('file')] },
      ['unlink /a', 'unlink /b'],
    ],
  ])('%s', async (_label, opts, drops) => {
    // move_v2 answers with the moved entry's metadata; only a file tag
    // spares the subtree. A destination the move replaced keeps its
    // subtree unless that was positively a file: its name may still have
    // cached children removed outside mirage.
    const fake = new FakeDropboxRpc({ moved: fileEntry('b'), ...opts })
    expect(await moved(fake)).toEqual(drops)
  })
})

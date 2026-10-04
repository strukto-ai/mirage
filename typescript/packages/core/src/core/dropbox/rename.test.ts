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
    invalidateAfterMove: (path: PathSpec, folder: boolean) => {
      seen.push(`${folder ? 'subtree' : 'unlink'} ${path.virtual}`)
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

describe('dropbox rename invalidation', () => {
  it('a renamed file drops no subtree', async () => {
    // move_v2 answers with the moved entry's metadata: a file tag means
    // nothing was cached beneath either name.
    expect(await moved(new FakeDropboxRpc({ moved: fileEntry('b') }))).toEqual([
      'unlink /a',
      'unlink /b',
    ])
  })

  it.each([
    ['a folder', folderEntry('b')],
    ['an item with no type', { name: 'b' } as DropboxEntry],
    ['an empty reply', null],
  ])('%s drops both subtrees', async (_label, entry) => {
    // Only a positive file tag narrows: a reply that names no type, or an
    // empty body after a move that worked, leaves both ends dropping their
    // subtrees.
    expect(await moved(new FakeDropboxRpc({ moved: entry }))).toEqual(['subtree /a', 'subtree /b'])
  })

  it('a file replacing an empty folder drops its subtree', async () => {
    // The rename deleted the folder at dst, so whatever is still cached
    // under that name (children removed outside mirage, say) goes too.
    const fake = new FakeDropboxRpc({
      metadata: folderEntry('b'),
      moveErrors: [new DropboxApiError('conflict', 409, 'to/conflict/folder/...')],
      moved: fileEntry('b'),
    })
    expect(await moved(fake)).toEqual(['unlink /a', 'subtree /b'])
    expect(fake.deleted).toEqual(['/b'])
  })

  it('a file replacing an entry of no known kind drops its subtree', async () => {
    // Only a positive file tag on what was replaced keeps dst narrow.
    const fake = new FakeDropboxRpc({
      metadata: { name: 'b' } as DropboxEntry,
      moveErrors: [new DropboxApiError('conflict', 409, 'to/conflict/other/...')],
      moved: fileEntry('b'),
    })
    expect(await moved(fake)).toEqual(['unlink /a', 'subtree /b'])
  })

  it('a file replacing a file drops no subtree', async () => {
    const fake = new FakeDropboxRpc({
      metadata: fileEntry('b'),
      moveErrors: [new DropboxApiError('conflict', 409, 'to/conflict/file/...')],
      moved: fileEntry('b'),
    })
    expect(await moved(fake)).toEqual(['unlink /a', 'unlink /b'])
    expect(fake.deleted).toEqual(['/b'])
  })
})

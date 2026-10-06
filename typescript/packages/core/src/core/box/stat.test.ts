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
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, getFolderInfo: vi.fn(), listFolderItems: vi.fn(), getFileInfo: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { ListingCheckStore, RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { type FileStat, PathSpec } from '../../types.ts'
import * as api from './api.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import { stat } from './stat.ts'

const STUB_TM = {} as BoxTokenManager
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

describe('box stat of the mount root', () => {
  it('reads a 404 on the configured root folder as absence', async () => {
    vi.mocked(api.getFolderInfo).mockRejectedValue(
      new BoxApiError('Box GET /folders/0 -> 404 not_found', 404),
    )
    await expect(stat(makeAccessor(), ROOT)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a server error on the configured root stay a failure', async () => {
    vi.mocked(api.getFolderInfo).mockRejectedValue(
      new BoxApiError('Box GET /folders/0 -> 500 internal', 500),
    )
    await expect(stat(makeAccessor(), ROOT)).rejects.toMatchObject({ status: 500 })
  })

  it('a rooted mount stats its root folder, not All Files', async () => {
    vi.mocked(api.getFolderInfo).mockResolvedValue({
      id: 'R',
      modified_at: '2026-05-01T00:00:00+00:00',
    } as never)
    const info = await stat(rooted('R'), ROOT)
    expect(info.extra.box_id).toBe('R')
    expect(vi.mocked(api.getFolderInfo).mock.calls.at(-1)?.[1]).toBe('R')
  })
})

const SHA_FAST = 'fast'
const SHA_WALK = 'walk'
const ALL_FILES = folder('0', 'All Files')
const TRASH = folder('1', 'Trash')

type Chain = { type: 'folder'; id: string; name: string }[]

function folder(id: string, name: string): { type: 'folder'; id: string; name: string } {
  return { type: 'folder', id, name }
}

function row(id: string, name: string, sha1: string | null): api.BoxItem {
  return {
    type: 'file',
    id,
    name,
    size: 5,
    modified_at: '2026-04-01T00:00:00+00:00',
    ...(sha1 === null ? {} : { sha1 }),
  }
}

function item(
  chain: Chain,
  status = 'active',
  over: Record<string, unknown> = {},
): api.BoxFileInfo {
  return {
    ...row('F1', 'c.txt', SHA_FAST),
    item_status: status,
    path_collection: { total_count: chain.length, entries: chain },
    ...over,
  } as api.BoxFileInfo
}

/**
 * Folder listings by id, the one file-info answer, and a ledger. Constructing
 * one installs the API mocks, so a test that needs only the answers can build
 * it without keeping it.
 */
class FakeBox {
  readonly log: string[] = []
  constructor(
    private readonly folders: Record<string, api.BoxItem[]>,
    private readonly info: api.BoxFileInfo | Error | null,
  ) {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId: string) => {
      this.log.push(`items:${folderId}`)
      const kids = this.folders[folderId]
      if (kids === undefined) return Promise.reject(new BoxApiError('gone', 404))
      return Promise.resolve(kids)
    })
    vi.mocked(api.getFileInfo).mockImplementation((_tm, fileId: string) => {
      this.log.push(`info:${fileId}`)
      if (this.info === null) return Promise.reject(new Error(`unexpected info:${fileId}`))
      if (this.info instanceof Error) return Promise.reject(this.info)
      return Promise.resolve(this.info)
    })
  }
}

function walkTree(root = '0', leaf: api.BoxItem | null = null): Record<string, api.BoxItem[]> {
  return {
    [root]: [folder('A', 'a')],
    A: [folder('B', 'b')],
    B: leaf === null ? [] : [leaf],
  }
}

async function scratchStat(
  accessor: BoxAccessor,
  virtual = '/a/b/c.txt',
  hint: { rowId?: string; kind?: string } = {},
): Promise<FileStat> {
  const src = new RAMIndexCacheStore()
  const parent = virtual.slice(0, virtual.lastIndexOf('/'))
  const name = virtual.slice(virtual.lastIndexOf('/') + 1)
  await src.setDir(parent, [
    [name, new IndexEntry({ id: hint.rowId ?? 'F1', name, resourceType: hint.kind ?? 'box/file' })],
  ])
  const scratch = new ListingCheckStore({ hints: src })
  return stat(accessor, new PathSpec({ vfsPath: 'a/b/c.txt', virtual, directory: parent }), scratch)
}

function rooted(root: string): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM, rootFolderId: root })
}

const DEEP = new PathSpec({ vfsPath: 'a/b/c.txt', virtual: '/a/b/c.txt', directory: '/a/b' })
const FLAT = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const WALK_FOUND = ['items:0', 'items:A', 'items:B']
const WALK_GONE = [...WALK_FOUND, ...WALK_FOUND]

describe('box stat token', () => {
  // modified_at is no content token: two same-size edits in one second
  // share it, so a file Box gives no sha1 stats with none.
  it('a sha1-less row stats with no token', async () => {
    new FakeBox({ '0': [row('200', 'a.txt', null)] }, null)
    const info = await stat(makeAccessor(), FLAT, new RAMIndexCacheStore())
    expect(info.fingerprint).toBeNull()
    expect(info.modified).toBe('2026-04-01T00:00:00+00:00')
  })

  it('a direct resolve of a sha1-less item has no token', async () => {
    new FakeBox({ '0': [row('200', 'a.txt', null)] }, null)
    const info = await stat(makeAccessor(), FLAT)
    expect(info.fingerprint).toBeNull()
    expect(info.modified).toBe('2026-04-01T00:00:00+00:00')
  })

  it('a listed sha1 is the stat token', async () => {
    const index = new RAMIndexCacheStore()
    await index.setDir('/', [
      [
        'a.txt',
        new IndexEntry({
          id: '200',
          name: 'a.txt',
          resourceType: 'box/file',
          remoteTime: '2026-04-01T00:00:00+00:00',
          extra: { sha1: SHA_FAST },
        }),
      ],
    ])
    expect((await stat(makeAccessor(), FLAT, index)).fingerprint).toBe(SHA_FAST)
  })
})

describe('box stat on a scratch store', () => {
  it('a valid hint is one request and the walk answer', async () => {
    const chain = [ALL_FILES, folder('A', 'a'), folder('B', 'b')]
    const box = new FakeBox(walkTree('0', row('F1', 'c.txt', SHA_FAST)), item(chain))
    const fast = await scratchStat(makeAccessor())
    expect(box.log).toEqual(['info:F1'])
    const walkBox = new FakeBox(walkTree('0', row('F1', 'c.txt', SHA_FAST)), null)
    const walked = await scratchStat(makeAccessor(), '/a/b/c.txt', { rowId: '' })
    // The command reuses the probe's stat, so the fast path must build the
    // stat the walk would have: compared with the real walk, not by hand.
    expect(walkBox.log).toEqual(WALK_FOUND)
    expect(fast).toEqual(walked)
    expect(fast.fingerprint).toBe(SHA_FAST)
  })

  it('only a scratch store takes the one-request path', async () => {
    const box = new FakeBox(walkTree('0', row('F1', 'c.txt', SHA_FAST)), null)
    await stat(makeAccessor(), DEEP, new RAMIndexCacheStore())
    expect(box.log).toEqual(WALK_FOUND)
  })

  it.each([
    ['empty-id', '', 'box/file'],
    ['folder', 'F1', 'box/folder'],
  ])('an unusable hint walks without asking for it (%s)', async (_id, rowId, kind) => {
    const box = new FakeBox(walkTree('0', row('F2', 'c.txt', SHA_WALK)), null)
    const info = await scratchStat(makeAccessor(), '/a/b/c.txt', { rowId, kind })
    expect(box.log).toEqual(WALK_FOUND)
    expect(info.fingerprint).toBe(SHA_WALK)
  })

  it('no hint walks as today', async () => {
    const box = new FakeBox(walkTree('0', row('F2', 'c.txt', SHA_WALK)), null)
    const info = await stat(makeAccessor(), DEEP, new ListingCheckStore())
    expect(box.log).toEqual(WALK_FOUND)
    expect(info.fingerprint).toBe(SHA_WALK)
  })

  const ORIGINAL = [ALL_FILES, folder('A', 'a'), folder('B', 'b')]
  it.each([
    // Only the active-status check fails: trashed, its chain unchanged.
    ['trashed', item(ORIGINAL, 'trashed'), row('F2', 'c.txt', SHA_WALK), WALK_FOUND],
    // Only the path-name check fails: moved under a/x.
    ['moved', item([ALL_FILES, folder('A', 'a'), folder('X', 'x')]), null, WALK_GONE],
    // Only the path-name check fails: the parent renamed to b2.
    ['parent-renamed', item([ALL_FILES, folder('A', 'a'), folder('B', 'b2')]), null, WALK_GONE],
    // Only the path-name check fails: a case-only rename, which a listing tells apart.
    ['case-only', item(ORIGINAL, 'active', { name: 'C.txt' }), null, WALK_GONE],
    // Only the is-a-file check fails.
    [
      'not-a-file',
      item(ORIGINAL, 'active', { type: 'web_link' }),
      row('F2', 'c.txt', SHA_WALK),
      WALK_FOUND,
    ],
    ['404', new BoxApiError('purged', 404), row('F2', 'c.txt', SHA_WALK), WALK_FOUND],
    ['403', new BoxApiError('no access', 403), row('F2', 'c.txt', SHA_WALK), WALK_FOUND],
  ] as const)(
    'a hint that no longer names the path falls back to the walk (%s)',
    async (_id, info, leaf, ledger) => {
      const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const box = new FakeBox(walkTree('0', leaf), info)
        if (leaf === null) {
          await expect(scratchStat(makeAccessor())).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect((await scratchStat(makeAccessor())).fingerprint).toBe(SHA_WALK)
        }
        expect(box.log).toEqual(['info:F1', ...ledger])
        if (info instanceof BoxApiError)
          expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(info.message))
        else expect(diagnostic).not.toHaveBeenCalled()
      } finally {
        diagnostic.mockRestore()
      }
    },
  )

  it.each([
    // The mount root R itself in Trash: the All-Files-root and no-Trash checks both fail.
    ['root-in-trash', [TRASH, folder('R', 'r'), folder('A', 'a'), folder('B', 'b')]],
    // Only the no-Trash check fails, should Box render Trash under 0.
    [
      'trash-under-all-files',
      [ALL_FILES, TRASH, folder('R', 'r'), folder('A', 'a'), folder('B', 'b')],
    ],
  ])('a file under a trashed mount root is gone (%s)', async (_id, chain) => {
    const box = new FakeBox({}, item(chain))
    await expect(scratchStat(rooted('R'), '/m/a/b/c.txt')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(box.log).toEqual(['info:F1', 'items:R', 'items:R'])
  })

  // R reached from a folder that is not 0. Only the All-Files-root check
  // rejects it, and the walk then answers.
  it('a chain not rooted at All Files falls back', async () => {
    const chain = [folder('X', 'x'), folder('R', 'r'), folder('A', 'a'), folder('B', 'b')]
    const box = new FakeBox(walkTree('R', row('F2', 'c.txt', SHA_WALK)), item(chain))
    const info = await scratchStat(rooted('R'), '/m/a/b/c.txt')
    expect(info.fingerprint).toBe(SHA_WALK)
    expect(box.log).toEqual(['info:F1', 'items:R', 'items:A', 'items:B'])
  })

  it('a mount rooted below All Files takes the one-request path', async () => {
    const chain = [
      ALL_FILES,
      folder('X', 'x'),
      folder('R', 'r'),
      folder('A', 'a'),
      folder('B', 'b'),
    ]
    const box = new FakeBox({}, item(chain))
    const info = await scratchStat(rooted('R'), '/m/a/b/c.txt')
    expect(box.log).toEqual(['info:F1'])
    expect(info.fingerprint).toBe(SHA_FAST)
  })

  it.each([401, 429, 500])('a failed point lookup propagates (%i)', async (status) => {
    const box = new FakeBox(
      walkTree('0', row('F1', 'c.txt', SHA_FAST)),
      new BoxApiError('x', status),
    )
    await expect(scratchStat(makeAccessor())).rejects.toMatchObject({ status })
    expect(box.log).toEqual(['info:F1'])
  })

  // Box sends item_status when asked; an answer without it proves nothing about
  // the file being active, so the walk decides.
  it('an answer without item_status is not taken as active', async () => {
    const info = item([ALL_FILES, folder('A', 'a'), folder('B', 'b')])
    delete (info as { item_status?: string }).item_status
    const box = new FakeBox(walkTree('0', row('F2', 'c.txt', SHA_WALK)), info)
    expect((await scratchStat(makeAccessor())).fingerprint).toBe(SHA_WALK)
    expect(box.log).toEqual(['info:F1', ...WALK_FOUND])
  })
})

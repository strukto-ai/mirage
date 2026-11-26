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

import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoxAccessor } from '../../accessor/box.ts'
import { ListingCheckStore, RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })
const FLAT = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const DEEP = new PathSpec({ vfsPath: 'a/b/c.txt', virtual: '/a/b/c.txt', directory: '/a/b' })
const HELLO = new TextEncoder().encode('hello')
const SHA_HELLO = sha1(HELLO)
const SHA_FAST = 'fast'
const NO_SUCH_ID = '9'
const FOLDER_ROUTE = '/2.0/folders/:folder_id'
const ITEMS_ROUTE = '/2.0/folders/:folder_id/items'
const FILE_ROUTE = '/2.0/files/:file_id'
const ALL_FILES = { type: 'folder', id: '0', name: 'All Files' }
const TRASH = { type: 'folder', id: '1', name: 'Trash' }

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

beforeEach(() => {
  account = new BoxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

function folder(id: string): string {
  return `GET /2.0/folders/${id}`
}

function items(id: string): string {
  return `GET /2.0/folders/${id}/items`
}

function file(id: string): string {
  return `GET /2.0/files/${id}`
}

async function deep(root = '0'): Promise<[string, string, string]> {
  const a = await account.mkdir('a', root)
  const b = await account.mkdir('b', a)
  return [a, b, await account.put('c.txt', HELLO, b)]
}

async function listed(accessor: BoxAccessor, path: PathSpec): Promise<FileStat> {
  return stat(accessor, path, await entryAt(readdir, accessor, path))
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
    [
      name,
      new FileStat({
        name,
        type: hint.kind === 'box/folder' ? FileType.DIRECTORY : FileType.FILE,
        extra: { box_id: hint.rowId ?? '' },
      }),
    ],
  ])
  return stat(
    accessor,
    new PathSpec({ vfsPath: 'a/b/c.txt', virtual, directory: parent }),
    undefined,
    new ListingCheckStore({ hints: src }),
  )
}

async function answerInstead(fileId: string, change: Record<string, JsonValue>): Promise<void> {
  const answer = await account.fileInfo(fileId)
  await account.run.answerNext('GET', FILE_ROUTE, 200, { ...answer, sha1: SHA_FAST, ...change })
}

describe('box stat', () => {
  it('stat root fetches folder info', async () => {
    await account.run.recordRequests()
    const info = await stat(account.accessor(), ROOT)
    expect(await account.run.requests()).toEqual([folder('0')])
    expect(info.type).toBe(FileType.DIRECTORY)
    expect(info.name).toBe('/')
    expect(info.modified).toBe((await account.folderInfo('0')).modified_at)
  })

  it('stat file carries box metadata', async () => {
    const fileId = await account.put('a.txt', HELLO)
    const info = await listed(account.accessor(), FLAT)
    expect(info.content).toBe(ContentType.TEXT)
    expect(info.size).toBe(5)
    expect(info.modified).toBe((await account.fileInfo(fileId)).modified_at)
    expect(info.fingerprint).toBe(SHA_HELLO)
    expect(info.extra.box_id).toBe(fileId)
    expect(info.extra.resource_type).toBe('box/file')
  })

  it('stat missing raises', async () => {
    const ghost = new PathSpec({ vfsPath: 'ghost', virtual: '/ghost', directory: '/' })
    await expect(listed(account.accessor(), ghost)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The fskit invariant behind sizes_always_known: the size stat serves from
  // the listing must equal the byte length a read delivers, 0-byte files
  // included; weblinks never appear at all.
  it('stat size matches read for every file', async () => {
    const docs = await account.mkdir('docs')
    await account.put('a.txt', HELLO)
    await account.put('empty.txt', new Uint8Array(0))
    await account.webLink('homepage')
    await account.put('b.bin', new TextEncoder().encode('abc'), docs)
    const accessor = account.accessor()
    const files: string[] = []
    const stack = ['/']
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      const here = PathSpec.fromStrPath(current)
      const listing = await readdir(accessor, here, await entryAt(readdir, accessor, here))
      for (const child of listing instanceof DirListing ? listing.entries : listing) {
        const trimmed = `${current.replace(/\/+$/, '')}/${child.name}`
        const spec = PathSpec.fromStrPath(trimmed)
        const entry = await entryAt(readdir, accessor, spec)
        const info = await stat(accessor, spec, entry)
        if (info.type === FileType.DIRECTORY) {
          stack.push(trimmed)
          continue
        }
        expect(info.size, trimmed).not.toBeNull()
        const body = await read(accessor, spec, undefined, entry)
        expect(info.size, trimmed).toBe(body.length)
        files.push(trimmed)
      }
    }
    expect(files.sort()).toEqual(['/a.txt', '/docs/b.bin', '/empty.txt'])
  })

  // Weblinks are filtered from listings; a check's resolve walk must not
  // resurface one as a sizeless, unreadable entry.
  it('stat direct resolve hides weblinks', async () => {
    await account.webLink('homepage')
    const homepage = new PathSpec({ vfsPath: 'homepage', virtual: '/homepage', directory: '/' })
    await expect(
      stat(account.accessor(), homepage, undefined, new ListingCheckStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stat root reads a 404 as absence', async () => {
    await expect(stat(account.accessor(NO_SUCH_ID), ROOT)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stat root keeps a server error a failure', async () => {
    await account.run.answerNext('GET', FOLDER_ROUTE, 500)
    await expect(stat(account.accessor(), ROOT)).rejects.toMatchObject({ status: 500 })
  })

  it('a rooted mount stats its root folder, not All Files', async () => {
    const root = await account.mkdir('r')
    await account.run.recordRequests()
    const info = await stat(account.accessor(root), ROOT)
    expect(info.extra.box_id).toBe(root)
    expect(await account.run.requests()).toEqual([folder(root)])
  })
})

describe('box stat token', () => {
  async function listWithoutSha1(): Promise<string> {
    await account.put('a.txt', HELLO)
    const listing = await account.run.call<{
      entries: (Record<string, JsonValue> & { modified_at: string })[]
    }>('GET', '/2.0/folders/0/items')
    for (const row of listing.entries) delete row.sha1
    await account.run.answerNext('GET', ITEMS_ROUTE, 200, listing)
    return listing.entries[0]?.modified_at ?? ''
  }

  // modified_at is no content token: two same-size edits in one second
  // share it, so a file Box gives no sha1 stats with none.
  it('a sha1-less row stats with no token', async () => {
    const modified = await listWithoutSha1()
    const info = await listed(account.accessor(), FLAT)
    expect(info.fingerprint).toBeNull()
    expect(info.modified).toBe(modified)
  })

  it('a direct resolve of a sha1-less item has no token', async () => {
    const modified = await listWithoutSha1()
    const info = await stat(account.accessor(), FLAT, undefined, new ListingCheckStore())
    expect(info.fingerprint).toBeNull()
    expect(info.modified).toBe(modified)
  })

  it('a listed sha1 is the stat token', async () => {
    await account.put('a.txt', HELLO)
    expect((await listed(account.accessor(), FLAT)).fingerprint).toBe(SHA_HELLO)
  })
})

describe('box stat on a scratch store', () => {
  it('a valid hint is one request and the walk answer', async () => {
    const [a, b, fileId] = await deep()
    const accessor = account.accessor()
    await account.run.recordRequests()
    const fast = await scratchStat(accessor, '/a/b/c.txt', { rowId: fileId })
    expect(await account.run.requests()).toEqual([file(fileId)])
    await account.run.recordRequests()
    const walked = await scratchStat(accessor)
    // The command reuses the probe's stat, so the fast path must build the
    // stat the walk would have: compared with the real walk, not by hand.
    expect(await account.run.requests()).toEqual([items('0'), items(a), items(b)])
    expect(fast).toEqual(walked)
    expect(fast.fingerprint).toBe(SHA_HELLO)
  })

  it('only a scratch store takes the one-request path', async () => {
    const [, , fileId] = await deep()
    const handed = new FileStat({ name: 'c.txt', type: FileType.FILE, extra: { box_id: fileId } })
    await account.run.recordRequests()
    expect(await stat(account.accessor(), DEEP, handed, new RAMIndexCacheStore())).toBe(handed)
    expect(await account.run.requests()).toEqual([])
  })

  it('an unusable hint walks without asking for it', async () => {
    const [a, b] = await deep()
    await account.run.recordRequests()
    const info = await scratchStat(account.accessor())
    expect(await account.run.requests()).toEqual([items('0'), items(a), items(b)])
    expect(info.fingerprint).toBe(SHA_HELLO)
  })

  // A folder is asked for by id as a file is; one gone by id is walked.
  it('a folder hint is asked by id then walked', async () => {
    const [a, b] = await deep()
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await account.run.recordRequests()
      const info = await scratchStat(account.accessor(), '/a/b/c.txt', {
        rowId: NO_SUCH_ID,
        kind: 'box/folder',
      })
      expect(await account.run.requests()).toEqual([
        folder(NO_SUCH_ID),
        items('0'),
        items(a),
        items(b),
      ])
      expect(info.fingerprint).toBe(SHA_HELLO)
    } finally {
      diagnostic.mockRestore()
    }
  })

  it('no hint walks as today', async () => {
    const [a, b] = await deep()
    await account.run.recordRequests()
    const info = await stat(account.accessor(), DEEP, undefined, new ListingCheckStore())
    expect(await account.run.requests()).toEqual([items('0'), items(a), items(b)])
    expect(info.fingerprint).toBe(SHA_HELLO)
  })

  // Only the path-name check fails; a case-only rename is one a listing
  // tells apart.
  it.each([
    [
      'moved',
      async (a: string, b: string, fileId: string) => {
        const x = await account.mkdir('x', a)
        await account.run.call('PUT', `/2.0/files/${fileId}`, { json: { parent: { id: x } } })
        return [items('0'), items(a), items(b)]
      },
    ],
    [
      'parent-renamed',
      async (a: string, b: string) => {
        await account.run.call('PUT', `/2.0/folders/${b}`, { json: { name: 'b2' } })
        return [items('0'), items(a)]
      },
    ],
    [
      'case-only',
      async (a: string, b: string, fileId: string) => {
        await account.run.call('PUT', `/2.0/files/${fileId}`, { json: { name: 'C.txt' } })
        return [items('0'), items(a), items(b)]
      },
    ],
  ] as const)(
    'a hinted file that left the path is walked for and gone (%s)',
    async (_id, change) => {
      const [a, b, fileId] = await deep()
      const walk = await change(a, b, fileId)
      const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await account.run.recordRequests()
        await expect(
          scratchStat(account.accessor(), '/a/b/c.txt', { rowId: fileId }),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await account.run.requests()).toEqual([file(fileId), ...walk])
        expect(diagnostic).not.toHaveBeenCalled()
      } finally {
        diagnostic.mockRestore()
      }
    },
  )

  it('a hint to a deleted file walks to the one there now', async () => {
    const [a, b, old] = await deep()
    await account.run.call('DELETE', `/2.0/files/${old}`)
    const other = new TextEncoder().encode('other')
    await account.put('c.txt', other, b)
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await account.run.recordRequests()
      const info = await scratchStat(account.accessor(), '/a/b/c.txt', { rowId: old })
      expect(await account.run.requests()).toEqual([file(old), items('0'), items(a), items(b)])
      expect(info.fingerprint).toBe(sha1(other))
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('404'))
    } finally {
      diagnostic.mockRestore()
    }
  })

  it('a hint Box refuses to answer falls back to the walk', async () => {
    const [a, b, fileId] = await deep()
    await account.run.answerNext('GET', FILE_ROUTE, 403)
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await account.run.recordRequests()
      const info = await scratchStat(account.accessor(), '/a/b/c.txt', { rowId: fileId })
      expect(await account.run.requests()).toEqual([file(fileId), items('0'), items(a), items(b)])
      expect(info.fingerprint).toBe(SHA_HELLO)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('403'))
    } finally {
      diagnostic.mockRestore()
    }
  })

  // Box's own answer for the file with one field changed, so only the
  // active-status check or only the is-a-file check fails.
  it.each([
    ['trashed', { item_status: 'trashed' }],
    ['not-a-file', { type: 'web_link' }],
  ])('an answer failing one check falls back to the walk (%s)', async (_id, change) => {
    const [a, b, fileId] = await deep()
    await answerInstead(fileId, change)
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await account.run.recordRequests()
      const info = await scratchStat(account.accessor(), '/a/b/c.txt', { rowId: fileId })
      expect(await account.run.requests()).toEqual([file(fileId), items('0'), items(a), items(b)])
      expect(info.fingerprint).toBe(SHA_HELLO)
      expect(diagnostic).not.toHaveBeenCalled()
    } finally {
      diagnostic.mockRestore()
    }
  })

  it.each([
    // The mount root itself in Trash: the All-Files-root and no-Trash checks both fail.
    ['root-in-trash', [TRASH]],
    // Only the no-Trash check fails, should Box render Trash under 0.
    ['trash-under-all-files', [ALL_FILES, TRASH]],
  ])('a file under a trashed mount root is gone (%s)', async (_id, above) => {
    const root = await account.mkdir('r')
    const [, , fileId] = await deep(root)
    const chain = (await account.fileInfo(fileId)).path_collection.entries
    await answerInstead(fileId, {
      path_collection: { total_count: above.length + 3, entries: [...above, ...chain.slice(1)] },
    })
    await account.run.call('DELETE', `/2.0/folders/${root}?recursive=true`)
    await account.run.recordRequests()
    await expect(
      scratchStat(account.accessor(root), '/m/a/b/c.txt', { rowId: fileId }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // The trashed root's listing 404s for the walk.
    expect(await account.run.requests()).toEqual([file(fileId), items(root)])
  })

  // The mount root reached from a folder that is not 0. Only the
  // All-Files-root check rejects it, and the walk then answers.
  it('a chain not rooted at All Files falls back', async () => {
    const root = await account.mkdir('r')
    const [a, b, fileId] = await deep(root)
    const chain = (await account.fileInfo(fileId)).path_collection.entries
    await answerInstead(fileId, {
      path_collection: {
        total_count: 4,
        entries: [{ type: 'folder', id: 'X', name: 'x' }, ...chain.slice(1)],
      },
    })
    await account.run.recordRequests()
    const info = await scratchStat(account.accessor(root), '/m/a/b/c.txt', { rowId: fileId })
    expect(info.fingerprint).toBe(SHA_HELLO)
    expect(await account.run.requests()).toEqual([file(fileId), items(root), items(a), items(b)])
  })

  it('a mount rooted below All Files takes the one-request path', async () => {
    const root = await account.mkdir('r', await account.mkdir('x'))
    const [, , fileId] = await deep(root)
    await account.run.recordRequests()
    const info = await scratchStat(account.accessor(root), '/m/a/b/c.txt', { rowId: fileId })
    expect(await account.run.requests()).toEqual([file(fileId)])
    expect(info.fingerprint).toBe(SHA_HELLO)
  })

  it.each([401, 429, 500])('a failed point lookup propagates (%i)', async (status) => {
    const [, , fileId] = await deep()
    await account.run.answerNext('GET', FILE_ROUTE, status)
    await account.run.recordRequests()
    await expect(
      scratchStat(account.accessor(), '/a/b/c.txt', { rowId: fileId }),
    ).rejects.toMatchObject({ status })
    expect(await account.run.requests()).toEqual([file(fileId)])
  })

  // Box sends item_status when asked; an answer without it proves nothing about
  // the file being active, so the walk decides.
  it('an answer without item_status is not taken as active', async () => {
    const [a, b, fileId] = await deep()
    const answer: Record<string, JsonValue> = await account.fileInfo(fileId)
    answer.sha1 = SHA_FAST
    delete answer.item_status
    await account.run.answerNext('GET', FILE_ROUTE, 200, answer)
    await account.run.recordRequests()
    const info = await scratchStat(account.accessor(), '/a/b/c.txt', { rowId: fileId })
    expect(info.fingerprint).toBe(SHA_HELLO)
    expect(await account.run.requests()).toEqual([file(fileId), items('0'), items(a), items(b)])
  })
})

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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BoxAccessor } from '../../accessor/box.ts'
import { runWithWriteContext, writeCondition } from '../../cache/context.ts'
import { recordingScope } from '../../observe/context.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { BoxVFS } from '../../vfs/box/box.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { BoxApiError } from './client.ts'
import { copy } from './copy.ts'
import { mkdir } from './mkdir.ts'
import { readdir } from './readdir.ts'
import { rename } from './rename.ts'
import { rmR, rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { replace, write } from './write.ts'

const ENC = new TextEncoder()
const HELLO = ENC.encode('hello')
const SHA_HELLO = createHash('sha1').update(HELLO).digest('hex')
const FOLDER_ROUTE = '/2.0/folders/:folder_id'
const ITEMS_ROUTE = '/2.0/folders/:folder_id/items'
const NEW_FILE_ROUTE = '/2.0/files/content'
const VERSION_ROUTE = '/2.0/files/:file_id/content'
const COPY_FILE_ROUTE = '/2.0/files/:file_id/copy'
const FILE_ROUTE = '/2.0/files/:file_id'

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

interface Ids {
  data: string
  a: string
  sub: string
  dst: string
}

// `/data` holding `a.txt` ("hello") and the empty `sub` and `dst`.
async function data(): Promise<Ids> {
  const folder = await account.mkdir('data')
  return {
    data: folder,
    a: await account.put('a.txt', HELLO, folder),
    sub: await account.mkdir('sub', folder),
    dst: await account.mkdir('dst', folder),
  }
}

// The requests since recording started that could change Box.
async function changes(): Promise<string[]> {
  return (await account.run.requests()).filter((r) => !r.startsWith('GET'))
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ vfsPath: virtual.replace(/^\/+/, ''), virtual, directory: virtual })
}

// What the mount hands a function at `path` (and a rename's or a copy's
// `dst`), found by listing the account as it would.
function handed(accessor: BoxAccessor, path: PathSpec, dst?: PathSpec): Promise<Handed> {
  return handedAt(readdir, accessor, path, dst)
}

function workspace(accessor: BoxAccessor): Workspace {
  const vfs = new BoxVFS({ accessToken: 'test-token' })
  Object.assign(vfs, { accessor })
  return new Workspace({ '/d/': vfs }, { mode: MountMode.WRITE })
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('box write ops', () => {
  it('refuses a create-only write it cannot condition', async () => {
    await data()
    await account.run.recordRequests()
    await expect(
      replace(account.accessor(), {
        path: spec('/data/new.txt'),
        body: ENC.encode('ours'),
        condition: { kind: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    expect(await account.run.requests()).toEqual([])
  })

  it('commits the explicit condition instead of the ambient cached version', async () => {
    const ids = await data()
    const path = spec('/data/a.txt')
    async function* body(): AsyncGenerator<Uint8Array> {
      expect(await writeCondition(path, 'put')).toEqual({ kind: 'match', version: 'cached' })
      yield ENC.encode('ours')
    }
    await runWithWriteContext(
      '/',
      {
        vfs: 'box',
        conditions: ['put'],
        readVersion: () => Promise.resolve('cached'),
        readVersions: (paths) => Promise.resolve(paths.map(() => 'cached')),
        drop: () => Promise.resolve(),
        keep: () => Promise.resolve(),
      },
      async () => {
        await replace(account.accessor(), {
          path,
          body: body(),
          condition: { kind: 'match', version: SHA_HELLO },
        })
        expect(await writeCondition(path, 'put')).toEqual({ kind: 'match', version: 'cached' })
      },
    )
    expect(text(await account.read(ids.a))).toBe('ours')
  })

  // The check reads the listing Box gave just before another client's
  // version landed. If-Match carries the etag that listing named, so Box
  // refuses the upload and keeps the newer bytes.
  it('sends the etag of the version it checked', async () => {
    const ids = await data()
    const before = await account.run.call<{ entries: { name: string; etag: string }[] }>(
      'GET',
      `/2.0/folders/${ids.data}/items`,
    )
    const checked = before.entries.find((e) => e.name === 'a.txt')
    await account.uploadVersion(ids.a, ENC.encode('later'))
    await account.run.answerNext('GET', ITEMS_ROUTE, 200, before)
    await account.run.recordRequests('if-match')
    await expect(
      replace(account.accessor(ids.data), {
        path: spec('/a.txt'),
        body: ENC.encode('ours'),
        condition: { kind: 'match', version: SHA_HELLO },
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    expect(await account.run.headers('POST', VERSION_ROUTE)).toEqual([
      { 'if-match': checked?.etag },
    ])
    expect(text(await account.read(ids.a))).toBe('later')
  })

  it('closes an already-started body when create-only is unsupported', async () => {
    let closed = false
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield await Promise.resolve(ENC.encode('head'))
        yield ENC.encode('tail')
      } finally {
        closed = true
      }
    }
    const body = source()
    await body.next()
    await expect(
      replace(account.accessor(), {
        path: spec('/data/new.txt'),
        body,
        condition: { kind: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    expect(closed).toBe(true)
  })

  it('uploads a new file under the resolved parent', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await write(
      accessor,
      spec('/data/new.txt'),
      HELLO,
      await handed(accessor, spec('/data/new.txt')),
    )
    const made = await account.child(ids.data, 'new.txt')
    expect(text(await account.read(made.id))).toBe('hello')
  })

  it('uploads a new version when the file already exists', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await write(
      accessor,
      spec('/data/a.txt'),
      ENC.encode('OVER'),
      await handed(accessor, spec('/data/a.txt')),
    )
    expect(text(await account.read(ids.a))).toBe('OVER')
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
  })

  it('lands a write on the file at the path now', async () => {
    // The listing named a.txt; another client then renamed it to b.txt and
    // made a new a.txt. The write goes to the new one.
    const ids = await data()
    const accessor = account.accessor()
    const listed = await handed(accessor, spec('/data/a.txt'))
    await account.rename(ids.a, 'b.txt')
    const now = await account.put('a.txt', ENC.encode('other'), ids.data)
    await write(accessor, spec('/data/a.txt'), ENC.encode('new'), listed)
    expect(text(await account.read(now))).toBe('new')
    expect(text(await account.read(ids.a))).toBe('hello')
  })

  it('a write under a missing folder is ENOENT', async () => {
    await data()
    const accessor = account.accessor()
    const path = spec('/data/ghost/x.txt')
    await expect(
      handed(accessor, path).then((h) => write(accessor, path, ENC.encode('x'), h)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('mkdir creates under the resolved parent', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await mkdir(accessor, spec('/data/newdir'), false, await handed(accessor, spec('/data/newdir')))
    expect((await account.child(ids.data, 'newdir')).type).toBe('folder')
  })

  it.each([
    ['/data/a.txt/x', 'ENOTDIR'],
    ['/data/a.txt/x/y', 'ENOTDIR'],
    ['/data/missing/x', 'ENOENT'],
  ])('mkdir %s refuses a parent that is not a folder', async (virtual, code) => {
    // Finding the parent is where a file in the way answers ENOTDIR, as the
    // mount's listing of it does.
    await data()
    const accessor = account.accessor()
    await account.run.recordRequests()
    await expect(
      handed(accessor, spec(virtual)).then((h) => mkdir(accessor, spec(virtual), false, h)),
    ).rejects.toMatchObject({ code })
    expect(await changes()).toEqual([])
  })

  // -p is the mount's: it makes one level at a time and names the file it
  // stops at above the operand, as GNU does.
  it.each([
    ['/data/a.txt/x/y', 'ENOTDIR'],
    ['/data/a.txt', 'EEXIST'],
  ])('mkdir -p %s names the file it stops at', async (virtual, code) => {
    await data()
    const ws = workspace(account.accessor())
    try {
      await account.run.recordRequests()
      await expect(
        ws.dispatch('mkdir', `/d${virtual}`, [], { parents: true }),
      ).rejects.toMatchObject({ code, virtualPath: '/d/data/a.txt' })
      expect(await changes()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('mkdir of a taken name is EEXIST', async () => {
    // Box refuses the name with a 409, by a file as by a folder.
    const ids = await data()
    const accessor = account.accessor()
    await expect(
      mkdir(accessor, spec('/data/a.txt'), false, await handed(accessor, spec('/data/a.txt'))),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
  })

  it('mkdir -p makes each level in the folder the level above made', async () => {
    const ids = await data()
    const ws = workspace(account.accessor())
    try {
      await ws.dispatch('mkdir', '/d/data/p/q', [], { parents: true })
    } finally {
      await ws.close()
    }
    const p = await account.child(ids.data, 'p')
    expect(await account.names(p.id)).toEqual(['q'])
  })

  it('unlink deletes a file by id', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await unlink(accessor, spec('/data/a.txt'), await handed(accessor, spec('/data/a.txt')))
    expect(await account.names(ids.data)).toEqual(['dst', 'sub'])
  })

  it('unlink on a folder throws EISDIR', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await expect(
      unlink(accessor, spec('/data/sub'), await handed(accessor, spec('/data/sub'))),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
  })

  it('rmdir removes a folder non-recursively', async () => {
    // Non-recursive is Box's to enforce: a folder with a child stays.
    const ids = await data()
    await account.put('x.txt', ENC.encode('x'), ids.dst)
    const accessor = account.accessor()
    await rmdir(accessor, spec('/data/sub'), await handed(accessor, spec('/data/sub')))
    await expect(
      rmdir(accessor, spec('/data/dst'), await handed(accessor, spec('/data/dst'))),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst'])
  })

  it('rmR removes a folder recursively', async () => {
    const ids = await data()
    await account.put('x.txt', ENC.encode('x'), ids.sub)
    const accessor = account.accessor()
    await rmR(accessor, spec('/data/sub'), await handed(accessor, spec('/data/sub')))
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst'])
  })

  it('rename moves a file to a new name under the dst parent', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await rename(
      accessor,
      spec('/data/a.txt'),
      spec('/data/b.txt'),
      await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt')),
    )
    expect((await account.child(ids.data, 'b.txt')).id).toBe(ids.a)
    expect(await account.names(ids.data)).toEqual(['b.txt', 'dst', 'sub'])
  })

  it('rename replaces an empty folder destination', async () => {
    const ids = await data()
    const accessor = account.accessor()
    await rename(
      accessor,
      spec('/data/sub'),
      spec('/data/dst'),
      await handed(accessor, spec('/data/sub'), spec('/data/dst')),
    )
    expect((await account.child(ids.data, 'dst')).id).toBe(ids.sub)
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst'])
  })

  it('rename refuses a non-empty folder destination with ENOTEMPTY', async () => {
    // The folder is asked for a child before anything moves, and the delete
    // goes with recursive=false, which 409s on one written since: either is
    // mv's "Directory not empty".
    const ids = await data()
    await account.put('x.txt', ENC.encode('x'), ids.dst)
    const accessor = account.accessor()
    await expect(
      rename(
        accessor,
        spec('/data/sub'),
        spec('/data/dst'),
        await handed(accessor, spec('/data/sub'), spec('/data/dst')),
      ),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
    expect(await account.names(ids.dst)).toEqual(['x.txt'])
  })

  it('rename propagates a destination error Box did not call a conflict', async () => {
    const ids = await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub'), spec('/data/dst'))
    await account.run.answerNext('DELETE', FOLDER_ROUTE, 500)
    await expect(rename(accessor, spec('/data/sub'), spec('/data/dst'), h)).rejects.toBeInstanceOf(
      BoxApiError,
    )
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
  })

  it('rename refuses a file onto a folder with EISDIR', async () => {
    // rename(2) answers EISDIR for a file onto a directory whether or not
    // that directory has children, so the type check outranks emptiness and
    // the folder is never deleted to find out.
    await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/sub'))
    await account.run.recordRequests()
    await expect(rename(accessor, spec('/data/a.txt'), spec('/data/sub'), h)).rejects.toMatchObject(
      { code: 'EISDIR' },
    )
    expect(await changes()).toEqual([])
  })

  it('rename refuses a folder onto a file with ENOTDIR', async () => {
    await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub'), spec('/data/a.txt'))
    await account.run.recordRequests()
    await expect(rename(accessor, spec('/data/sub'), spec('/data/a.txt'), h)).rejects.toMatchObject(
      { code: 'ENOTDIR' },
    )
    expect(await changes()).toEqual([])
  })

  it('copy refuses a file onto an existing folder with EISDIR', async () => {
    // cp refuses a type mismatch rather than replacing: this branch used to
    // recursively delete the destination folder.
    await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/sub'))
    await account.run.recordRequests()
    await expect(copy(accessor, spec('/data/a.txt'), spec('/data/sub'), h)).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await changes()).toEqual([])
  })

  it('copy refuses a folder onto an existing file with ENOTDIR', async () => {
    await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub'), spec('/data/a.txt'))
    await account.run.recordRequests()
    await expect(copy(accessor, spec('/data/sub'), spec('/data/a.txt'), h)).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    expect(await changes()).toEqual([])
  })

  it('copy copies a file into the dst parent, recorded once', async () => {
    const ids = await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/c.txt'))
    const [, records] = await recordingScope(() =>
      copy(accessor, spec('/data/a.txt'), spec('/data/c.txt'), h),
    )
    const made = await account.child(ids.data, 'c.txt')
    expect(text(await account.read(made.id))).toBe('hello')
    expect(records.map((r) => [r.op, r.path])).toEqual([['copy', '/data/c.txt']])
  })

  it('copy of a whole folder is recorded as a prefix', async () => {
    const ids = await data()
    await account.put('x.txt', ENC.encode('x'), ids.sub)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub'), spec('/data/new'))
    const [, records] = await recordingScope(() =>
      copy(accessor, spec('/data/sub'), spec('/data/new'), h),
    )
    const made = await account.child(ids.data, 'new')
    expect(await account.names(made.id)).toEqual(['x.txt'])
    expect(records.map((r) => [r.op, r.path])).toEqual([['copy_prefix', '/data/new']])
  })

  it('a merge records each folder before the next', async () => {
    // sub's x and y merge into dst one by one; dst's own y is a file, so y
    // stops the merge after x has landed. x is recorded by then.
    const ids = await data()
    await account.mkdir('x', ids.sub)
    await account.mkdir('y', ids.sub)
    await account.put('y', ENC.encode('y'), ids.dst)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub'), spec('/data/dst'))
    let caught: unknown = null
    const [, records] = await recordingScope(async () => {
      try {
        await copy(accessor, spec('/data/sub'), spec('/data/dst'), h)
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toMatchObject({ code: 'ENOTDIR' })
    expect(await account.names(ids.dst)).toEqual(['x', 'y'])
    expect(records.map((r) => [r.op, r.path])).toEqual([['copy_prefix', '/data/dst/x']])
  })

  it.each([
    ['lands', null],
    ['refused', 500],
  ])('a replaced file is recorded only once its copy lands (%s)', async (_name, status) => {
    const ids = await data()
    await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    if (status !== null) await account.run.answerNext('POST', COPY_FILE_ROUTE, status)
    let caught: unknown = null
    const [, records] = await recordingScope(async () => {
      try {
        await copy(accessor, spec('/data/a.txt'), spec('/data/b.txt'), h)
      } catch (err) {
        caught = err
      }
    })
    if (status === null) {
      expect(caught).toBeNull()
      const made = await account.child(ids.data, 'b.txt')
      expect(text(await account.read(made.id))).toBe('hello')
      expect(records.map((r) => [r.op, r.path])).toEqual([['copy', '/data/b.txt']])
    } else {
      expect(caught).toBeInstanceOf(BoxApiError)
      expect(records).toEqual([])
    }
    expect(await account.names(ids.data)).toEqual(['a.txt', 'b.txt', 'dst', 'sub'])
  })

  it('a refused delete drops the copy', async () => {
    // The copy lands beside b.txt under a staged name before b.txt goes, so a
    // refused delete leaves b.txt as it was and takes the copy back.
    const ids = await data()
    const other = await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    await account.run.answerNext('DELETE', FILE_ROUTE, 403)
    await expect(
      copy(accessor, spec('/data/a.txt'), spec('/data/b.txt'), h),
    ).rejects.toBeInstanceOf(BoxApiError)
    expect(await account.names(ids.data)).toEqual(['a.txt', 'b.txt', 'dst', 'sub'])
    expect(text(await account.read(other))).toBe('other')
  })

  it('rename replaces a file destination', async () => {
    const ids = await data()
    await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    await rename(accessor, spec('/data/a.txt'), spec('/data/b.txt'), h)
    expect((await account.child(ids.data, 'b.txt')).id).toBe(ids.a)
    expect(await account.names(ids.data)).toEqual(['b.txt', 'dst', 'sub'])
  })

  it('a refused rename keeps the destination file', async () => {
    const ids = await data()
    const other = await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    await account.run.answerNext('PUT', FILE_ROUTE, 403)
    await expect(
      rename(accessor, spec('/data/a.txt'), spec('/data/b.txt'), h),
    ).rejects.toBeInstanceOf(BoxApiError)
    expect(await account.names(ids.data)).toEqual(['a.txt', 'b.txt', 'dst', 'sub'])
    expect(text(await account.read(other))).toBe('other')
  })

  it('a refused delete moves the file back', async () => {
    const ids = await data()
    const moving = await account.put('c.txt', ENC.encode('c'), ids.sub)
    const other = await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/sub/c.txt'), spec('/data/b.txt'))
    await account.run.answerNext('DELETE', FILE_ROUTE, 403)
    await expect(
      rename(accessor, spec('/data/sub/c.txt'), spec('/data/b.txt'), h),
    ).rejects.toBeInstanceOf(BoxApiError)
    expect(await account.names(ids.data)).toEqual(['a.txt', 'b.txt', 'dst', 'sub'])
    expect((await account.child(ids.sub, 'c.txt')).id).toBe(moving)
    expect(text(await account.read(other))).toBe('other')
  })

  it('a refused move onto the freed name puts the destination back', async () => {
    // The file there moves aside, then the move onto the freed name is
    // refused: the file set aside takes its name back.
    const ids = await data()
    const other = await account.put('b.txt', ENC.encode('other'), ids.data)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    await account.run.answerNext('PUT', FILE_ROUTE, 403, undefined, 1, `/2.0/files/${ids.a}`)
    await expect(
      rename(accessor, spec('/data/a.txt'), spec('/data/b.txt'), h),
    ).rejects.toBeInstanceOf(BoxApiError)
    expect(await account.names(ids.data)).toEqual(['a.txt', 'b.txt', 'dst', 'sub'])
    expect(text(await account.read(other))).toBe('other')
  })

  it('refuses a folder holding only the item itself', async () => {
    // mv -T d/c d: moving the only child out would leave the folder empty for
    // its delete, so it is asked for a child before anything moves.
    const ids = await data()
    const inner = await account.mkdir('c', ids.dst)
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/dst/c'), spec('/data/dst'))
    await expect(rename(accessor, spec('/data/dst/c'), spec('/data/dst'), h)).rejects.toMatchObject(
      { code: 'ENOTEMPTY' },
    )
    expect(await account.names(ids.data)).toEqual(['a.txt', 'dst', 'sub'])
    expect((await account.child(ids.dst, 'c')).id).toBe(inner)
  })

  it('a rename onto its own name sends and records nothing', async () => {
    await data()
    const accessor = account.accessor()
    const h = await handed(accessor, spec('/data/a.txt'), spec('/data/a.txt'))
    await account.run.recordRequests()
    const [, records] = await recordingScope(() =>
      rename(accessor, spec('/data/a.txt'), spec('/data/a.txt'), h),
    )
    expect(await changes()).toEqual([])
    expect(records).toEqual([])
  })

  it('a write records the virtual path', async () => {
    // A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    const ids = await data()
    const path = new PathSpec({ virtual: '/m/m/k.txt', directory: '/m/m/', vfsPath: 'm/k.txt' })
    const parent = new FileStat({
      name: 'm',
      type: FileType.DIRECTORY,
      extra: { box_id: ids.data },
    })
    const [, records] = await recordingScope(() =>
      write(account.accessor(), path, HELLO, { entry: null, parent }),
    )
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
    expect(await account.names(ids.data)).toContain('k.txt')
  })
})

// [name, upload reply, expected fingerprint] for 5 written bytes: answers
// Box never gives but a client must read. 's5' is a token no local hash
// produces; a reply holding no file entry records none.
const BOX_REPLY_ROWS: [string, JsonValue, string | null][] = [
  [
    'agrees',
    {
      total_count: 1,
      entries: [
        {
          type: 'file',
          id: '500',
          name: 'f.txt',
          size: 5,
          sha1: 's5',
          modified_at: '2026-01-01T00:00:00Z',
          etag: '1',
        },
      ],
    },
    's5',
  ],
  ['no entries', { total_count: 0, entries: [] }, null],
  ['non-dict reply', ['not', 'a', 'dict'], null],
  ['empty reply', null, null],
]

describe.each([
  ['new', '/data/new.txt', NEW_FILE_ROUTE],
  ['version', '/data/a.txt', VERSION_ROUTE],
])('box write records the upload reply (%s)', (_kind, virtual, route) => {
  it.each(BOX_REPLY_ROWS)('%s', async (_name, reply, token) => {
    await data()
    await account.run.answerNext('POST', route, 201, reply)
    const accessor = account.accessor()
    const h = await handed(accessor, spec(virtual))
    const [, records] = await recordingScope(() => write(accessor, spec(virtual), HELLO, h))
    expect(records.map((r) => [r.op, r.path, r.bytes, r.fingerprint, r.revision])).toEqual([
      ['write', virtual, 5, token, null],
    ])
  })
})

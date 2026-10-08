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
import type * as ObserveModule from '../../observe/context.ts'
import type * as ApiModule from './api.ts'
import type * as ContextModule from '../../cache/context.ts'

const H = vi.hoisted(() => ({
  order: [] as string[],
}))

vi.mock('../../observe/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ObserveModule>()
  return {
    ...actual,
    record: (...args: Parameters<typeof actual.record>) => {
      H.order.push('record')
      actual.record(...args)
    },
  }
})

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return {
    ...actual,
    listFolderItems: vi.fn(),
    uploadNewFile: vi.fn(),
    uploadFileVersion: vi.fn(),
    createFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
    updateFile: vi.fn(),
    updateFolder: vi.fn(),
    copyFile: vi.fn(),
    copyFolder: vi.fn(),
  }
})

vi.mock('../../cache/context.ts', async () => {
  const actual = await vi.importActual<typeof ContextModule>('../../cache/context.ts')
  return {
    evictAfter: actual.evictAfter,
    invalidateAfterWrite: vi.fn(() => Promise.resolve()),
    invalidateAfterUnlink: vi.fn(() => Promise.resolve()),
    invalidateSubtree: vi.fn(() => Promise.resolve()),
    invalidateAfterMove: vi.fn(() => Promise.resolve()),
  }
})

import { BoxAccessor } from '../../accessor/box.ts'
import {
  invalidateAfterMove,
  invalidateAfterWrite,
  invalidateSubtree,
} from '../../cache/context.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import * as api from './api.ts'
import { copy } from './copy.ts'
import { mkdir } from './mkdir.ts'
import { rename } from './rename.ts'
import { rmR, rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const STUB_TM = {} as BoxTokenManager

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

const TREE: Record<string, ApiModule.BoxItem[]> = {
  '0': [{ type: 'folder', id: '100', name: 'data' }],
  '100': [
    { type: 'file', id: '200', name: 'a.txt', size: 5 },
    { type: 'folder', id: '300', name: 'sub' },
    { type: 'folder', id: '400', name: 'dst' },
  ],
  '300': [],
  '400': [],
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ vfsPath: virtual.replace(/^\/+/, ''), virtual, directory: virtual })
}

// Box's upload reply: a one-entry collection of the stored file.
function uploadReply(): unknown {
  const entry = {
    type: 'file',
    id: '500',
    name: 'f.txt',
    size: 5,
    sha1: 's5',
    modified_at: '2026-01-01T00:00:00Z',
    etag: '1',
  }
  return { total_count: 1, entries: [entry] }
}

describe('box write ops', () => {
  beforeEach(() => {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) =>
      Promise.resolve(TREE[folderId] ?? []),
    )
  })

  it('uploads a new file under the resolved parent', async () => {
    await write(makeAccessor(), spec('/data/new.txt'), new Uint8Array([1, 2]))
    expect(vi.mocked(api.uploadNewFile)).toHaveBeenCalledWith(
      STUB_TM,
      '100',
      'new.txt',
      new Uint8Array([1, 2]),
    )
  })

  it('uploads a new version when the file already exists', async () => {
    await write(makeAccessor(), spec('/data/a.txt'), new Uint8Array([9]))
    expect(vi.mocked(api.uploadFileVersion)).toHaveBeenCalledWith(
      STUB_TM,
      '200',
      'a.txt',
      new Uint8Array([9]),
    )
  })

  it('mkdir creates under the resolved parent', async () => {
    vi.mocked(api.createFolder).mockResolvedValue({ type: 'folder', id: '400', name: 'x' })
    await mkdir(makeAccessor(), spec('/data/x'))
    expect(vi.mocked(api.createFolder)).toHaveBeenCalledWith(STUB_TM, '100', 'x')
  })

  it.each([
    ['/data/a.txt/x', 'ENOTDIR'],
    ['/data/a.txt/x/y', 'ENOTDIR'],
    ['/data/missing/x', 'ENOENT'],
  ])('mkdir %s refuses a parent that is not a folder', async (virtual, code) => {
    vi.mocked(api.createFolder).mockClear()
    await expect(mkdir(makeAccessor(), spec(virtual))).rejects.toMatchObject({ code })
    expect(vi.mocked(api.createFolder)).not.toHaveBeenCalled()
  })

  it.each([
    ['/data/a.txt/x/y', 'ENOTDIR'],
    ['/data/a.txt', 'EEXIST'],
  ])('mkdir -p %s names the file it stops at', async (virtual, code) => {
    vi.mocked(api.createFolder).mockClear()
    await expect(mkdir(makeAccessor(), spec(virtual), true)).rejects.toMatchObject({
      code,
      virtualPath: '/data/a.txt',
    })
    expect(vi.mocked(api.createFolder)).not.toHaveBeenCalled()
  })

  it('mkdir of a taken name is EEXIST', async () => {
    vi.mocked(api.createFolder).mockRejectedValueOnce(
      new BoxApiError('Box POST /folders -> 409', 409),
    )
    await expect(mkdir(makeAccessor(), spec('/data/a.txt'))).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  it('unlink deletes a file by id', async () => {
    await unlink(makeAccessor(), spec('/data/a.txt'))
    expect(vi.mocked(api.deleteFile)).toHaveBeenCalledWith(STUB_TM, '200')
  })

  it('unlink on a folder throws EISDIR', async () => {
    await expect(unlink(makeAccessor(), spec('/data/sub'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('rmdir removes a folder non-recursively', async () => {
    await rmdir(makeAccessor(), spec('/data/sub'))
    expect(vi.mocked(api.deleteFolder)).toHaveBeenCalledWith(STUB_TM, '300', false)
  })

  it('rmR removes a folder recursively', async () => {
    await rmR(makeAccessor(), spec('/data/sub'))
    expect(vi.mocked(api.deleteFolder)).toHaveBeenCalledWith(STUB_TM, '300', true)
  })

  it('rename moves a file to a new name under the dst parent', async () => {
    await rename(makeAccessor(), spec('/data/a.txt'), spec('/data/b.txt'))
    expect(vi.mocked(api.updateFile)).toHaveBeenCalledWith(STUB_TM, '200', {
      name: 'b.txt',
      parentId: '100',
    })
  })

  function moves(): [string, boolean][] {
    return vi
      .mocked(invalidateAfterMove)
      .mock.calls.map(([path, folder]) => [typeof path === 'string' ? path : path.virtual, folder])
  }

  it('renaming a file drops no subtree', async () => {
    vi.mocked(invalidateAfterMove).mockClear()
    vi.mocked(invalidateAfterWrite).mockClear()
    vi.mocked(invalidateSubtree).mockClear()
    await rename(makeAccessor(), spec('/data/a.txt'), spec('/data/b.txt'))
    expect(moves()).toEqual([
      ['/data/b.txt', false],
      ['/data/a.txt', false],
    ])
    expect(vi.mocked(invalidateSubtree)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateAfterWrite)).not.toHaveBeenCalled()
  })

  it('renaming a folder drops both subtrees', async () => {
    vi.mocked(invalidateAfterMove).mockClear()
    await rename(makeAccessor(), spec('/data/sub'), spec('/data/moved'))
    expect(moves()).toEqual([
      ['/data/moved', true],
      ['/data/sub', true],
    ])
  })

  it('rename replaces an empty folder destination', async () => {
    vi.mocked(api.updateFolder).mockClear()
    await rename(makeAccessor(), spec('/data/sub'), spec('/data/dst'))
    expect(vi.mocked(api.deleteFolder)).toHaveBeenCalledWith(STUB_TM, '400', false)
    expect(vi.mocked(api.updateFolder)).toHaveBeenCalledWith(STUB_TM, '300', {
      name: 'dst',
      parentId: '100',
    })
  })

  it('rename refuses a non-empty folder destination with ENOTEMPTY', async () => {
    // Box decides the emptiness, not us: recursive=false 409s on a folder
    // with children, and that is mv's "Directory not empty".
    vi.mocked(api.updateFolder).mockClear()
    vi.mocked(api.deleteFolder).mockRejectedValueOnce(new BoxApiError('conflict', 409))
    await expect(
      rename(makeAccessor(), spec('/data/sub'), spec('/data/dst')),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(vi.mocked(api.updateFolder)).not.toHaveBeenCalled()
  })

  it('rename propagates a destination error Box did not call a conflict', async () => {
    vi.mocked(api.updateFolder).mockClear()
    vi.mocked(api.deleteFolder).mockRejectedValueOnce(new BoxApiError('boom', 500))
    await expect(
      rename(makeAccessor(), spec('/data/sub'), spec('/data/dst')),
    ).rejects.toBeInstanceOf(BoxApiError)
    expect(vi.mocked(api.updateFolder)).not.toHaveBeenCalled()
  })

  it('rename refuses a file onto a folder with EISDIR', async () => {
    // rename(2) answers EISDIR for a file onto a directory whether or not
    // that directory has children, so the type check outranks emptiness and
    // the folder is never deleted to find out.
    vi.mocked(api.deleteFolder).mockClear()
    vi.mocked(api.updateFile).mockClear()
    await expect(
      rename(makeAccessor(), spec('/data/a.txt'), spec('/data/sub')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(vi.mocked(api.deleteFolder)).not.toHaveBeenCalled()
    expect(vi.mocked(api.updateFile)).not.toHaveBeenCalled()
  })

  it('rename refuses a folder onto a file with ENOTDIR', async () => {
    vi.mocked(api.deleteFile).mockClear()
    vi.mocked(api.updateFolder).mockClear()
    await expect(
      rename(makeAccessor(), spec('/data/sub'), spec('/data/a.txt')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(vi.mocked(api.deleteFile)).not.toHaveBeenCalled()
    expect(vi.mocked(api.updateFolder)).not.toHaveBeenCalled()
  })

  it('copy refuses a file onto an existing folder with EISDIR', async () => {
    // cp refuses a type mismatch rather than replacing: this branch used to
    // recursively delete the destination folder.
    vi.mocked(api.copyFile).mockClear()
    vi.mocked(api.deleteFile).mockClear()
    await expect(
      copy(makeAccessor(), spec('/data/a.txt'), spec('/data/sub')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(vi.mocked(api.copyFile)).not.toHaveBeenCalled()
    expect(vi.mocked(api.deleteFile)).not.toHaveBeenCalled()
  })

  it('copy refuses a folder onto an existing file with ENOTDIR', async () => {
    vi.mocked(api.deleteFile).mockClear()
    await expect(
      copy(makeAccessor(), spec('/data/sub'), spec('/data/a.txt')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(vi.mocked(api.deleteFile)).not.toHaveBeenCalled()
  })

  it('copy copies a file into the dst parent', async () => {
    await copy(makeAccessor(), spec('/data/a.txt'), spec('/data/c.txt'))
    expect(vi.mocked(api.copyFile)).toHaveBeenCalledWith(STUB_TM, '200', '100', 'c.txt')
  })

  const COPY_TREE: Record<string, ApiModule.BoxItem[]> = {
    '0': [{ type: 'folder', id: '100', name: 'data' }],
    '100': [
      { type: 'file', id: '200', name: 'a.txt', size: 5 },
      { type: 'file', id: '210', name: 'b.txt', size: 5 },
      { type: 'folder', id: '300', name: 'sub' },
      { type: 'folder', id: '400', name: 'dst' },
    ],
    '300': [{ type: 'file', id: '310', name: 'x.txt', size: 3 }],
    '400': [{ type: 'file', id: '410', name: 'x.txt', size: 3 }],
  }

  it.each<[string, string, string, boolean, string | null, string[][]]>([
    [
      'file-ok',
      '/data/a.txt',
      '/data/c.txt',
      false,
      null,
      [
        ['copyFile', 'c.txt'],
        ['write', '/data/c.txt'],
      ],
    ],
    [
      'file-fails',
      '/data/a.txt',
      '/data/b.txt',
      true,
      'copy failed',
      [
        ['deleteFile', '210'],
        ['copyFile', 'b.txt'],
        ['write', '/data/b.txt'],
      ],
    ],
    [
      'folder-ok',
      '/data/sub',
      '/data/new',
      false,
      null,
      [
        ['copyFolder', 'new'],
        ['subtree', '/data/new'],
      ],
    ],
    [
      'folder-fails',
      '/data/sub',
      '/data/dst',
      true,
      'copy failed',
      [
        ['deleteFile', '410'],
        ['copyFile', 'x.txt'],
        ['subtree', '/data/dst'],
      ],
    ],
    ['refused', '/data/sub', '/data/a.txt', false, 'ENOTDIR', [['subtree', '/data/a.txt']]],
  ])('a copy evicts after it ends: %s', async (_row, src, dst, fails, raised, expected) => {
    const events: string[][] = []
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) =>
      Promise.resolve(COPY_TREE[folderId] ?? []),
    )
    vi.mocked(api.copyFile).mockImplementation((_tm, _id, _parent, name) => {
      events.push(['copyFile', name ?? ''])
      if (fails) return Promise.reject(new Error('copy failed'))
      return Promise.resolve({} as ApiModule.BoxItem)
    })
    vi.mocked(api.copyFolder).mockImplementation((_tm, _id, _parent, name) => {
      events.push(['copyFolder', name ?? ''])
      return Promise.resolve({} as ApiModule.BoxItem)
    })
    vi.mocked(api.deleteFile).mockImplementation((_tm, id) => {
      events.push(['deleteFile', id])
      return Promise.resolve()
    })
    vi.mocked(invalidateAfterWrite).mockImplementation((path) => {
      events.push(['write', typeof path === 'string' ? path : path.virtual])
      return Promise.resolve()
    })
    vi.mocked(invalidateSubtree).mockImplementation((path) => {
      events.push(['subtree', typeof path === 'string' ? path : path.virtual])
      return Promise.resolve()
    })
    try {
      const copied = copy(makeAccessor(), spec(src), spec(dst))
      if (raised === 'copy failed') await expect(copied).rejects.toThrow(raised)
      else if (raised !== null) await expect(copied).rejects.toMatchObject({ code: raised })
      else await copied
      expect(events).toEqual(expected)
    } finally {
      vi.mocked(api.copyFile).mockReset()
      vi.mocked(api.copyFolder).mockReset()
      vi.mocked(api.deleteFile).mockReset()
      vi.mocked(invalidateAfterWrite).mockReset()
      vi.mocked(invalidateSubtree).mockReset()
    }
  })
})

// [name, upload reply, expected fingerprint] for 5 written bytes. 's5' is a
// token no local hash produces; a reply holding no file entry records none.
const BOX_REPLY_ROWS: [string, unknown, string | null][] = [
  ['agrees', uploadReply(), 's5'],
  ['no entries', { total_count: 0, entries: [] }, null],
  ['non-dict reply', ['not', 'a', 'dict'], null],
  ['empty reply', null, null],
]

describe.each([
  ['new', '/data/new.txt'],
  ['version', '/data/a.txt'],
])('box write records the upload reply (%s)', (_kind, virtual) => {
  beforeEach(() => {
    H.order = []
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) =>
      Promise.resolve(TREE[folderId] ?? []),
    )
    vi.mocked(invalidateAfterWrite).mockImplementation(() => {
      H.order.push('invalidate')
      return Promise.resolve()
    })
  })

  async function writeRecorded(reply: unknown): Promise<unknown[][]> {
    vi.mocked(api.uploadNewFile).mockResolvedValue(reply as never)
    vi.mocked(api.uploadFileVersion).mockResolvedValue(reply as never)
    const [, records] = await runWithRecording(() =>
      write(makeAccessor(), spec(virtual), new TextEncoder().encode('hello')),
    )
    return records.map((r) => [r.op, r.path, r.bytes, r.fingerprint, r.revision])
  }

  it.each(BOX_REPLY_ROWS)('%s', async (_name, reply, token) => {
    expect(await writeRecorded(reply)).toEqual([['write', virtual, 5, token, null]])
    // Recorded before the eviction, so the record exists when the cache
    // reacts to the write.
    expect(H.order).toEqual(['record', 'invalidate'])
  })

  it('a write whose reply fails still evicts the path', async () => {
    // Box may have stored the bytes before the reply broke off, so the cached
    // copy is stale either way.
    vi.mocked(api.uploadNewFile).mockRejectedValue(new Error('reply cut off'))
    vi.mocked(api.uploadFileVersion).mockRejectedValue(new Error('reply cut off'))
    await expect(
      write(makeAccessor(), spec(virtual), new TextEncoder().encode('hello')),
    ).rejects.toThrow('reply cut off')
    expect(H.order).toEqual(['invalidate'])
  })
})

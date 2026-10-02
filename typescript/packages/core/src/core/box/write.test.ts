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
import type * as ApiModule from './api.ts'
import type * as ContextModule from '../../cache/context.ts'

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
  }
})

vi.mock('../../cache/context.ts', async () => {
  const actual = await vi.importActual<typeof ContextModule>('../../cache/context.ts')
  return {
    evictAfter: actual.evictAfter,
    invalidateAfterWrite: vi.fn(),
    invalidateAfterUnlink: vi.fn(),
    invalidateSubtree: vi.fn(),
    settleAfterWrite: vi.fn(),
    writeGeneration: vi.fn(() => 5),
  }
})

import { BoxAccessor } from '../../accessor/box.ts'
import {
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateSubtree,
  settleAfterWrite,
  writeGeneration,
} from '../../cache/context.ts'
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

  for (const [target, upload] of [
    ['/data/new.txt', 'uploadNewFile'],
    ['/data/a.txt', 'uploadFileVersion'],
  ] as const) {
    it(`settles its bytes without a receipt (${upload})`, async () => {
      vi.mocked(settleAfterWrite).mockClear()
      vi.mocked(invalidateAfterWrite).mockClear()
      await write(makeAccessor(), spec(target), new Uint8Array([7]))
      expect(vi.mocked(api[upload])).toHaveBeenCalled()
      expect(vi.mocked(settleAfterWrite)).toHaveBeenCalledWith(
        spec(target),
        new Uint8Array([7]),
        null,
        5,
      )
      expect(vi.mocked(invalidateAfterWrite)).not.toHaveBeenCalled()
    })
  }

  for (const target of ['/data/new.txt', '/data/a.txt']) {
    it(`a change during the lookup reaches settle (${target})`, async () => {
      // The item id a lookup resolves can move (a concurrent mv) before the
      // upload: the generation is noted before the lookup, so a change that
      // lands during it makes settle drop the bytes.
      let generation = 5
      vi.mocked(writeGeneration).mockImplementation(() => generation)
      vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) => {
        generation = 6
        return Promise.resolve(TREE[folderId] ?? [])
      })
      vi.mocked(settleAfterWrite).mockClear()
      try {
        await write(makeAccessor(), spec(target), new Uint8Array([7]))
        expect(vi.mocked(settleAfterWrite).mock.calls.map((c) => c[3])).toEqual([5])
      } finally {
        vi.mocked(writeGeneration).mockImplementation(() => 5)
      }
    })
  }

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

  it('rename evicts both identities as subtrees, so a replaced dir loses its listing', async () => {
    vi.mocked(invalidateAfterWrite).mockClear()
    vi.mocked(invalidateAfterUnlink).mockClear()
    vi.mocked(invalidateSubtree).mockClear()
    await rename(makeAccessor(), spec('/data/a.txt'), spec('/data/b.txt'))
    // Subtrees rather than unlinks: renaming a directory strands every
    // listing and body cached below the old name, and below the new one.
    const evicted = vi
      .mocked(invalidateSubtree)
      .mock.calls.map(([path]) => (typeof path === 'string' ? path : path.virtual))
    expect(evicted).toEqual(['/data/b.txt', '/data/a.txt'])
    expect(vi.mocked(invalidateAfterUnlink)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateAfterWrite)).not.toHaveBeenCalled()
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
  for (const [label, copyFile] of [
    ['', () => Promise.resolve({})],
    [' that fails', () => Promise.reject(new Error('copy failed'))],
  ] as const) {
    it(`copy of a folder${label} evicts the merged destination subtree`, async () => {
      // Merging into an existing folder replaces children the caller never
      // named, and their bytes were cached under their own keys: evicting
      // only the folder left the old child served. A merge that fails
      // partway may have landed some children already.
      const merge: Record<string, ApiModule.BoxItem[]> = {
        ...TREE,
        '300': [{ type: 'file', id: '310', name: 'x.txt', size: 3 }],
        '400': [{ type: 'file', id: '410', name: 'x.txt', size: 3 }],
      }
      vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId) =>
        Promise.resolve(merge[folderId] ?? []),
      )
      vi.mocked(api.copyFile).mockImplementation(copyFile as typeof api.copyFile)
      vi.mocked(invalidateSubtree).mockClear()
      await copy(makeAccessor(), spec('/data/sub'), spec('/data/dst')).catch(() => undefined)
      expect(vi.mocked(invalidateSubtree)).toHaveBeenCalledWith(
        expect.objectContaining({ virtual: '/data/dst' }),
      )
      vi.mocked(api.copyFile).mockReset()
    })
  }
})

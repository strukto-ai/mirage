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
    copyFile: vi.fn(),
  }
})

vi.mock('../../cache/context.ts', () => {
  return { invalidateAfterWrite: vi.fn(), invalidateAfterUnlink: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { PathSpec } from '../../types.ts'
import type { BoxTokenManager } from './_client.ts'
import * as api from './api.ts'
import { copy, mkdir, rename, rmR, rmdir, unlink, write } from './write.ts'

const STUB_TM = {} as BoxTokenManager

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

const TREE: Record<string, ApiModule.BoxItem[]> = {
  '0': [{ type: 'folder', id: '100', name: 'data' }],
  '100': [
    { type: 'file', id: '200', name: 'a.txt', size: 5 },
    { type: 'folder', id: '300', name: 'sub' },
  ],
  '300': [],
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ resourcePath: virtual.replace(/^\/+/, ''), virtual, directory: virtual })
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

  it('copy copies a file into the dst parent', async () => {
    await copy(makeAccessor(), spec('/data/a.txt'), spec('/data/c.txt'))
    expect(vi.mocked(api.copyFile)).toHaveBeenCalledWith(STUB_TM, '200', '100', 'c.txt')
  })
})

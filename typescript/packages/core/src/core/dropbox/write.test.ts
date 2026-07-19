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

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as ClientModule from './_client.ts'
import type * as ApiModule from './api.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, dropboxUpload: vi.fn() }
})

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return {
    ...actual,
    getMetadata: vi.fn(),
    createFolder: vi.fn(),
    deletePath: vi.fn(),
    movePath: vi.fn(),
    copyPath: vi.fn(),
    listFolder: vi.fn(),
  }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import * as client from './_client.ts'
import { DropboxApiError, type DropboxTokenManager } from './_client.ts'
import * as api from './api.ts'
import { copy } from './copy.ts'
import { exists } from './exists.ts'
import { mkdir } from './mkdir.ts'
import { rename } from './rename.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(rootPath?: string): DropboxAccessor {
  return new DropboxAccessor({
    tokenManager: STUB_TM,
    ...(rootPath !== undefined ? { rootPath } : {}),
  })
}

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function fileEntry(path: string): ApiModule.DropboxEntry {
  return { '.tag': 'file', id: `id:${path}`, name: path.split('/').pop() ?? '', size: 1 }
}

function folderEntry(path: string): ApiModule.DropboxEntry {
  return { '.tag': 'folder', id: `id:${path}`, name: path.split('/').pop() ?? '' }
}

const NOT_FOUND = new DropboxApiError('nf', 409, 'path/not_found/...')

beforeEach(() => {
  vi.resetAllMocks()
})

describe('dropbox write', () => {
  it('uploads through the subfolder mount root', async () => {
    await write(makeAccessor('/Team/data'), spec('/note.txt'), new Uint8Array([104]))
    expect(client.dropboxUpload).toHaveBeenCalledWith(
      STUB_TM,
      '/Team/data/note.txt',
      new Uint8Array([104]),
    )
  })
})

describe('dropbox mkdir', () => {
  it('creates a folder when the parent exists', async () => {
    vi.mocked(api.getMetadata).mockImplementation((_tm, p) =>
      p === '/docs' ? Promise.reject(NOT_FOUND) : Promise.resolve(folderEntry(p)),
    )
    await mkdir(makeAccessor(), spec('/docs'))
    expect(api.createFolder).toHaveBeenCalledWith(STUB_TM, '/docs')
  })

  it('rejects an existing path with EEXIST', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(folderEntry('/docs'))
    await expect(mkdir(makeAccessor(), spec('/docs'))).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('is idempotent for an existing dir with parents', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(folderEntry('/docs'))
    await mkdir(makeAccessor(), spec('/docs'), true)
    expect(api.createFolder).not.toHaveBeenCalled()
  })

  it('rejects a missing parent without parents', async () => {
    vi.mocked(api.getMetadata).mockRejectedValue(NOT_FOUND)
    await expect(mkdir(makeAccessor(), spec('/a/b'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(api.createFolder).not.toHaveBeenCalled()
  })
})

describe('dropbox unlink', () => {
  it('deletes a file', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(fileEntry('/a.txt'))
    await unlink(makeAccessor(), spec('/a.txt'))
    expect(api.deletePath).toHaveBeenCalledWith(STUB_TM, '/a.txt')
  })

  it('refuses a folder with EISDIR', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(folderEntry('/docs'))
    await expect(unlink(makeAccessor(), spec('/docs'))).rejects.toMatchObject({ code: 'EISDIR' })
    expect(api.deletePath).not.toHaveBeenCalled()
  })
})

describe('dropbox rmdir', () => {
  it('fails ENOTEMPTY instead of recursively deleting', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(folderEntry('/docs'))
    vi.mocked(api.listFolder).mockResolvedValue([fileEntry('/docs/a.txt')])
    await expect(rmdir(makeAccessor(), spec('/docs'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(api.deletePath).not.toHaveBeenCalled()
  })

  it('removes an empty folder', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(folderEntry('/docs'))
    vi.mocked(api.listFolder).mockResolvedValue([])
    await rmdir(makeAccessor(), spec('/docs'))
    expect(api.deletePath).toHaveBeenCalledWith(STUB_TM, '/docs')
  })

  it('refuses a file with ENOTDIR', async () => {
    vi.mocked(api.getMetadata).mockResolvedValue(fileEntry('/a.txt'))
    await expect(rmdir(makeAccessor(), spec('/a.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('dropbox rmR', () => {
  it('deletes recursively in one call', async () => {
    await rmR(makeAccessor(), spec('/docs'))
    expect(api.deletePath).toHaveBeenCalledWith(STUB_TM, '/docs')
  })

  it('maps a missing path to ENOENT', async () => {
    vi.mocked(api.deletePath).mockRejectedValue(
      new DropboxApiError('nf', 409, 'path_lookup/not_found/...'),
    )
    await expect(rmR(makeAccessor(), spec('/ghost'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('dropbox rename', () => {
  it('replaces an existing destination file like GNU mv', async () => {
    vi.mocked(api.movePath)
      .mockRejectedValueOnce(new DropboxApiError('conflict', 409, 'to/conflict/file/...'))
      .mockResolvedValueOnce(undefined)
    vi.mocked(api.getMetadata).mockResolvedValue(fileEntry('/b.txt'))
    await rename(makeAccessor(), spec('/a.txt'), spec('/b.txt'))
    expect(api.deletePath).toHaveBeenCalledWith(STUB_TM, '/b.txt')
    expect(api.movePath).toHaveBeenCalledTimes(2)
  })

  it('maps a missing source to ENOENT', async () => {
    vi.mocked(api.movePath).mockRejectedValue(
      new DropboxApiError('nf', 409, 'from_lookup/not_found/...'),
    )
    await expect(rename(makeAccessor(), spec('/ghost'), spec('/b'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('dropbox copy', () => {
  it('copies server-side under the mount root', async () => {
    await copy(makeAccessor('/Team'), spec('/a.txt'), spec('/b.txt'))
    expect(api.copyPath).toHaveBeenCalledWith(STUB_TM, '/Team/a.txt', '/Team/b.txt')
  })
})

describe('dropbox exists', () => {
  it('is true for the mount root without an API call', async () => {
    expect(await exists(makeAccessor(), spec('/'))).toBe(true)
    expect(api.getMetadata).not.toHaveBeenCalled()
  })

  it('maps 409 to false', async () => {
    vi.mocked(api.getMetadata).mockRejectedValue(NOT_FOUND)
    expect(await exists(makeAccessor(), spec('/ghost'))).toBe(false)
  })
})

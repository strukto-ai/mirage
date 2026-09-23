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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolder: vi.fn(), getMetadata: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { readdir } from './readdir.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

describe('dropbox readdir', () => {
  it('lists root entries with file/folder distinction', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'folder',
        id: 'id:folder1',
        name: 'docs',
        path_display: '/docs',
      },
      {
        '.tag': 'file',
        id: 'id:file1',
        name: 'notes.txt',
        path_display: '/notes.txt',
        size: 42,
        server_modified: '2026-04-01T00:00:00Z',
      },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toEqual(['/docs/', '/notes.txt'])
  })

  it('lists nested subfolder using cached parent', async () => {
    vi.mocked(api.listFolder).mockImplementation((_tm, p: string) => {
      if (p === '' || p === '/') {
        return Promise.resolve([
          { '.tag': 'folder', id: 'id:docs', name: 'docs', path_display: '/docs' },
        ])
      }
      if (p === '/docs') {
        return Promise.resolve([
          {
            '.tag': 'file',
            id: 'id:n1',
            name: 'note.md',
            path_display: '/docs/note.md',
            size: 12,
          },
        ])
      }
      throw new Error(`unexpected path=${p}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(accessor, new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }), index)
    const out = await readdir(
      accessor,
      new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
      index,
    )
    expect(out).toContain('/docs/note.md')
  })

  it('scopes listings under a subfolder mount root', async () => {
    vi.mocked(api.listFolder).mockImplementation((_tm, p: string) => {
      if (p === '/Team/data') {
        return Promise.resolve([
          { '.tag': 'folder', id: 'id:docs', name: 'docs', path_display: '/Team/data/docs' },
        ])
      }
      if (p === '/Team/data/docs') {
        return Promise.resolve([
          {
            '.tag': 'file',
            id: 'id:n1',
            name: 'note.md',
            path_display: '/Team/data/docs/note.md',
            size: 12,
          },
        ])
      }
      throw new Error(`unexpected path=${p}`)
    })

    const accessor = new DropboxAccessor({ tokenManager: STUB_TM, rootPath: '/Team/data' })
    const index = new RAMIndexCacheStore()
    const root = await readdir(
      accessor,
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(root).toEqual(['/docs/'])
    const nested = await readdir(
      accessor,
      new PathSpec({ vfsPath: 'docs', virtual: '/docs', directory: '/docs' }),
      index,
    )
    expect(nested).toEqual(['/docs/note.md'])
  })

  it('honors prefix when constructing virtual path', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      { '.tag': 'file', id: 'id:f', name: 'a.txt', path_display: '/a.txt', size: 1 },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({
        virtual: '/dropbox',
        directory: '/dropbox',
        vfsPath: mountKey('/dropbox', '/dropbox'),
      }),
      index,
    )
    expect(out).toEqual(['/dropbox/a.txt'])
  })

  it('reports ENOTDIR for an operand under a file', async () => {
    // list_folder answers path/not_found for `/a.txt/x` exactly as it does
    // for a name that is simply absent, so only the ancestor walk can tell
    // GNU's "Not a directory" from "No such file or directory".
    vi.mocked(api.listFolder).mockRejectedValue(new DropboxApiError('path/not_found', 409))
    vi.mocked(api.getMetadata).mockImplementation((_tm, path: string) => {
      if (path === '/a.txt') return Promise.resolve({ '.tag': 'file', name: 'a.txt' })
      return Promise.reject(new DropboxApiError('path/not_found', 409))
    })
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({ vfsPath: 'a.txt/x', virtual: '/a.txt/x', directory: '/a.txt/x' }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reports ENOENT for a path no component of which exists', async () => {
    vi.mocked(api.listFolder).mockRejectedValue(new DropboxApiError('path/not_found', 409))
    vi.mocked(api.getMetadata).mockRejectedValue(new DropboxApiError('path/not_found', 409))
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          vfsPath: 'nope/deeper',
          virtual: '/nope/deeper',
          directory: '/nope/deeper',
        }),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('indexes 0-byte files with size 0', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:empty',
        name: 'empty.txt',
        path_display: '/empty.txt',
        size: 0,
        server_modified: '2026-04-01T00:00:00Z',
      },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ vfsPath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toEqual(['/empty.txt'])
    const entry = (await index.get('/empty.txt')).entry
    expect(entry?.size).toBe(0)
  })
})

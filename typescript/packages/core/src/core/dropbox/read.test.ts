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
import type * as ClientModule from './_client.ts'
import type * as ApiModule from './api.ts'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, dropboxDownload: vi.fn() }
})

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, listFolder: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import * as client from './_client.ts'
import type { DropboxTokenManager } from './_client.ts'
import * as api from './api.ts'
import { read } from './read.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

describe('dropbox read', () => {
  it('downloads a file by stripping prefix and using path-based API', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      {
        '.tag': 'file',
        id: 'id:1',
        name: 'note.txt',
        path_display: '/note.txt',
        size: 5,
      },
    ])
    vi.mocked(client.dropboxDownload).mockResolvedValue(new Uint8Array([104, 105, 33]))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const data = await read(
      accessor,
      new PathSpec({
        virtual: '/dropbox/note.txt',
        directory: '/dropbox',
        resourcePath: mountKey('/dropbox/note.txt', '/dropbox'),
      }),
      index,
    )
    expect(data).toEqual(new Uint8Array([104, 105, 33]))
    expect(client.dropboxDownload).toHaveBeenCalledWith(STUB_TM, '/note.txt')
  })

  it('throws EISDIR when path resolves to a folder', async () => {
    vi.mocked(api.listFolder).mockResolvedValue([
      { '.tag': 'folder', id: 'id:f', name: 'docs', path_display: '/docs' },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await expect(
      read(
        accessor,
        new PathSpec({ resourcePath: 'docs', virtual: '/docs', directory: '/docs' }),
        index,
      ),
    ).rejects.toThrow(/EISDIR/)
  })
})

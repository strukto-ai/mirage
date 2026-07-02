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
  return { ...actual, listFolderItems: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { BoxTokenManager } from './_client.ts'
import * as api from './api.ts'
import { readdir } from './readdir.ts'

const STUB_TM = {} as BoxTokenManager

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

describe('box readdir', () => {
  it('lists root via folder id 0', async () => {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId: string) => {
      if (folderId === '0') {
        return Promise.resolve([
          {
            type: 'folder' as const,
            id: '111',
            name: 'docs',
            modified_at: '2026-04-01T00:00:00Z',
          },
          {
            type: 'file' as const,
            id: '222',
            name: 'notes.txt',
            size: 12,
            modified_at: '2026-04-01T00:00:00Z',
          },
        ])
      }
      throw new Error(`unexpected folderId=${folderId}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }),
      index,
    )
    expect(out).toEqual(['/docs/', '/notes.txt'])
  })

  it('walks up to parent to resolve subfolder ID', async () => {
    vi.mocked(api.listFolderItems).mockImplementation((_tm, folderId: string) => {
      if (folderId === '0') {
        return Promise.resolve([{ type: 'folder' as const, id: '111', name: 'docs' }])
      }
      if (folderId === '111') {
        return Promise.resolve([{ type: 'file' as const, id: '222', name: 'note.md', size: 5 }])
      }
      throw new Error(`unexpected folderId=${folderId}`)
    })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ resourcePath: 'docs', virtual: '/docs', directory: '/docs' }),
      index,
    )
    expect(out).toContain('/docs/note.md')
  })

  it('honors prefix when constructing virtual path', async () => {
    vi.mocked(api.listFolderItems).mockResolvedValue([
      { type: 'file' as const, id: '333', name: 'a.txt', size: 1 },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await readdir(
      accessor,
      new PathSpec({ virtual: '/box', directory: '/box', resourcePath: mountKey('/box', '/box') }),
      index,
    )
    expect(out).toEqual(['/box/a.txt'])
  })
})

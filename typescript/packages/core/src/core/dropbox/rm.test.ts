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
import type * as ContextModule from '../../cache/context.ts'
import type * as ObserveModule from '../../observe/context.ts'

const H = vi.hoisted(() => ({ log: [] as string[] }))

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return {
    ...actual,
    lookup: vi.fn(() => Promise.resolve({ '.tag': 'folder', name: 'd' })),
    listFolder: vi.fn((_tm: unknown, _path: string, opts?: { limit?: number }) =>
      Promise.resolve(
        opts?.limit !== undefined
          ? []
          : [
              { '.tag': 'file', name: 'a', content_hash: 's', rev: '1' },
              { '.tag': 'file', name: 'b', content_hash: 't', rev: '1' },
            ],
      ),
    ),
    deletePath: vi.fn((_tm: unknown, path: string) => {
      H.log.push(`delete ${path}`)
      return Promise.resolve()
    }),
  }
})

vi.mock('../../cache/context.ts', async () => {
  const actual = await vi.importActual<typeof ContextModule>('../../cache/context.ts')
  return {
    ...actual,
    conditioned: vi.fn(() => true),
    heldVersions: vi.fn((paths: unknown[]) => Promise.resolve(paths.map(() => null))),
    invalidateAfterUnlink: vi.fn(() => Promise.resolve()),
    invalidateAncestors: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('../../observe/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ObserveModule>()
  return {
    ...actual,
    record: (...args: Parameters<typeof actual.record>) => {
      H.log.push(`${args[0]} ${args[1]}`)
      actual.record(...args)
    },
  }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import type { DropboxTokenManager } from './client.ts'
import { rmR } from './rm.ts'

describe('dropbox conditional rm -r', () => {
  it('records each removal before the next', async () => {
    H.log = []
    const accessor = new DropboxAccessor({ tokenManager: {} as DropboxTokenManager })
    await rmR(accessor, PathSpec.fromStrPath('/d'))
    expect(H.log).toEqual([
      'delete /d/a',
      'unlink /d/a',
      'delete /d/b',
      'unlink /d/b',
      'delete /d',
      'rm_r /d',
    ])
  })
})

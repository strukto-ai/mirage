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

// Mirror of python/tests/core/dropbox/test_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, searchFiles: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import * as api from './api.ts'
import { filesContaining } from './search.ts'

const STUB_TM = {} as DropboxTokenManager
const search = vi.mocked(api.searchFiles)

function makeAccessor(rootPath?: string): DropboxAccessor {
  return new DropboxAccessor({
    tokenManager: STUB_TM,
    ...(rootPath !== undefined ? { rootPath } : {}),
  })
}

function mountRoot(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', vfsPath: '' })
}

function subdir(): PathSpec {
  return new PathSpec({ virtual: '/data/docs', directory: '/data/docs', vfsPath: 'docs' })
}

beforeEach(() => {
  search.mockReset()
})

async function ask(
  paths: [string, string][],
  scope: PathSpec,
  rootPath?: string,
  truncated = false,
): Promise<[string[] | null, unknown]> {
  search.mockResolvedValueOnce({ paths, truncated })
  const out = await filesContaining(makeAccessor(rootPath), 'needle', [scope])
  return [out === null ? null : out.map((p) => p.virtual), search.mock.calls[0]?.[2]]
}

describe('filesContaining', () => {
  it('names each hit from its display path', async () => {
    const paths: [string, string][] = [
      ['/x.txt', '/x.txt'],
      ['/sub/y.txt', '/Sub/Y.txt'],
    ]
    expect(await ask(paths, mountRoot())).toEqual([
      ['/data/x.txt', '/data/Sub/Y.txt'],
      { path: '' },
    ])
  })

  it('strips the root path case-insensitively', async () => {
    const paths: [string, string][] = [['/team/sub/a.txt', '/Team/Sub/A.txt']]
    expect(await ask(paths, mountRoot(), '/Team')).toEqual([['/data/Sub/A.txt'], { path: '/Team' }])
  })

  it('drops hits outside the scope', async () => {
    const paths: [string, string][] = [
      ['/docs/in.txt', '/docs/in.txt'],
      ['/other/out.txt', '/other/out.txt'],
    ]
    expect(await ask(paths, subdir())).toEqual([['/data/docs/in.txt'], { path: '/docs' }])
  })

  // No hit is distrusted too: Dropbox indexes a write after it lands.
  it.each<[string, [string, string][], boolean]>([
    ['a truncated answer', [['/x.txt', '/x.txt']], true],
    ['no hit', [], false],
  ])('is null for %s', async (_name, paths, truncated) => {
    expect((await ask(paths, mountRoot(), undefined, truncated))[0]).toBeNull()
  })

  it('is null for an API failure', async () => {
    search.mockRejectedValueOnce(new DropboxApiError('boom', 500))
    expect(await filesContaining(makeAccessor(), 'needle', [mountRoot()])).toBeNull()
  })
})

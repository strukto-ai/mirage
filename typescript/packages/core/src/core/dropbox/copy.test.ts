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

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, copyPath: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import * as api from './api.ts'
import type { DropboxTokenManager } from './client.ts'
import { dirCopy } from './copy.ts'

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: {} as DropboxTokenManager })
}

describe('dropbox dirCopy', () => {
  it('copies the tree in one request', async () => {
    vi.mocked(api.copyPath).mockResolvedValueOnce(undefined)
    await dirCopy(makeAccessor(), PathSpec.fromStrPath('/src'), PathSpec.fromStrPath('/dst'))
    expect(vi.mocked(api.copyPath).mock.calls.at(-1)?.slice(1)).toEqual(['/src', '/dst'])
  })
})

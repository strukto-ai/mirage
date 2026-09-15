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
  return { ...actual, getFolderInfo: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { PathSpec } from '../../types.ts'
import * as api from './api.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import { stat } from './stat.ts'

const STUB_TM = {} as BoxTokenManager
const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM })
}

describe('box stat of the mount root', () => {
  it('reads a 404 on the configured root folder as absence', async () => {
    vi.mocked(api.getFolderInfo).mockRejectedValue(
      new BoxApiError('Box GET /folders/0 -> 404 not_found', 404),
    )
    await expect(stat(makeAccessor(), ROOT)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a server error on the configured root stay a failure', async () => {
    vi.mocked(api.getFolderInfo).mockRejectedValue(
      new BoxApiError('Box GET /folders/0 -> 500 internal', 500),
    )
    await expect(stat(makeAccessor(), ROOT)).rejects.toMatchObject({ status: 500 })
  })
})

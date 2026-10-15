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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { exists } from './exists.ts'
import * as repo from './repo.ts'
import { codeOf, ps, rowAt, walking } from './_test_util.ts'

beforeEach(() => {
  vi.spyOn(repo, 'headCommit').mockResolvedValue('')
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function existsAt(accessor: HfHubAccessor, path: PathSpec): Promise<boolean> {
  return exists(accessor, path, await rowAt(accessor, path))
}

describe('exists', () => {
  it('is true for a file, a directory and the root, false for an absence', async () => {
    const accessor = walking()
    expect(await existsAt(accessor, ps('a.txt'))).toBe(true)
    expect(await existsAt(accessor, ps('d'))).toBe(true)
    expect(await existsAt(accessor, ps(''))).toBe(true)
    expect(await existsAt(accessor, ps('nope'))).toBe(false)
  })

  it('lets a refusal through', async () => {
    // "Cannot see the repo" is not "the file is absent".
    const accessor = walking()
    vi.mocked(client.hubGetResponse).mockRejectedValue(new client.HfHubError('expired', 401))
    expect(await codeOf(() => existsAt(accessor, ps('a.txt')))).toBe('EACCES')
  })
})

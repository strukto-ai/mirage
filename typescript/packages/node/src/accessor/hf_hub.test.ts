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

import { describe, expect, it } from 'vitest'
import type { HfRepoConfig } from '../vfs/hf_buckets/config.ts'
import { accountOf, HfAccountAccessor, HfHubAccessor, HfModelsAccessor } from './hf_hub.ts'

function models(config: HfRepoConfig): HfModelsAccessor {
  return new HfModelsAccessor(accountOf(config), config)
}

describe('HfHubAccessor', () => {
  it("waits python's 30 seconds without progress unless configured", () => {
    expect(models({ repoId: 'a/b' }).account.config.timeout).toBeUndefined()
    expect(models({ repoId: 'a/b', timeout: 5 }).account.config.timeout).toBe(5)
  })

  it("rides the mount's own account for its credential and origin", () => {
    const acc = models({ repoId: 'a/b', token: 't', endpoint: 'https://hub.example' })
    expect(acc.account.token).toBe('t')
    expect(acc.endpoint).toBe('https://hub.example')
  })

  it('borrows the account a CLI install hands it', () => {
    const account = new HfAccountAccessor({ token: 't', endpoint: 'https://hub.example' })
    const hub = new HfHubAccessor(account, { repoId: 'a/b' }, 'dataset')
    expect(hub.account).toBe(account)
    expect(hub.repoType).toBe('dataset')
  })
})

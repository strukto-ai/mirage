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
import { RAMIndexCacheStore } from './ram.ts'
import { IndexCacheStore } from './store.ts'

describe('IndexCacheStore', () => {
  it('answers that it holds a subtree when a store cannot tell', async () => {
    // The conservative answer: a caller then drops the whole subtree, which
    // costs a refetch but never serves a removed folder's contents.
    const store = new RAMIndexCacheStore()
    expect(await IndexCacheStore.prototype.holdsSubtree.call(store, '/a')).toBe(true)
  })
})

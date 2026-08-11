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

import { RAMWorkspaceStateStore } from '../store/ram.ts'
import { resolveControlStores } from './build.ts'

describe('resolveControlStores', () => {
  it('builds an owned RAM store when no provider is passed', () => {
    const stores = resolveControlStores('ws1', {})
    expect(stores.stateStore).toBeInstanceOf(RAMWorkspaceStateStore)
    expect(stores.owned).toBe(true)
    expect(stores.observe).toBeDefined()
    expect(stores.namespace).toBeDefined()
    expect(stores.sessions).toBeDefined()
  })

  it('shares a passed provider without owning it', () => {
    const provider = new RAMWorkspaceStateStore()
    const stores = resolveControlStores('ws1', { store: provider })
    expect(stores.stateStore).toBe(provider)
    expect(stores.owned).toBe(false)
  })

  it('claims a passed provider when told it owns it', () => {
    // What the config loader and the daemon pass: a store built for
    // this workspace alone, whose client nothing else would release.
    const provider = new RAMWorkspaceStateStore()
    const stores = resolveControlStores('ws1', { store: provider, ownsStore: true })
    expect(stores.owned).toBe(true)
  })

  it('lets plane overrides win over the provider', () => {
    const provider = new RAMWorkspaceStateStore()
    const observe = provider.observer('other')
    const stores = resolveControlStores('ws1', { store: provider, observe })
    expect(stores.observe).toBe(observe)
  })
})

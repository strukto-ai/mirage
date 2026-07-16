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
import { RAMWorkspaceStateStore } from './ram.ts'

describe('RAMWorkspaceStateStore', () => {
  it('caches planes per workspace', () => {
    const store = new RAMWorkspaceStateStore()
    expect(store.namespace('a')).toBe(store.namespace('a'))
    expect(store.observer('a')).toBe(store.observer('a'))
    expect(store.sessions('a')).toBe(store.sessions('a'))
  })

  it('isolates workspaces', () => {
    const store = new RAMWorkspaceStateStore()
    expect(store.namespace('a')).not.toBe(store.namespace('b'))
    expect(store.observer('a')).not.toBe(store.observer('b'))
    expect(store.sessions('a')).not.toBe(store.sessions('b'))
  })

  it('isolates the sessions plane between workspaces', async () => {
    const store = new RAMWorkspaceStateStore()
    await store.sessions('a').set('s1', { session_id: 's1' })
    expect((await store.sessions('b').load()).size).toBe(0)
    expect([...(await store.sessions('a').load()).keys()]).toEqual(['s1'])
  })

  it('meta round-trips and returns copies', async () => {
    const store = new RAMWorkspaceStateStore()
    expect(await store.loadMeta('a')).toBeNull()
    await store.setMeta('a', { workspace_id: 'a', default_session_id: 'default' })
    const loaded = await store.loadMeta('a')
    expect(loaded).toEqual({ workspace_id: 'a', default_session_id: 'default' })
    if (loaded === null) throw new Error('missing meta')
    loaded.default_session_id = 'mutated'
    expect((await store.loadMeta('a'))?.default_session_id).toBe('default')
    await store.close()
  })
})

describe('WorkspaceStateStore group overrides', () => {
  it('routes only the overridden plane', () => {
    const observerHome = new RAMWorkspaceStateStore()
    const base = new RAMWorkspaceStateStore({ observer: observerHome })
    expect(base.observer('ws')).toBe(observerHome.observer('ws'))
    expect(base.namespace('ws')).not.toBe(observerHome.namespace('ws'))
    expect(base.sessions('ws')).not.toBe(observerHome.sessions('ws'))
  })

  it('workspace override carries sessions and meta together', async () => {
    const control = new RAMWorkspaceStateStore()
    const base = new RAMWorkspaceStateStore({ workspace: control })
    expect(base.sessions('ws')).toBe(control.sessions('ws'))
    await base.setMeta('ws', { workspace_id: 'ws', created_at: 1 })
    expect(await control.loadMeta('ws')).toEqual({ workspace_id: 'ws', created_at: 1 })
  })
})

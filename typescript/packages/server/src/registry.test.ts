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
import { RAMResource, Workspace, MountMode } from '@struktoai/mirage-node'
import { newWorkspaceId } from '@struktoai/mirage-node'
import { WorkspaceRegistry } from './registry.ts'

describe('newWorkspaceId', () => {
  it('mints canonical UUIDv7 ids', () => {
    const id = newWorkspaceId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('WorkspaceRegistry', () => {
  it('add/get/list/remove', async () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    expect(r.has(entry.id)).toBe(true)
    expect(r.list()).toHaveLength(1)
    await r.remove(entry.id)
    expect(r.has(entry.id)).toBe(false)
  })

  it('rejects duplicate ids', () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    r.add(ws, 'fixed')
    const ws2 = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    expect(() => r.add(ws2, 'fixed')).toThrow(/already exists/)
  })

  it('trips exitEvent after idleGraceSeconds when last workspace removed', async () => {
    vi.useFakeTimers()
    let tripped = false
    const r = new WorkspaceRegistry({
      idleGraceSeconds: 0.05,
      onIdleExit: () => {
        tripped = true
      },
    })
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    await r.remove(entry.id)
    await vi.advanceTimersByTimeAsync(60)
    expect(tripped).toBe(true)
    vi.useRealTimers()
  })
})

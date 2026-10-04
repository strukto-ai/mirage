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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskRecordClient, Workspace } from '@struktoai/mirage-node'
import { newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
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
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    expect(r.has(entry.id)).toBe(true)
    expect(r.list()).toHaveLength(1)
    await r.remove(entry.id)
    expect(r.has(entry.id)).toBe(false)
  })

  it('joins an overlapping remove instead of deleting the id again', async () => {
    // A second deletion of its own would stop the runner again, then
    // release the id after a create had reused it.
    const r = new WorkspaceRegistry()
    const entry = r.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'w')
    const stop = vi.spyOn(entry.runner, 'stop')
    const [first, second] = await Promise.all([r.remove('w'), r.remove('w')])
    expect(first).toBe(entry)
    expect(second).toBe(entry)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(r.has('w')).toBe(false)
  })

  it('rejects duplicate ids', () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    r.add(ws, 'fixed')
    const ws2 = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
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
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws)
    await r.remove(entry.id)
    await vi.advanceTimersByTimeAsync(60)
    expect(tripped).toBe(true)
    vi.useRealTimers()
  })
})

describe('WorkspaceRegistry accounts', () => {
  const ram = () => new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })

  it('shows an account only the workspaces it owns', async () => {
    const r = new WorkspaceRegistry()
    const mine = r.add(ram(), 'mine', 'alice')
    r.add(ram(), 'theirs', 'bob')
    r.add(ram(), 'nobodys')
    expect(r.visible('mine', 'alice')).toBe(mine)
    expect(r.visible('theirs', 'alice')).toBeNull()
    expect(r.visible('nobodys', 'alice')).toBeNull()
    expect(r.visible('missing', 'alice')).toBeNull()
    expect(r.visible('theirs', null)).not.toBeNull()
    await r.closeAll()
  })

  it('refuses a caller without an account when accounts are required', async () => {
    const r = new WorkspaceRegistry({ accountsRequired: true })
    r.add(ram(), 'w', 'alice')
    expect(r.visible('w', null)).toBeNull()
    expect(await r.allows('w', null)).toBe(false)
    expect(r.visible('w', 'alice')).not.toBeNull()
    await r.closeAll()
  })

  it('keeps a claim past the registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const owners = new DiskRecordClient(dir, 'owners')
      const first = new WorkspaceRegistry({ owners })
      expect(await first.claim('w', 'alice')).toBe(true)
      first.add(ram(), 'w', 'alice')
      await first.closeAll()
      // A restarted daemon: nothing is live, the claim still is.
      const second = new WorkspaceRegistry({ owners })
      expect(await second.allows('w', 'alice')).toBe(true)
      expect(await second.allows('w', 'bob')).toBe(false)
      expect(await second.claim('w', 'bob')).toBe(false)
      expect(await second.claim('w', 'alice')).toBe(true)
      expect(await second.claim('w', null)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases the claim on delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owners-'))
    try {
      const r = new WorkspaceRegistry({ owners: new DiskRecordClient(dir, 'owners') })
      expect(await r.claim('w', 'alice')).toBe(true)
      r.add(ram(), 'w', 'alice')
      await r.remove('w')
      expect(await r.claim('w', 'bob')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

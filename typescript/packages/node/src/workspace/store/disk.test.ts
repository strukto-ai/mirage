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

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskWorkspaceStateStore } from './disk.ts'

describe('DiskWorkspaceStateStore', () => {
  let root: string
  let store: DiskWorkspaceStateStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-diskws-'))
    store = new DiskWorkspaceStateStore({ root })
  })
  afterEach(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips meta and uses the shared layout', async () => {
    expect(await store.loadMeta('ws1')).toBeNull()
    await store.setMeta('ws1', { workspace_id: 'ws1', generation: 1 })
    expect((await store.loadMeta('ws1'))?.workspace_id).toBe('ws1')
    expect(existsSync(join(root, 'workspaces', 'ws1', 'workspace.json'))).toBe(true)
  })

  it('enforces the meta CAS contract', async () => {
    expect(await store.casSetMeta('ws1', { workspace_id: 'ws1', generation: 1 }, 0)).toBe(true)
    expect(await store.casSetMeta('ws1', { workspace_id: 'ws1', generation: 1 }, 0)).toBe(false)
    expect(
      await store.casSetMeta(
        'ws1',
        { workspace_id: 'ws1', default_session_id: 'd', generation: 2 },
        1,
      ),
    ).toBe(true)
    expect((await store.loadMeta('ws1'))?.default_session_id).toBe('d')
  })

  it('replaceMeta preserves created_at and bumps the generation', async () => {
    const first = await store.replaceMeta('ws1', { workspace_id: 'ws1' })
    const second = await store.replaceMeta('ws1', { workspace_id: 'ws1', default_session_id: 'd' })
    expect(second.created_at).toBe(first.created_at)
    expect(second.generation).toBe((first.generation as number) + 1)
  })

  it('scopes sessions per workspace', async () => {
    await store.sessions('ws1').set('s', { session_id: 's', cwd: '/a' })
    await store.sessions('ws2').set('s', { session_id: 's', cwd: '/b' })
    expect((await store.sessions('ws1').load()).get('s')?.cwd).toBe('/a')
    expect((await store.sessions('ws2').load()).get('s')?.cwd).toBe('/b')
    expect(existsSync(join(root, 'workspaces', 'ws1', 'sessions', 's.json'))).toBe(true)
    expect(existsSync(join(root, 'workspaces', 'ws2', 'sessions', 's.json'))).toBe(true)
  })

  it('hosts the namespace and observer planes on disk', async () => {
    const ns = store.namespace('ws1')
    await ns.set('/link.txt', { target: '/a.txt' })
    expect((await ns.load()).get('/link.txt')).toEqual({ target: '/a.txt' })
    expect(existsSync(join(root, 'workspaces', 'ws1', 'namespace.json'))).toBe(true)
    const ob = store.observer('ws1')
    await ob.append('/2026-07-18/agent.jsonl', new TextEncoder().encode('{"type":"COMMAND"}\n'))
    const files = await ob.readAll()
    expect(
      existsSync(join(root, 'workspaces', 'ws1', 'history', '2026-07-18', 'agent.jsonl')),
    ).toBe(true)
    expect(new TextDecoder().decode(files.get('/2026-07-18/agent.jsonl'))).toBe(
      '{"type":"COMMAND"}\n',
    )
  })

  it('shares state across store instances via the directory', async () => {
    await store.setMeta('ws1', { workspace_id: 'ws1', generation: 1 })
    await store.sessions('ws1').set('s', { session_id: 's', cwd: '/x' })
    const reader = new DiskWorkspaceStateStore({ root })
    expect((await reader.loadMeta('ws1'))?.generation).toBe(1)
    expect((await reader.sessions('ws1').load()).get('s')?.cwd).toBe('/x')
    await reader.close()
  })
})

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

import { afterEach, describe, expect, it } from 'vitest'
import { RAMObserverStore } from '../../observe/store.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace.ts'
import { RAMWorkspaceStateStore } from './ram.ts'

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function mkWs(store: RAMWorkspaceStateStore, workspaceId: string, ram?: RAMResource) {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/data': ram ?? new RAMResource() },
    { mode: MountMode.EXEC, shellParser: parser, workspaceId, store },
  )
  open.push(ws)
  return ws
}

describe('Workspace on a WorkspaceStateStore', () => {
  it('writes the discovery record on first execute', async () => {
    const store = new RAMWorkspaceStateStore()
    const ws = await mkWs(store, 'ws-a')
    await ws.execute('echo hi')
    const meta = await store.loadMeta('ws-a')
    expect(meta?.workspace_id).toBe('ws-a')
    expect(meta?.default_session_id).toBe('default')
    expect(meta?.created_at as number).toBeGreaterThan(0)
  })

  it('an existing discovery record wins', async () => {
    const store = new RAMWorkspaceStateStore()
    await store.setMeta('ws-a', {
      workspace_id: 'ws-a',
      default_session_id: 'sess_x',
      created_at: 1,
    })
    const ws = await mkWs(store, 'ws-a')
    await ws.execute('echo hi')
    const meta = await ws.workspaceMeta()
    expect(meta.default_session_id).toBe('sess_x')
    expect(meta.created_at).toBe(1)
  })

  it('same workspace id shares sessions across workspaces', async () => {
    const store = new RAMWorkspaceStateStore()
    const ram = new RAMResource()
    const wsA = await mkWs(store, 'shared', ram)
    wsA.createSession('narrow', { mounts: { '/data': MountMode.READ } })
    await wsA.flushSessions()

    const wsB = await mkWs(store, 'shared', ram)
    const denied = await wsB.execute('echo blocked > /data/x.txt', { sessionId: 'narrow' })
    expect(denied.exitCode).not.toBe(0)
  })

  it('different workspace ids are isolated', async () => {
    const store = new RAMWorkspaceStateStore()
    const wsA = await mkWs(store, 'a')
    wsA.createSession('narrow', { mounts: { '/data': MountMode.READ } })
    await wsA.flushSessions()

    const wsB = await mkWs(store, 'b')
    await wsB.ensureSessionsLoaded()
    expect(wsB.listSessions().every((s) => s.sessionId !== 'narrow')).toBe(true)
  })

  it('shares history through the provider', async () => {
    const store = new RAMWorkspaceStateStore()
    const ram = new RAMResource()
    const wsA = await mkWs(store, 'shared', ram)
    await wsA.execute('echo one')

    const wsB = await mkWs(store, 'shared', ram)
    const result = await wsB.execute('history')
    expect(result.stdoutText).toContain('echo one')
  })

  it('a direct observe option wins over the provider plane', async () => {
    const direct = new RAMObserverStore()
    const store = new RAMWorkspaceStateStore()
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, workspaceId: 'ws-a', store, observe: direct },
    )
    open.push(ws)
    await ws.execute('echo hi')

    const sibling = await mkWs(store, 'ws-a')
    const result = await sibling.execute('history')
    expect(result.stdoutText).not.toContain('echo hi')
  })
})

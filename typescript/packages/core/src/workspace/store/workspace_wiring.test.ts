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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAMObserverStore } from '../../observe/store.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { RAMWorkspaceStateStore } from './ram.ts'

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Yields to the microtask queue on meta reads so two concurrent
// attaches both observe the record as absent before either writes.
class YieldingStore extends RAMWorkspaceStateStore {
  protected override async readMeta(workspaceId: string) {
    await Promise.resolve()
    return super.readMeta(workspaceId)
  }
}

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
    expect(meta?.default_session_id).toBe(ws.defaultSessionId)
    expect(meta?.default_session_id).toMatch(UUID7_RE)
    expect(meta?.created_at as number).toBeGreaterThan(0)
  })

  it('a bare workspace mints uuid7 ids', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser },
    )
    open.push(ws)
    const sibling = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser },
    )
    open.push(sibling)
    expect(ws.workspaceId).toMatch(UUID7_RE)
    expect(ws.defaultSessionId).toMatch(UUID7_RE)
    expect(sibling.workspaceId).not.toBe(ws.workspaceId)
  })

  it('attach adopts the stored default session pointer', async () => {
    const store = new RAMWorkspaceStateStore()
    const wsA = await mkWs(store, 'shared')
    await wsA.execute('export MARK=1')
    await wsA.flushSessions()

    const wsB = await mkWs(store, 'shared')
    const minted = wsB.defaultSessionId
    await wsB.ensureSessionsLoaded()
    expect(wsB.defaultSessionId).toBe(wsA.defaultSessionId)
    expect(wsB.defaultSessionId).not.toBe(minted)
    expect(wsB.getSession(wsB.defaultSessionId).env.MARK).toBe('1')
  })

  it('an explicit session id is not adopted away', async () => {
    const store = new RAMWorkspaceStateStore()
    const wsA = await mkWs(store, 'shared')
    await wsA.execute('echo hi')

    const parser = await getTestParser()
    const wsB = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        workspaceId: 'shared',
        store,
        sessionId: 'pinned',
      },
    )
    open.push(wsB)
    await wsB.ensureSessionsLoaded()
    expect(wsB.defaultSessionId).toBe('pinned')
  })

  it.each(['default', 'named'])(
    'changes the %s session profile after hydration',
    async (target) => {
      const store = new RAMWorkspaceStateStore()
      const writer = await mkWs(store, 'shared')
      writer.createSession('named')
      await writer.ensureSessionsLoaded()
      await writer.flushSessions()
      const attached = await mkWs(store, 'shared')
      const provisional = attached.defaultSessionId
      const requested = target === 'default' ? provisional : 'named'
      const expected = target === 'default' ? writer.defaultSessionId : 'named'
      const session = await attached.setSessionProfile(requested, { commands: { allow: ['cat'] } })
      expect(session.sessionId).toBe(expected)
      expect(attached.defaultSessionId).toBe(writer.defaultSessionId)
      expect(attached.defaultSessionId).not.toBe(provisional)
      expect(session.commands?.allow).toEqual(['cat'])
      const persisted = await store.sessions('shared').load()
      expect(persisted.get(expected)?.commands).toMatchObject({ allow: ['cat'] })
    },
  )

  it('refuses a profile change if shutdown starts during hydration', async () => {
    const store = new RAMWorkspaceStateStore()
    const ws = await mkWs(store, 'shared')
    const entered = deferred()
    const release = deferred()
    const sessions = store.sessions('shared')
    const load = sessions.load.bind(sessions)
    vi.spyOn(sessions, 'load').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return load()
    })
    const session = ws.getSession(ws.defaultSessionId)
    const commands = session.commands
    const changing = ws.setSessionProfile(ws.defaultSessionId, { commands: { allow: ['cat'] } })
    const refused = expect(changing).rejects.toThrow('Workspace is closed')
    try {
      await entered.promise
      await ws.close()
    } finally {
      release.resolve()
      await refused
    }
    expect(session.commands).toBe(commands)
    expect(await load()).toEqual(new Map())
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

  it('concurrent attach admits a single discovery record', async () => {
    const store = new YieldingStore()
    const ram = new RAMResource()
    const wsA = await mkWs(store, 'ws-a', ram)
    const wsB = await mkWs(store, 'ws-a', ram)
    await Promise.all([wsA.ensureSessionsLoaded(), wsB.ensureSessionsLoaded()])
    const meta = await store.loadMeta('ws-a')
    expect(meta).not.toBeNull()
    expect(meta?.generation).toBe(1)
    expect(wsA.defaultSessionId).toBe(wsB.defaultSessionId)
    expect(meta?.default_session_id).toBe(wsA.defaultSessionId)
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

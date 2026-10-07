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

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { runWithSession } from '../../context/session_context.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { RAMSessionStore } from '../session/ram.ts'
import { applyStateDict, toStateDict } from '../snapshot/state.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import type { ExecuteOptions, SessionExecuteOptions } from './types.ts'
import { Session, Workspace } from './workspace.ts'

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function seeded(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/repo': [new RAMVFS(), MountMode.WRITE] as const },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      profiles: { reviewer: parseSessionProfile({ paths: { hide: ['/repo/secrets'] } }) },
    },
  )
  open.push(ws)
  await ws.shell(
    'mkdir -p /repo/secrets && echo hello > /repo/README.md && echo PRIVATE > /repo/secrets/key.pem',
  )
  return ws
}

describe('Session', () => {
  it('binds both doors to one session', async () => {
    // One object per agent: the shell door and the op door answer
    // under the same profile, so a hide the shell honors is a hide the
    // file tool honors too.
    const ws = await seeded()
    const reviewer = await ws.session('reviewer', { profile: 'reviewer' })
    expect(reviewer).toBeInstanceOf(Session)
    expect(reviewer.sessionId).toBe('reviewer')
    expect(reviewer.state).toBe(ws.getSession('reviewer'))
    expect(stdoutStr(await reviewer.shell('cat /repo/README.md'))).toBe('hello\n')
    expect((await reviewer.shell('cat /repo/secrets/key.pem')).exitCode).toBe(1)
    expect(await reviewer.vfs.cat('/repo/README.md')).toBe('hello\n')
    await expect(reviewer.vfs.read('/repo/secrets/key.pem')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await ws.vfs.cat('/repo/secrets/key.pem')).toBe('PRIVATE\n')
    expect(reviewer.vfs.records).toBe(ws.vfs.records)
    expect(await reviewer.glob('/repo/*')).toEqual(['/repo/README.md'])
    expect(await ws.glob('/repo/*')).toEqual(['/repo/README.md', '/repo/secrets'])
  })

  it('adopts an existing session and refuses a profile for it', async () => {
    const ws = await seeded()
    const first = await ws.session('reviewer', { profile: 'reviewer' })
    const again = await ws.session('reviewer')
    expect(again.state).toBe(first.state)
    await expect(ws.session('reviewer', { profile: 'reviewer' })).rejects.toThrow(/exists/)
    await expect(ws.session('reviewer', { mounts: { '/repo': 'read' } })).rejects.toThrow(/exists/)
  })

  it('adopts a persisted session before creating one', async () => {
    // A session store hydrates on first use, so a handle asked for
    // before any async door has run used to see an empty session
    // table, recreate a persisted session bare, and hand the next
    // flush a record that overwrote the stored profile. The door
    // hydrates first, so the stored session is adopted as is.
    const parser = await getTestParser()
    const store = new RAMSessionStore()
    const build = (): Workspace => {
      const ws = new Workspace(
        { '/repo': [new RAMVFS(), MountMode.WRITE] as const },
        {
          mode: MountMode.WRITE,
          shellParser: parser,
          profiles: { reviewer: parseSessionProfile({ paths: { hide: ['/repo/secrets'] } }) },
          sessionStore: store,
        },
      )
      open.push(ws)
      return ws
    }
    const first = build()
    const created = await first.session('reviewer', { profile: 'reviewer' })
    expect(created.state.visibility.paths).not.toBeNull()
    await first.flushSessions()
    const second = build()
    const adopted = await second.session('reviewer')
    expect(adopted.state.visibility.paths).not.toBeNull()
    await expect(second.session('reviewer', { profile: 'reviewer' })).rejects.toThrow(/exists/)
  })

  it('forwards per-call options and keeps a bound session', async () => {
    const ws = await seeded()
    const reviewer = await ws.session('reviewer', { profile: 'reviewer' })
    expect(stdoutStr(await reviewer.shell('pwd', { cwd: '/repo' }))).toBe('/repo\n')
    expect(reviewer.state.cwd).not.toBe('/repo')
    await runWithSession(ws.getSession(ws.defaultSessionId), async () => {
      // A session already bound is kept by the op door, so a handle
      // reached from inside the default session's own command reads
      // as that session, never wider.
      expect(await reviewer.vfs.cat('/repo/secrets/key.pem')).toBe('PRIVATE\n')
    })
  })
})

describe('handle parity with the workspace door', () => {
  it('forwards every option the workspace takes but the bound one', () => {
    // `Session.shell` is `Workspace.shell` with the session fixed,
    // so an option added to one has to reach the other. Checked at
    // compile time: a TS interface has no fields to enumerate at
    // runtime, so an option the `Session` type does not carry fails to
    // index, and one whose type drifted fails to assign. The bound
    // field is the one exception -- the object *is* the session, so
    // naming one per call would be a second, contradictory source.
    // The python twin hand-copies nine parameters and is pinned by
    // tests/workspace/workspace/test_handle_signature.py.
    type Forwarded = { [K in keyof SessionExecuteOptions]: ExecuteOptions[K] }
    const parity: Forwarded = {} as SessionExecuteOptions
    expect(parity).toBeDefined()
    expectTypeOf<SessionExecuteOptions>().toEqualTypeOf<Omit<ExecuteOptions, 'sessionId'>>()
  })
})

describe('session tools', () => {
  async function plain(): Promise<Workspace> {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    open.push(ws)
    await ws.shell('echo one > /a.txt')
    return ws
  }

  it('has one table per session that every caller shares', async () => {
    const ws = await plain()
    const agent = await ws.session('agent')
    const other = await ws.session('other')
    expect(agent.tools).toBe(new Session(ws, 'agent').tools)
    expect(ws.tools).toBe(new Session(ws, null).tools)
    await agent.tools.call('read', { path: '/a.txt' })
    const written = await new Session(ws, 'agent').tools.call('write', {
      path: '/a.txt',
      content: 'two\n',
    })
    const refused = await other.tools.call('write', { path: '/a.txt', content: 'three\n' })
    expect(written.isError).toBeUndefined()
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('drops a closed session table', async () => {
    const ws = await plain()
    const agent = await ws.session('agent')
    await agent.tools.call('read', { path: '/a.txt' })
    await ws.closeSession('agent')
    const again = await ws.session('agent')
    const refused = await again.tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
  })

  it('drops the tables of every session closed at once', async () => {
    const ws = await plain()
    const agent = await ws.session('agent')
    await agent.tools.call('read', { path: '/a.txt' })
    await ws.closeAllSessions()
    const again = await ws.session('agent')
    const refused = await again.tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
  })

  it('follows the default session a snapshot restores', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    open.push(ws)
    const tools = ws.tools
    await applyStateDict(ws, state)
    const read = await tools.call('read', { path: '/a.txt' })
    expect(ws.defaultSessionId).toBe(source.defaultSessionId)
    expect(read.isError, read.content[0]?.text).toBeUndefined()
    expect(ws.tools).toBe(tools)
  })

  it('keeps an explicit default id on its session after a restore', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    open.push(ws)
    const pinned = new Session(ws, ws.defaultSessionId).tools
    expect(pinned).not.toBe(ws.tools)
    await applyStateDict(ws, state)
    await expect(pinned.call('read', { path: '/a.txt' })).rejects.toThrow('unknown session')
  })

  it('starts a restored default with no read history', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = await plain()
    const tools = ws.tools
    await tools.call('read', { path: '/a.txt' })
    await applyStateDict(ws, state)
    const refused = await tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('shares one read history between the default tables', async () => {
    const ws = await plain()
    await ws.tools.call('read', { path: '/a.txt' })
    const written = await new Session(ws, ws.defaultSessionId).tools.call('write', {
      path: '/a.txt',
      content: 'two\n',
    })
    expect(written.isError, written.content[0]?.text).toBeUndefined()
  })

  it('starts a restored session with no read history', async () => {
    const source = await plain()
    await source.session('agent')
    const state = await toStateDict(source)
    const ws = await plain()
    const agent = (await ws.session('agent')).tools
    await agent.call('read', { path: '/a.txt' })
    await applyStateDict(ws, state)
    const refused = await agent.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('counts a read in flight during a restore for no one', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = await plain()
    const reads = await ws.sessionReads(null)
    const real = reads.read.bind(reads)
    let entered!: () => void
    let release!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    reads.read = async (path: string) => {
      const data = await real(path)
      entered()
      await gate
      return data
    }
    const pending = ws.tools.call('read', { path: '/a.txt' })
    await inside
    await applyStateDict(ws, state)
    release()
    await pending
    const refused = await ws.tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })
})

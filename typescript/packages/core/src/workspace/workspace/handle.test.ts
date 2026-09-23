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
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Session, type SessionExecuteOptions } from './handle.ts'
import type { ExecuteOptions, ExecuteResult } from './types.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import { Workspace } from './workspace.ts'

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
    expect(await reviewer.vfs.readFileText('/repo/README.md')).toBe('hello\n')
    await expect(reviewer.vfs.readFile('/repo/secrets/key.pem')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await ws.vfs.readFileText('/repo/secrets/key.pem')).toBe('PRIVATE\n')
    expect(reviewer.vfs.records).toBe(ws.vfs.records)
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
    expect(created.state.hiddenPaths).not.toBeNull()
    await first.flushSessions()
    const second = build()
    const adopted = await second.session('reviewer')
    expect(adopted.state.hiddenPaths).not.toBeNull()
    await expect(second.session('reviewer', { profile: 'reviewer' })).rejects.toThrow(/exists/)
  })

  it('forwards per-call options and keeps a bound session', async () => {
    const ws = await seeded()
    const reviewer = await ws.session('reviewer', { profile: 'reviewer' })
    expect(stdoutStr(await reviewer.shell('pwd', { cwd: '/repo' }))).toBe('/repo\n')
    expect(reviewer.state.cwd).not.toBe('/repo')
    const plan = await reviewer.shell('cat /repo/README.md', { provision: true })
    expect(plan).toBeDefined()
    await runWithSession(ws.getSession(ws.defaultSessionId), async () => {
      // A session already bound is kept by the op door, so a handle
      // reached from inside the default session's own command reads
      // as that session, never wider.
      expect(await reviewer.vfs.readFileText('/repo/secrets/key.pem')).toBe('PRIVATE\n')
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

  it('accepts the same three call shapes the workspace does', () => {
    // Each overload answers a different return type, and the handle
    // dropped the widening one, so `shell(line, opts)` with an unknown
    // `provision` type-checked on the workspace and not on a handle.
    expectTypeOf<Parameters<Session['shell']>>().toEqualTypeOf<
      [command: string, options: SessionExecuteOptions]
    >()
    expectTypeOf<ReturnType<Session['shell']>>().toEqualTypeOf<
      Promise<ExecuteResult | ProvisionResult>
    >()
  })
})

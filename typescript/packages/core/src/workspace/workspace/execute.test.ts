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
import { RegisteredCommand } from '../../commands/config.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode, ResourceName } from '../../types.ts'
import type { Action, CommandContext, Policy } from '../../policy/index.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()

const PROBE_SPEC = new CommandSpec({})

const open: Workspace[] = []

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/subdir')
  r.store.dirs.add('/other')
  const ws = new Workspace({ '/ram/': r }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  return ws
}

async function makeTwoMounts(): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  a.store.dirs.add('/')
  const b = new RAMResource()
  b.store.dirs.add('/')
  b.store.files.set('/y.txt', ENC.encode('secret\n'))
  const ws = new Workspace({ '/a': a, '/b': b }, { mode: MountMode.WRITE, shellParser: parser })
  open.push(ws)
  return ws
}

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

// A nested eval ($(), eval, source, xargs) re-enters execute and must
// continue in the LIVE session the outer line runs in. An id cannot say
// that: it names a registered session, never the ephemeral per-call
// fork, so these pin the cases only the ambient session context can
// answer.
describe('nested evals run in the live ambient session', () => {
  it('cmdsub reads the per-call fork cwd', async () => {
    const ws = await makeWs()
    const io = await ws.execute('echo $(pwd)', { cwd: '/ram/subdir' })
    expect(stdoutStr(io).trim()).toBe('/ram/subdir')
  })

  it('eval moves the fork, not the default session', async () => {
    const ws = await makeWs()
    const before = ws.getSession(ws.defaultSessionId).cwd
    const io = await ws.execute("eval 'cd /ram/other'; pwd", { cwd: '/ram/subdir' })
    expect(stdoutStr(io).trim()).toBe('/ram/other')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe(before)
  })

  it('cmdsub cd stays in the fork', async () => {
    const ws = await makeWs()
    const before = ws.getSession(ws.defaultSessionId).cwd
    await ws.execute('echo $(cd /ram/other)', { env: { FOO: 'bar' } })
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe(before)
  })

  it('cmdsub reads the named session cwd', async () => {
    const ws = await makeWs()
    ws.createSession('agent')
    await ws.execute('cd /ram/subdir', { sessionId: 'agent' })
    const io = await ws.execute('echo $(pwd)', { sessionId: 'agent' })
    expect(stdoutStr(io).trim()).toBe('/ram/subdir')
  })

  it("cmdsub keeps the named session's hides", async () => {
    // A nested eval runs under the same session, so what the profile hides
    // is as absent inside `$()` as outside it.
    const ws = await makeTwoMounts()
    ws.createSession('agent', { profile: { paths: { hide: ['/b'] } } })
    const io = await ws.execute('echo $(cat /b/y.txt)', { sessionId: 'agent' })
    expect(stdoutStr(io)).not.toContain('secret')
  })

  it('cmdsub cd is isolated from the live session', async () => {
    const ws = await makeWs()
    const before = ws.getSession(ws.defaultSessionId).cwd
    const io = await ws.execute('echo $(cd /ram/subdir; pwd)')
    expect(stdoutStr(io)).toBe('/ram/subdir\n')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe(before)
  })
})

// A background job forks the session, so it is the one mid-line point
// where the ambient session must be rebound: without that, a nested
// eval inside `... &` resolves the OUTER live session (the fork keeps
// its parent's id) and escapes the job's isolation.
describe('nested evals inside background jobs run in the job fork', () => {
  it('bg job cmdsub reads the job fork', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cd /ram/other && echo $(pwd) & wait %1')
    expect(stdoutStr(io).trim()).toBe('/ram/other')
  })

  it('bg job cmdsub cd stays in the job fork', async () => {
    const ws = await makeWs()
    const before = ws.getSession(ws.defaultSessionId).cwd
    await ws.execute('echo $(cd /ram/other) & wait %1')
    expect(ws.getSession(ws.defaultSessionId).cwd).toBe(before)
  })
})

// $() must run its whole body: bash substitutes the output of the full
// statement list, not of the first simple command it contains.
describe('command substitution runs its whole body', () => {
  it('runs every statement', async () => {
    const ws = await makeWs()
    const io = await ws.execute('echo $(echo a; echo b)')
    expect(stdoutStr(io).trim()).toBe('a b')
  })

  it('runs control flow', async () => {
    const ws = await makeWs()
    const io = await ws.execute('echo $(if true; then echo yes; fi)')
    expect(stdoutStr(io).trim()).toBe('yes')
  })

  it('runs assignments', async () => {
    const ws = await makeWs()
    const io = await ws.execute('echo $(X=5; echo $X)')
    expect(stdoutStr(io).trim()).toBe('5')
  })

  it('runs declarations', async () => {
    const ws = await makeWs()
    const io = await ws.execute('echo $(export Y=7; echo $Y)')
    expect(stdoutStr(io).trim()).toBe('7')
  })
})

// The ambient session belongs to the workspace that published it. A
// callback fired mid-line reaching a SECOND workspace must not adopt
// it: that workspace's own session owns its cwd, env and mount grants,
// and an unrestricted session must never stand in for a restricted one.
describe('the ambient session is scoped to its workspace', () => {
  it('another workspace resolves its own session', async () => {
    const wsA = await makeWs()
    const wsB = await makeTwoMounts()
    const seen: string[] = []
    const rc = new RegisteredCommand({
      name: 'crossprobe',
      spec: PROBE_SPEC,
      resource: ResourceName.RAM,
      fn: async () => {
        const io = await wsB.execute('pwd')
        seen.push(stdoutStr(io).trim())
        return [new Uint8Array(), new IOResult()]
      },
    })
    wsA.registry.mountForPrefix('/ram/').register(rc)
    await wsA.execute('crossprobe', { cwd: '/ram/subdir' })
    expect(seen).toEqual(['/'])
  })

  it('the policy reads the ambient session cwd', async () => {
    // The policy decides about the line the session actually runs, so
    // it reads the resolved session's cwd, not the registered
    // session's: a re-entrant line runs in the live ambient fork.
    const seen: string[] = []
    const parser = await getTestParser()
    const r = new RAMResource()
    r.store.dirs.add('/')
    r.store.dirs.add('/subdir')
    const ws = new Workspace(
      { '/ram/': r },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        routePolicy: (ctx) => {
          seen.push(ctx.cwd)
          return null
        },
      },
    )
    open.push(ws)
    const rc = new RegisteredCommand({
      name: 'policyprobe',
      spec: PROBE_SPEC,
      resource: ResourceName.RAM,
      fn: async () => {
        await ws.execute('pwd')
        return [new Uint8Array(), new IOResult()]
      },
    })
    ws.registry.mountForPrefix('/ram/').register(rc)
    await ws.execute('policyprobe', { cwd: '/ram/subdir' })
    expect(seen).toEqual(['/ram/subdir', '/ram/subdir'])
  })
})

class DenySecret implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command === 'echo' && ctx.argv.includes('secret')) {
      return { kind: 'deny', reason: 'secrets stay put' }
    }
    return null
  }
}

async function policedWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  const ws = new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, shellParser: parser, policies: [new DenySecret()] },
  )
  open.push(ws)
  return ws
}

// A nested line ($(), eval, `command NAME`) re-enters execute and comes
// back as an ExecuteResult; the refusal it earned has to survive the
// trip back into the IOResult the tree reads, or the outer line says
// `Permission denied` beside a null record.
describe('a nested line carries its refusal out', () => {
  it('command NAME keeps the record the inner line earned', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; command echo "$V"')
    expect(io.exitCode).toBe(126)
    expect(stderrStr(io)).toBe('echo: Permission denied\n')
    expect(io.refusal?.reason).toBe('secrets stay put')
  })

  it('eval keeps it too', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; eval "echo $V"')
    expect(io.exitCode).toBe(126)
    expect(io.refusal?.reason).toBe('secrets stay put')
  })

  // A substitution keeps only the inner stdout, so its record has to
  // reach the line through the door every nested line re-enters by.
  it('a substitution keeps the record the inner line earned', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; X=$(echo "$V")')
    expect(io.exitCode).toBe(126)
    expect(io.refusal?.reason).toBe('secrets stay put')
  })

  it('an unrefused outer command still reports the inner record', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; echo "[$(echo "$V")]"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[]\n')
    expect(io.refusal?.reason).toBe('secrets stay put')
  })
})

// `!` negates the status, so a refused command reads as success (bash
// does the same for a command it may not run); the record of what was
// refused still has to ride the result.
describe('a negated command keeps its refusal', () => {
  it('for one command', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; ! echo "$V"')
    expect(io.exitCode).toBe(0)
    expect(stderrStr(io)).toBe('echo: Permission denied\n')
    expect(io.refusal?.reason).toBe('secrets stay put')
  })

  it('for a pipeline', async () => {
    const ws = await policedWs()
    const io = await ws.execute('V=secret; ! true | echo "$V"')
    expect(io.exitCode).toBe(0)
    expect(io.refusal?.reason).toBe('secrets stay put')
  })
})

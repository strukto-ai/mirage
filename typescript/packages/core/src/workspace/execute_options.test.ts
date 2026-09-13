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
import { RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import { RAMObserverStore } from '../observe/store.ts'
import { OpsRegistry } from '../ops/registry.ts'
import type { Action, OpsContext } from '../policy/index.ts'
import { RAMSessionStore } from './session/ram.ts'
import type { SessionFields } from './session/store.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { Runtime } from '../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../runtime/mixin.ts'
import type { RunResult } from '../runtime/types.ts'
import { MountMode, ResourceName } from '../types.ts'
import { Channel, type ConsoleChunk, JobConsole, RAMConsoleStore } from '../shell/console/index.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import type { ExecuteResult } from './workspace/workspace.ts'
import { Workspace } from './workspace/workspace.ts'

const DEC = new TextDecoder()

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/subdir')
  r.store.dirs.add('/subdir/nested')
  r.store.files.set('/subdir/file.txt', ENC.encode('hello'))
  r.store.files.set('/subdir/nested/deep.txt', ENC.encode('deep'))

  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('execute({ cwd }): bash subshell semantics', () => {
  it('runs the command in the override cwd, like (cd /ram/subdir && pwd)', async () => {
    const ws = await makeWs()
    const r = await ws.execute('pwd', { cwd: '/ram/subdir' })
    expect(stdoutStr(r).trim()).toBe('/ram/subdir')
    await ws.close()
  })

  it('does not mutate session.cwd', async () => {
    const ws = await makeWs()
    const before = ws.cwd
    await ws.execute('pwd', { cwd: '/ram/subdir' })
    expect(ws.cwd).toBe(before)
    await ws.close()
  })

  it('does not let `cd` inside the call leak back to session.cwd', async () => {
    const ws = await makeWs()
    const before = ws.cwd
    await ws.execute('cd /ram/subdir', { cwd: '/ram' })
    expect(ws.cwd).toBe(before)
    await ws.close()
  })

  it('does not leak between parallel calls (isolation regression guard)', async () => {
    const ws = await makeWs()
    const [a, b] = await Promise.all([
      ws.execute('pwd', { cwd: '/ram/subdir' }),
      ws.execute('pwd', { cwd: '/ram' }),
    ])
    expect(stdoutStr(a).trim()).toBe('/ram/subdir')
    expect(stdoutStr(b).trim()).toBe('/ram')
    await ws.close()
  })

  it('setup mutates session, per-call overrides inherit and do not leak', async () => {
    const ws = await makeWs()
    const cwdBefore = ws.cwd
    await ws.execute('export DEBUG=1')
    const [a, b] = await Promise.all([
      ws.execute('printenv DEBUG; pwd', { cwd: '/ram/subdir' }),
      ws.execute('printenv DEBUG; pwd', { cwd: '/ram' }),
    ])
    expect(stdoutStr(a)).toContain('1')
    expect(stdoutStr(a)).toContain('/ram/subdir')
    expect(stdoutStr(b)).toContain('1')
    expect(stdoutStr(b)).toContain('/ram')
    expect(ws.env.DEBUG).toBe('1')
    expect(ws.cwd).toBe(cwdBefore)
    await ws.close()
  })

  it('propagates lastExitCode back to the persistent session', async () => {
    const ws = await makeWs()
    await ws.execute('false', { cwd: '/ram/subdir' })
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    await ws.close()
  })

  it('does not let function definitions leak back to session.functions', async () => {
    const ws = await makeWs()
    await ws.execute('greet() { echo hi; }', { cwd: '/ram' })
    const session = ws.sessionManager.get(ws.sessionManager.defaultId)
    expect(session.functions.greet).toBeUndefined()
  })
})

describe('execute({ env }): bash subshell semantics', () => {
  it('exposes override env to the command, like env FOO=bar printenv FOO', async () => {
    const ws = await makeWs()
    const r = await ws.execute('printenv FOO', { env: { FOO: 'bar' } })
    expect(r.exitCode).toBe(0)
    expect(stdoutStr(r).trim()).toBe('bar')
    await ws.close()
  })

  it('does not mutate session.env', async () => {
    const ws = await makeWs()
    const before = { ...ws.env }
    await ws.execute('printenv FOO', { env: { FOO: 'bar' } })
    expect(ws.env).toEqual(before)
    await ws.close()
  })

  it('does not let `export` inside the call leak back to session.env', async () => {
    const ws = await makeWs()
    await ws.execute('export LEAKED=yes', { env: { FOO: 'bar' } })
    expect(ws.env.LEAKED).toBeUndefined()
    await ws.close()
  })

  it('layers onto, does not replace, session env', async () => {
    const ws = await makeWs()
    await ws.execute('export BASE=keep')
    const r = await ws.execute('printenv BASE; printenv FOO', { env: { FOO: 'bar' } })
    expect(stdoutStr(r)).toContain('keep')
    expect(stdoutStr(r)).toContain('bar')
    expect(ws.env.BASE).toBe('keep')
    expect(ws.env.FOO).toBeUndefined()
    await ws.close()
  })

  it('does not leak between parallel calls (isolation regression guard)', async () => {
    const ws = await makeWs()
    const [a, b] = await Promise.all([
      ws.execute('printenv X', { env: { X: 'one' } }),
      ws.execute('printenv X', { env: { X: 'two' } }),
    ])
    expect(stdoutStr(a).trim()).toBe('one')
    expect(stdoutStr(b).trim()).toBe('two')
    await ws.close()
  })
})

describe('execute({ signal }): concurrent lines on one session', () => {
  // A snapshots `$?` and blocks, B finishes and stamps its own, then A
  // aborts. A's snapshot is older than B's result, so putting it back
  // would resurrect a status the shell had already moved past.
  it('does not restore over a status another line stamped', async () => {
    const ws = await makeWs()
    await ws.execute('true')

    const ac = new AbortController()
    const blocked = ws.execute('sleep 5', { signal: ac.signal })
    const settled = blocked.catch(() => undefined)
    // Let the blocked line reach its snapshot before the other runs.
    await new Promise((r) => setTimeout(r, 50))

    await ws.execute('false')

    ac.abort()
    await settled

    expect(stdoutStr(await ws.execute('echo $?')).trim()).toBe('1')
  })
})

describe('execute({ signal }): mid-flight cancellation', () => {
  it('rejects with AbortError when signal is pre-aborted (regression guard)', async () => {
    const ws = await makeWs()
    const ac = new AbortController()
    ac.abort()
    await expect(ws.execute('echo hi', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await ws.close()
  })

  it('aborts a sleeping command within ~timeout window', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    await expect(ws.execute('sleep 5', { signal: AbortSignal.timeout(100) })).rejects.toMatchObject(
      { name: 'AbortError' },
    )
    expect(Date.now() - t0).toBeLessThan(1000)
    await ws.close()
  })

  it('aborts inside a for loop within one iteration', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 100)
    await expect(
      ws.execute('for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; done', {
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1500)
    await ws.close()
  })

  it('aborts between LIST stages', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 100)
    await expect(
      ws.execute('sleep 1 && sleep 1 && sleep 1 && echo done', {
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(2000)
    await ws.close()
  })

  it('aborts inside a while loop', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 100)
    await expect(
      ws.execute('while true; do sleep 1; done', { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1500)
    await ws.close()
  })

  it('aborts mid-pipeline', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 100)
    await expect(
      ws.execute('sleep 1 | sleep 1 | sleep 1', { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1500)
    await ws.close()
  })

  it('aborts inside a command substitution', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    await expect(
      ws.execute('echo "$(sleep 5)"', { signal: AbortSignal.timeout(100) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1000)
    await ws.close()
  })

  it('aborts on manual AbortController.abort() during sleep', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    const ac = new AbortController()
    setTimeout(() => {
      ac.abort()
    }, 100)
    await expect(ws.execute('sleep 5', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    await ws.close()
  })

  it('aborts inside a shell-syntax subshell (sleep 5)', async () => {
    const ws = await makeWs()
    const t0 = Date.now()
    await expect(
      ws.execute('(sleep 5)', { signal: AbortSignal.timeout(100) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1000)
    await ws.close()
  })

  it('aborts inside a user-defined function body', async () => {
    const ws = await makeWs()
    await ws.execute('loopy() { while true; do sleep 1; done; }')
    const t0 = Date.now()
    await expect(ws.execute('loopy', { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(Date.now() - t0).toBeLessThan(1500)
    await ws.close()
  })

  it('workspace remains usable after an aborted command', async () => {
    const ws = await makeWs()
    await expect(ws.execute('sleep 5', { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: 'AbortError',
    })
    const r = await ws.execute('echo recovered')
    expect(r.exitCode).toBe(0)
    expect(stdoutStr(r).trim()).toBe('recovered')
    await ws.close()
  })

  it('does not pollute session.lastExitCode on abort', async () => {
    const ws = await makeWs()
    await ws.execute('true')
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(0)
    await expect(ws.execute('sleep 5', { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(0)
    const events = await ws.observer.commandEvents()
    expect(events.at(-1)?.exit_code).toBe(130)
    await ws.close()
  })

  it('undoes a status stamped by a statement before the abort', async () => {
    const ws = await makeWs()
    await ws.execute('false')
    await expect(
      ws.execute('true; sleep 5', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    await ws.close()
  })

  it('refuses the status of a statement that settles after the release', async () => {
    // The leaf returns at once with a lazy stream that ignores the signal
    // and yields past the grace, so the drain settles on a shell the
    // caller was already released from.
    const ws = await makeWs()
    const late = new RegisteredCommand({
      name: 'latecmd',
      spec: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
      resource: ResourceName.RAM,
      fn: () => [
        (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 450))
          yield ENC.encode('late\n')
        })(),
        new IOResult(),
      ],
    })
    ws.registry.mountForPrefix('/ram').register(late)
    await ws.execute('false')
    const session = ws.sessionManager.get(ws.sessionManager.defaultId)
    await expect(
      ws.execute('latecmd /ram/x', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(session.lastExitCode).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(session.lastExitCode).toBe(1)
    await ws.close()
  })

  it('releases the caller when the session store stalls before the line runs', async () => {
    class Stalled extends RAMSessionStore {
      override load(): Promise<Map<string, SessionFields>> {
        return new Promise<never>(() => undefined)
      }
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, sessionStore: new Stalled() },
    )
    await expect(ws.execute('echo hi', { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: 'AbortError',
    })
    // A line is recorded once it has been parsed; one that never got past
    // the loading of workspace state leaves no history entry, as in Python.
    expect(await ws.observer.commandEvents()).toEqual([])
  })

  it('restores the status when a stalled flush outlives the grace', async () => {
    // The line stamped its status and then its flush never settles: the
    // caller is released after the grace, and `$?` is what the line found.
    class Stalled extends RAMSessionStore {
      stall = false
      override casSet(
        sessionId: string,
        fields: SessionFields,
        expectedGeneration: number,
      ): Promise<boolean> {
        if (this.stall) return new Promise<never>(() => undefined)
        return super.casSet(sessionId, fields, expectedGeneration)
      }
    }
    const store = new Stalled()
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, sessionStore: store },
    )
    // The first line persists the fresh session; after it, status is not
    // a durable field, so only the env write below has a flush to stall.
    await ws.execute('false')
    store.stall = true
    const session = ws.sessionManager.get(ws.sessionManager.defaultId)
    await expect(
      ws.execute('export MARK=1', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(session.lastExitCode).toBe(1)
  })

  it('answers an abort that lands on the session flush with the abort', async () => {
    // The line finished; the flush of its status is what the abort lands
    // on, and it settles inside the grace. The answer is still the abort,
    // and `$?` is what the line found.
    class Slow extends RAMSessionStore {
      override async casSet(
        sessionId: string,
        fields: SessionFields,
        expectedGeneration: number,
      ): Promise<boolean> {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return super.casSet(sessionId, fields, expectedGeneration)
      }
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, sessionStore: new Slow() },
    )
    await ws.execute('false')
    // An env write is durable, so this line has a flush to land on.
    await expect(
      ws.execute('export MARK=1', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    await ws.close()
  })

  it('releases the caller when the history store stalls after a whole-line runtime', async () => {
    class Answers extends Runtime implements LineExecutor {
      readonly name = 'answers'
      readonly [LINE_EXECUTOR] = true as const
      constructor() {
        super({ captures: ['anscmd'] })
      }
      runLine(): Promise<RunResult> {
        return Promise.resolve({ stdout: ENC.encode('ok\n'), stderr: null, exitCode: 0 })
      }
    }
    class Stalled extends RAMObserverStore {
      override append(): Promise<never> {
        return new Promise<never>(() => undefined)
      }
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new Answers(), 'vfs'],
        observe: new Stalled(),
      },
    )
    // The runtime answered; the record of the line is what stalls.
    await expect(
      ws.execute('anscmd now', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the abort of one line out of another on the same session', async () => {
    // The status door reads the signal of the line that produced the
    // statement, so an aborted sibling cannot make this line throw or
    // stop early.
    const ws = await makeWs()
    const kept = ws.execute('sleep 0.4; echo kept')
    await expect(ws.execute('sleep 5', { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: 'AbortError',
    })
    const result = await kept
    expect(result.exitCode).toBe(0)
    expect(stdoutStr(result).trim()).toBe('kept')
    await ws.close()
  })

  it('starts no further op after the release of a namespace-routed line', async () => {
    // `rm l1 l2` on two links: the first unlink is held at the op door
    // past the grace, so the caller is released. The held unlink then
    // completes and the handler resumes; the second operand must not
    // reach the door. Python's cancelled task never gets there.
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const seen: string[] = []
    const held: { armed: boolean; release: () => void } = { armed: false, release: () => undefined }
    const first = new Promise<void>((resolve) => {
      held.release = resolve
    })
    const ws = new Workspace(
      { '/ram/': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        policies: [
          {
            preOps: async (ctx: OpsContext): Promise<Action | null> => {
              if (!held.armed || ctx.op !== 'unlink') return null
              seen.push(ctx.path.virtual)
              if (seen.length === 1) await first
              return null
            },
          },
        ],
      },
    )
    await ws.execute('echo a > /ram/a; echo b > /ram/b; ln -s /ram/a /ram/l1; ln -s /ram/b /ram/l2')
    held.armed = true
    const controller = new AbortController()
    const run = ws.execute('rm /ram/l1 /ram/l2', { signal: controller.signal })
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    held.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual(['/ram/l1'])
    expect(stdoutStr(await ws.execute('readlink /ram/l2'))).toBe('/ram/b\n')
    await ws.close()
  })

  it('starts no further backend write after the release of a mount command', async () => {
    // The same shape for a generic-bound command: `rm a b` on two files,
    // the first unlink held at the slot's policy gate past the grace.
    // The handler resumes after the release; the second file must keep
    // its bytes.
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const seen: string[] = []
    const held: { armed: boolean; release: () => void } = { armed: false, release: () => undefined }
    const first = new Promise<void>((resolve) => {
      held.release = resolve
    })
    const ws = new Workspace(
      { '/ram/': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        policies: [
          {
            preOps: async (ctx: OpsContext): Promise<Action | null> => {
              if (!held.armed || ctx.op !== 'unlink') return null
              seen.push(ctx.path.virtual)
              if (seen.length === 1) await first
              return null
            },
          },
        ],
      },
    )
    await ws.execute('echo a > /ram/a; echo b > /ram/b')
    held.armed = true
    const controller = new AbortController()
    const run = ws.execute('rm /ram/a /ram/b', { signal: controller.signal })
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    held.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual(['/ram/a'])
    expect(stdoutStr(await ws.execute('cat /ram/b'))).toBe('b\n')
    await ws.close()
  })

  it('aborts a whole-line runtime that never answers', async () => {
    class Hanging extends Runtime implements LineExecutor {
      readonly name = 'hanging'
      readonly [LINE_EXECUTOR] = true as const
      constructor() {
        super({ captures: ['hangcmd'] })
      }
      runLine(): Promise<RunResult> {
        return new Promise<never>(() => undefined)
      }
    }
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [new Hanging(), 'vfs'] },
    )
    await expect(
      ws.execute('hangcmd now', { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    await ws.close()
  })

  it('aborts while the file cache is being filled', async () => {
    const ws = await makeWs()
    await ws.execute('false')
    const controller = new AbortController()
    const dispatcher = (ws as unknown as { dispatcher: { applyIo: () => Promise<void> } })
      .dispatcher
    dispatcher.applyIo = async () => {
      controller.abort()
      await new Promise<never>(() => undefined)
    }
    await expect(ws.execute('echo hi', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    const events = await ws.observer.commandEvents()
    expect(events.at(-1)?.exit_code).toBe(130)
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    await ws.close()
  })
})

describe('execute(): agent harness pattern', () => {
  async function toolCall(
    ws: Workspace,
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<ExecuteResult> {
    return ws.execute(cmd, { cwd, env, signal: AbortSignal.timeout(timeoutMs) })
  }

  it('parallel toolCalls with their own cwd+env+timeout all succeed', async () => {
    const ws = await makeWs()
    const [a, b] = await Promise.all([
      toolCall(ws, 'pwd; printenv DEBUG', '/ram/subdir', { DEBUG: 'one' }, 5000),
      toolCall(ws, 'pwd; printenv DEBUG', '/ram', { DEBUG: 'two' }, 5000),
    ])
    expect(stdoutStr(a)).toContain('/ram/subdir')
    expect(stdoutStr(a)).toContain('one')
    expect(stdoutStr(b)).toContain('/ram')
    expect(stdoutStr(b)).toContain('two')
    expect(ws.cwd).not.toBe('/ram/subdir')
    expect(ws.env.DEBUG).toBeUndefined()
    await ws.close()
  })

  it('one parallel toolCall aborts on its own timeout while siblings continue', async () => {
    const ws = await makeWs()
    const settled = await Promise.allSettled([
      toolCall(ws, 'sleep 5', '/ram/subdir', { DEBUG: 'one' }, 100),
      toolCall(ws, 'echo ok', '/ram', { DEBUG: 'two' }, 5000),
    ])
    expect(settled[0].status).toBe('rejected')
    if (settled[0].status === 'rejected') {
      expect(settled[0].reason).toMatchObject({ name: 'AbortError' })
    }
    expect(settled[1].status).toBe('fulfilled')
    if (settled[1].status === 'fulfilled') {
      expect(stdoutStr(settled[1].value).trim()).toBe('ok')
    }
    await ws.close()
  })
})

describe('execute({ sink }): streaming output to a console', () => {
  it('streams the output to the console and returns empty stdout', async () => {
    const ws = await makeWs()
    const console_ = new JobConsole()
    const result = await ws.execute('echo hello', { sink: console_ })
    // The bytes went to the console, so the result carries only the code.
    expect(result.exitCode).toBe(0)
    expect(stdoutStr(result)).toBe('')
    const streamed = DEC.decode(await console_.snapshot(Channel.STDOUT))
    expect(streamed.trim()).toBe('hello')
    await ws.close()
  })

  it('emits each statement of a compound line as its own chunk', async () => {
    const ws = await makeWs()
    const console_ = new JobConsole()
    await ws.execute('echo a; echo b; echo c', { sink: console_ })
    const [chunks] = await console_.readFrom(0)
    const stdout = chunks.filter((c) => c.channel === Channel.STDOUT)
    expect(stdout.length).toBe(3)
    expect(stdout.map((c) => DEC.decode(c.data).trim())).toEqual(['a', 'b', 'c'])
    await ws.close()
  })

  it('routes stderr to the console on its own channel', async () => {
    const ws = await makeWs()
    const console_ = new JobConsole()
    const result = await ws.execute('echo oops >&2', { sink: console_ })
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(await console_.snapshot(Channel.STDERR)).trim()).toBe('oops')
    await ws.close()
  })

  it('sends a syntax error to the console, not the result', async () => {
    const ws = await makeWs()
    const console_ = new JobConsole()
    // The syntax gate answers before the walk that emits, so this is
    // output the console would never see without the drain.
    const result = await ws.execute('case x', { sink: console_ })
    expect(result.exitCode).toBe(2)
    expect(stdoutStr(result)).toBe('')
    expect(DEC.decode(result.stderr)).toBe('')
    expect(DEC.decode(await console_.snapshot(Channel.STDERR))).toContain('syntax error')
    await ws.close()
  })

  it('releases the caller when the sink store stalls on a buffered result', async () => {
    class Stalled extends RAMConsoleStore {
      override append(): Promise<never> {
        return new Promise<never>(() => undefined)
      }
    }
    const ws = await makeWs()
    const console_ = new JobConsole(new Stalled())
    // The syntax gate answers with bytes in hand, so the only await left
    // after the tree is the drain into the store.
    await expect(
      ws.execute('case x', { sink: console_, signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await ws.close()
  })

  it('answers an abort that lands on the sink drain with the abort', async () => {
    class Slow extends RAMConsoleStore {
      override async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return super.append(channel, data)
      }
    }
    const ws = await makeWs()
    await ws.execute('false')
    // The syntax gate stamps 2 and answers with bytes in hand; the abort
    // lands on their drain, which settles inside the grace.
    await expect(
      ws.execute('case x', { sink: new JobConsole(new Slow()), signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    await ws.close()
  })

  it("sends a failed command's stderr to the console", async () => {
    const ws = await makeWs()
    const console_ = new JobConsole()
    const result = await ws.execute('cat /ram/missing.txt', { sink: console_ })
    expect(result.exitCode).not.toBe(0)
    expect(DEC.decode(result.stderr)).toBe('')
    expect(DEC.decode(await console_.snapshot(Channel.STDERR))).toContain('missing.txt')
    await ws.close()
  })
})

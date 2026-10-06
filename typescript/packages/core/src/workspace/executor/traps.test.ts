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
import { IOResult, materialize } from '../../io/types.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { ExecuteStringFn } from './builtins/types.ts'
import { clearExitTrap, endShell, finishShell, inheritExitTrap, runExitTrap } from './traps.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function makeSession(action: string | null = null): SessionState {
  const session = new SessionState({ sessionId: 's1' })
  session.exitTrap = action
  return session
}

interface Call {
  line: string
  stdin: unknown
  callStack: CallStack | undefined
}

function recorder(result: IOResult | Error): { run: ExecuteStringFn; calls: Call[] } {
  const calls: Call[] = []
  const run: ExecuteStringFn = (line, opts) => {
    calls.push({ line, stdin: opts.stdin, callStack: opts.callStack })
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
  return { run, calls }
}

describe('runExitTrap', () => {
  it('runs nothing without an action of its own', async () => {
    const { run, calls } = recorder(new IOResult())
    expect(await runExitTrap(run, makeSession(), 3)).toBeNull()
    const inherited = makeSession('echo x')
    inheritExitTrap(inherited)
    expect(await runExitTrap(run, inherited, 3)).toBeNull()
    expect(await runExitTrap(run, makeSession(''), 3)).toBeNull()
    expect(calls).toEqual([])
  })

  it('runs the action once in the frames given', async () => {
    const { run, calls } = recorder(new IOResult({ stdout: ENC.encode('bye\n') }))
    const session = makeSession('echo bye')
    const frames = new CallStack()
    frames.push(['a'], 'f')
    const stdin = ENC.encode('in')
    const cleanup = await runExitTrap(run, session, 7, stdin, frames)
    expect(DEC.decode(await materialize(cleanup?.stdout))).toBe('bye\n')
    expect(cleanup?.exitCode).toBe(7)
    expect(session.lastExitCode).toBe(7)
    expect(calls).toEqual([{ line: 'echo bye', stdin, callStack: frames }])
    expect(session.exitTrap).toBeNull()
    expect(await runExitTrap(run, session, 7)).toBeNull()
  })

  it('lets an exit in the action set the status', async () => {
    const { run } = recorder(new ExitSignal(9, ENC.encode('e\n'), ENC.encode('o\n')))
    const cleanup = await runExitTrap(run, makeSession('exit 9'), 7)
    expect(cleanup?.exitCode).toBe(9)
    expect(DEC.decode(await materialize(cleanup?.stdout))).toBe('o\n')
    expect(DEC.decode(await materialize(cleanup?.stderr))).toBe('e\n')
  })

  it('counts a failure only under errexit', async () => {
    const failing = new IOResult({ exitCode: 1 })
    const plain = await runExitTrap(recorder(failing).run, makeSession('false'), 5)
    expect(plain?.exitCode).toBe(5)
    const session = makeSession('false')
    session.shellOptions.errexit = true
    const errexit = await runExitTrap(recorder(failing).run, session, 5)
    expect(errexit?.exitCode).toBe(1)
  })

  // `false && x` or `! true` ends the action failing, but `set -e` does
  // not act on it, so it ends no shell.
  it('keeps the status on a failure errexit exempts', async () => {
    const session = makeSession('false && echo skipped')
    session.shellOptions.errexit = true
    session.errexitImmune = true
    const exempt = await runExitTrap(recorder(new IOResult({ exitCode: 1 })).run, session, 7)
    expect(exempt?.exitCode).toBe(7)
  })

  it('does not start an action again while one runs', async () => {
    const session = makeSession('echo again')
    session.trapStatus = 2
    expect(await runExitTrap(recorder(new IOResult()).run, session, 2)).toBeNull()
  })
})

describe('child and new shells', () => {
  it('list the parent action in a child and drop it in a new shell', () => {
    const child = makeSession('echo parent')
    inheritExitTrap(child)
    expect(child.exitTrap).toBe('echo parent')
    expect(child.exitTrapInherited).toBe(true)
    const fresh = makeSession('echo parent')
    clearExitTrap(fresh)
    expect(fresh.exitTrap).toBeNull()
    expect(fresh.exitTrapInherited).toBe(false)
  })
})

describe('finishShell and endShell', () => {
  it('appends cleanup after the line', async () => {
    const { run } = recorder(
      new IOResult({ stdout: ENC.encode('cleanup\n'), stderr: ENC.encode('err\n') }),
    )
    const io = await finishShell(
      run,
      makeSession('echo cleanup'),
      new IOResult({ stdout: ENC.encode('body\n'), stderr: ENC.encode('warn\n'), exitCode: 4 }),
    )
    expect(DEC.decode(await io.materializeStdout())).toBe('body\ncleanup\n')
    expect(DEC.decode(await io.materializeStderr())).toBe('warn\nerr\n')
    expect(io.exitCode).toBe(4)
  })

  it('carries cleanup on an exit', async () => {
    const { run } = recorder(new IOResult({ stdout: ENC.encode('cleanup\n') }))
    const body = Promise.reject(new ExitSignal(3, new Uint8Array(), ENC.encode('body\n')))
    const err: unknown = await endShell(run, makeSession('echo cleanup'), null, null, body).catch(
      (thrown: unknown) => thrown,
    )
    expect(err).toBeInstanceOf(ExitSignal)
    expect(DEC.decode((err as ExitSignal).stdout ?? new Uint8Array())).toBe('body\ncleanup\n')
    expect((err as ExitSignal).containedCode).toBe(3)
  })

  it('runs cleanup after a normal end', async () => {
    const { run } = recorder(new IOResult({ stdout: ENC.encode('cleanup\n') }))
    const body = Promise.resolve<[Uint8Array, IOResult, ExecutionNode]>([
      ENC.encode('body\n'),
      new IOResult({ exitCode: 2 }),
      new ExecutionNode({ exitCode: 2 }),
    ])
    const [stdout, io, node] = await endShell(run, makeSession('echo cleanup'), null, null, body)
    expect(DEC.decode(await materialize(stdout))).toBe('body\ncleanup\n')
    expect(io.exitCode).toBe(2)
    expect(node.exitCode).toBe(2)
  })
})

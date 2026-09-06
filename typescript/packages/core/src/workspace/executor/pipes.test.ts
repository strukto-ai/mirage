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

import { seedVar } from '../../workspace/session/state.ts'
import { varsFromEnv } from '../../workspace/session/session.ts'
import { describe, expect, it } from 'vitest'
import { IOResult, materialize } from '../../io/types.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import { handleConnection, handlePipe, handleSubshell } from './pipes.ts'
import { makeIntegrationWS } from '../fixtures/integration_fixture.ts'

function node(text: string): TSNodeLike {
  return { type: 'command', text, children: [], namedChildren: [], isNamed: true }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

describe('handlePipe', () => {
  it('connects stdout of cmd[i] to stdin of cmd[i+1]', async () => {
    const calls: { text: string; stdinBytes: string }[] = []
    const execute: ExecuteNodeFn = async (nd, _session, stdin) => {
      const stdinBytes = decode(await materialize(stdin))
      calls.push({ text: nd.text, stdinBytes })
      return [
        encode(`${nd.text}-out`),
        new IOResult({ exitCode: 0 }),
        new ExecutionNode({ command: nd.text, exitCode: 0 }),
      ]
    }

    const [stdout, io] = await handlePipe(
      execute,
      [node('a'), node('b'), node('c')],
      [false, false],
      new Session({ sessionId: 'test' }),
      null,
    )
    expect(io.exitCode).toBe(0)
    expect(decode(stdout as Uint8Array)).toBe('c-out')
    expect(calls[0]?.stdinBytes).toBe('')
    expect(calls[1]?.stdinBytes).toBe('a-out')
    expect(calls[2]?.stdinBytes).toBe('b-out')
  })

  it('passes empty stdin when left command errors with null stdout', async () => {
    const calls: { text: string; stdinBytes: string; stdinIsNull: boolean }[] = []
    const execute: ExecuteNodeFn = async (nd, _session, stdin) => {
      const stdinIsNull = stdin === null
      const stdinBytes = decode(await materialize(stdin))
      calls.push({ text: nd.text, stdinBytes, stdinIsNull })
      if (nd.text === 'left') {
        return [
          null,
          new IOResult({ stderr: encode('boom'), exitCode: 1 }),
          new ExecutionNode({ command: nd.text, exitCode: 1 }),
        ]
      }
      return [
        encode(`${nd.text}-out`),
        new IOResult({ exitCode: 0 }),
        new ExecutionNode({ command: nd.text, exitCode: 0 }),
      ]
    }

    await handlePipe(
      execute,
      [node('left'), node('right')],
      [false],
      new Session({ sessionId: 'test' }),
      null,
    )
    const right = calls.find((c) => c.text === 'right')
    expect(right?.stdinIsNull).toBe(false)
    expect(right?.stdinBytes).toBe('')
  })

  it('shows every segment the status the pipeline started with', async () => {
    const s = new Session({ sessionId: 'test' })
    s.lastExitCode = 1
    const seen: number[] = []
    const execute: ExecuteNodeFn = (nd, session) => {
      seen.push(session.lastExitCode)
      // An inner statement of a compound segment lands its own status.
      session.lastExitCode = 0
      return Promise.resolve([
        null,
        new IOResult({ exitCode: 0 }),
        new ExecutionNode({ command: nd.text, exitCode: 0 }),
      ])
    }
    await handlePipe(execute, [node('a'), node('b')], [false], s)
    expect(seen).toEqual([1, 1])
  })

  it('expands $? in a segment to the pre-pipeline status', async () => {
    // bash 5.2: each segment is a child of the shell as it stood before
    // the pipeline, so `$?` is the pre-pipeline status even after a
    // sibling segment ran a compound command or a function.
    const { ws } = await makeIntegrationWS()
    try {
      for (const line of [
        'false; { true; } | echo $?',
        'f() { true; }; false; f | echo $?',
        'false; true | echo $?',
      ]) {
        const io = await ws.execute(line)
        expect([io.stdoutText, io.exitCode], line).toEqual(['1\n', 0])
      }
      expect((await ws.execute('false; { false; } | true; echo $?')).stdoutText).toBe('0\n')
    } finally {
      await ws.close()
    }
  })

  it('concatenates stderr from all stages into the final IOResult', async () => {
    const execute: ExecuteNodeFn = (nd) =>
      Promise.resolve<[Uint8Array | null, IOResult, ExecutionNode]>([
        null,
        new IOResult({ stderr: encode(`${nd.text}-err;`), exitCode: 0 }),
        new ExecutionNode({ command: nd.text, exitCode: 0 }),
      ])
    const [, io] = await handlePipe(
      execute,
      [node('a'), node('b')],
      [],
      new Session({ sessionId: 'test' }),
    )
    expect(decode(await materialize(io.stderr))).toBe('a-err;b-err;')
  })
})

describe('handleConnection (&&, ||, ;)', () => {
  const leftOK: ExecuteNodeFn = () =>
    Promise.resolve([
      encode('left'),
      new IOResult({ exitCode: 0 }),
      new ExecutionNode({ exitCode: 0 }),
    ])
  const leftFail: ExecuteNodeFn = () =>
    Promise.resolve([
      encode('left'),
      new IOResult({ exitCode: 7 }),
      new ExecutionNode({ exitCode: 7 }),
    ])
  const right: ExecuteNodeFn = () =>
    Promise.resolve([
      encode('right'),
      new IOResult({ exitCode: 0 }),
      new ExecutionNode({ exitCode: 0 }),
    ])

  const pickLR = (l: ExecuteNodeFn, r: ExecuteNodeFn): ExecuteNodeFn => {
    let first = true
    return async (nd, s, i, cs) => {
      const fn = first ? l : r
      first = false
      return fn(nd, s, i, cs)
    }
  }

  it('&& runs right when left exits 0', async () => {
    const s = new Session({ sessionId: 'test' })
    const [stdout, io] = await handleConnection(
      pickLR(leftOK, right),
      node('l'),
      NT.AND,
      node('r'),
      s,
    )
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('leftright')
  })

  it('&& short-circuits when left fails', async () => {
    let rightCalled = false
    const leftFailFn: ExecuteNodeFn = () =>
      Promise.resolve([
        encode('L'),
        new IOResult({ exitCode: 9 }),
        new ExecutionNode({ exitCode: 9 }),
      ])
    const rightFn: ExecuteNodeFn = () => {
      rightCalled = true
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleConnection(
      pickLR(leftFailFn, rightFn),
      node('l'),
      NT.AND,
      node('r'),
      s,
    )
    expect(io.exitCode).toBe(9)
    expect(rightCalled).toBe(false)
  })

  it('|| runs right only when left fails', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleConnection(pickLR(leftFail, right), node('l'), NT.OR, node('r'), s)
    expect(io.exitCode).toBe(0)
  })

  it('|| short-circuits when left succeeds', async () => {
    let rightCalled = false
    const rightFn: ExecuteNodeFn = () => {
      rightCalled = true
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const s = new Session({ sessionId: 'test' })
    await handleConnection(pickLR(leftOK, rightFn), node('l'), NT.OR, node('r'), s)
    expect(rightCalled).toBe(false)
  })

  it('; runs both regardless of left exit code', async () => {
    let rightCalled = false
    const rightFn: ExecuteNodeFn = () => {
      rightCalled = true
      return Promise.resolve([encode('r'), new IOResult(), new ExecutionNode()])
    }
    const s = new Session({ sessionId: 'test' })
    await handleConnection(pickLR(leftFail, rightFn), node('l'), NT.SEMI, node('r'), s)
    expect(rightCalled).toBe(true)
  })
})

describe('handleSubshell', () => {
  it('restores cwd and env after body execution', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/orig', vars: varsFromEnv({ X: 'orig' }) })
    const execute: ExecuteNodeFn = (_n, session) => {
      session.cwd = '/inside'
      seedVar(session, 'X', 'inside')
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    await handleSubshell(execute, [node('a')], s)
    expect(s.cwd).toBe('/orig')
    expect(s.env.X).toBe('orig')
  })

  it('runs multiple body statements and merges their IOResults', async () => {
    const s = new Session({ sessionId: 'test' })
    let i = 0
    const execute: ExecuteNodeFn = () => {
      i++
      return Promise.resolve([
        encode(`s${i.toString()}`),
        new IOResult({ exitCode: i }),
        new ExecutionNode(),
      ])
    }
    const [stdout, io] = await handleSubshell(execute, [node('a'), node('b')], s)
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(stdout))).toBe('s1s2')
  })

  it('seeds lastExitCode between body commands for $?', async () => {
    const s = new Session({ sessionId: 'test' })
    s.lastExitCode = 0
    const seen: number[] = []
    const execute: ExecuteNodeFn = (nd, session) => {
      seen.push(session.lastExitCode)
      const code = nd.text === 'a' ? 7 : 0
      return Promise.resolve([
        null,
        new IOResult({ exitCode: code }),
        new ExecutionNode({ command: nd.text, exitCode: code }),
      ])
    }
    await handleSubshell(execute, [node('a'), node('b')], s)
    expect(seen).toEqual([0, 7])
    expect(s.lastExitCode).toBe(0)
  })
})

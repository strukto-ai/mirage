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

import { EvaluationContext } from '../evaluation.ts'
import { describe, expect, it } from 'vitest'
import { IOResult, materialize } from '../../io/types.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { JobTable } from '../../execution/job/index.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { MountRegistry } from '../mount/registry.ts'
import { type BodyRun, carried, executeBody, handleWhile, takeStdout } from './control.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import type { ExecuteNodeDeps } from './deps.ts'

function node(text: string, nextSibling: TSNodeLike | null = null): TSNodeLike {
  return { type: 'command', text, children: [], namedChildren: [], isNamed: true, nextSibling }
}

const noLine = (): Promise<IOResult> => Promise.reject(new Error('nothing to run'))

function bareDeps(): ExecuteNodeDeps {
  const registry = new MountRegistry({ '/ram': new RAMVFS() }, MountMode.WRITE)
  return {
    dispatch: () => {
      throw new Error('dispatch should not have been called')
    },
    registry,
    namespace: new Namespace(registry, (p) => Promise.resolve(registry.resolve(p))),
    jobTable: new JobTable(),
    executeFn: noLine,
  }
}

function runner(execute: ExecuteNodeFn, session: SessionState): BodyRun {
  const context = new EvaluationContext(session)
  const deps = bareDeps()
  return (nodes, bound) => executeBody(deps, execute, nodes, context, null, null, bound)
}

describe('handleWhile', () => {
  it('stops at a set -e failure in its body', async () => {
    let turns = 0
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond') return Promise.resolve([null, new IOResult(), new ExecutionNode()])
      turns += 1
      expect(turns).toBeLessThan(3)
      return Promise.resolve([null, new IOResult({ exitCode: 1 }), new ExecutionNode()])
    }
    const s = new SessionState({ sessionId: 'test' })
    s.shellOptions.errexit = true
    const [, io] = await handleWhile(
      runner(execute, s),
      [node('cond')],
      [node('body')],
      new EvaluationContext(s),
      noLine,
      null,
    )
    expect([turns, io.exitCode]).toEqual([1, 1])
  })

  it('runs until its condition fails', async () => {
    let turns = 0
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond') {
        turns += 1
        const exitCode = turns <= 10001 ? 0 : 1
        return Promise.resolve([null, new IOResult({ exitCode }), new ExecutionNode()])
      }
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleWhile(
      runner(execute, s),
      [node('cond')],
      [node('body')],
      new EvaluationContext(s),
      noLine,
      null,
    )
    expect(turns).toBe(10002)
    expect((await materialize(io.stderr)).byteLength).toBe(0)
  })
})

describe('an exit carries a stream', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
  const dec = (data: Uint8Array): string => new TextDecoder().decode(data)

  it('takeStdout hands on a stream unread', async () => {
    // An exec'd program's returned output reaches the redirects it ran
    // under as it is read; only an EXIT action's output at its end is cut
    // off, which needs the whole of it.
    async function* written(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(enc('out\n'))
    }
    const stream = written()
    const sig = new ExitSignal(0, new Uint8Array(), stream)
    sig.unrouted = true
    expect(await takeStdout(sig)).toBe(stream)
    expect(sig.stdout).toBeNull()
    const left = new ExitSignal(0, new Uint8Array(), enc('out\nbye\n'))
    left.unrouted = true
    left.cleanup = enc('bye\n')
    expect(dec(await materialize(await takeStdout(left)))).toBe('out\n')
    expect(dec(await materialize(left.stdout))).toBe('bye\n')
  })

  it('carried chains an exit after the output before it', async () => {
    async function* written(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(enc('program\n'))
    }
    const sig = await carried(
      new ExitSignal(3, new Uint8Array(), written()),
      enc('before\n'),
      new IOResult({ stderr: enc('said\n') }),
    )
    expect(sig).toBeInstanceOf(ExitSignal)
    const exit = sig as ExitSignal
    expect(dec(await materialize(exit.stdout))).toBe('before\nprogram\n')
    expect([exit.exitCode, dec(exit.stderr)]).toEqual([3, 'said\n'])
  })
})

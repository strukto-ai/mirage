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
import type { TSNodeLike } from '../../shell/types.ts'
import { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { type BodyRun, executeBody, handleIf, handleWhile } from './control.ts'
import type { ExecuteNodeFn } from './command/types.ts'

function node(text: string, nextSibling: TSNodeLike | null = null): TSNodeLike {
  return { type: 'command', text, children: [], namedChildren: [], isNamed: true, nextSibling }
}

/** A body statement whose terminator is `&`. */
function bg(text: string): TSNodeLike {
  return node(text, { type: '&', text: '&', children: [], namedChildren: [], isNamed: false })
}

function runner(execute: ExecuteNodeFn, session: SessionState): BodyRun {
  const context = new EvaluationContext(session)
  return (nodes, bound) =>
    executeBody(execute, nodes, context, null, null, null, null, null, null, null, null, bound)
}

describe('handleWhile', () => {
  it('while caps at MAX_WHILE iterations with a stderr warning', async () => {
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond')
        return Promise.resolve([null, new IOResult({ exitCode: 0 }), new ExecutionNode()])
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleWhile(runner(execute, s), [node('cond')], [node('body')], s)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toMatch(
      /while loop terminated after 10000/,
    )
  })
})

describe('& inside a body', () => {
  it('fails loud without a job table', async () => {
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([null, new IOResult(), new ExecutionNode()])
    const branches: [TSNodeLike[], TSNodeLike[]][] = [[[node('c')], [bg('x')]]]
    const s = new SessionState({ sessionId: 'test' })
    await expect(handleIf(runner(execute, s), branches, null, s)).rejects.toThrow(/job table/)
  })
})

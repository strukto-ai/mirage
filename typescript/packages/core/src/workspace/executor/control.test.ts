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
import type { TSNodeLike } from '../expand/variable.ts'
import { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import {
  BreakSignal,
  ContinueSignal,
  handleCase,
  handleFor,
  handleIf,
  handleUntil,
  handleWhile,
} from './control.ts'
import type { ExecuteNodeFn } from './jobs.ts'

function node(text: string): TSNodeLike {
  return { type: 'command', text, children: [], namedChildren: [], isNamed: true }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

describe('handleIf', () => {
  it('runs the first matching branch and skips the rest', async () => {
    const calls: string[] = []
    let execCounter = 0
    const execute: ExecuteNodeFn = (n) => {
      calls.push(n.text)
      // Condition nodes are labeled "c1"/"c2"; body nodes "b1"/"b2".
      execCounter++
      if (n.text === 'c1') {
        return Promise.resolve([null, new IOResult({ exitCode: 1 }), new ExecutionNode()])
      }
      if (n.text === 'c2') {
        return Promise.resolve([null, new IOResult({ exitCode: 0 }), new ExecutionNode()])
      }
      return Promise.resolve([encode(`${n.text}-out`), new IOResult(), new ExecutionNode()])
    }
    const branches: [TSNodeLike, TSNodeLike[]][] = [
      [node('c1'), [node('b1')]],
      [node('c2'), [node('b2')]],
    ]
    const [stdout, io] = await handleIf(execute, branches, null, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('b2-out')
    expect(calls).toEqual(['c1', 'c2', 'b2'])
    expect(execCounter).toBe(3)
  })

  it('runs the else body when no branch matches', async () => {
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'c')
        return Promise.resolve([null, new IOResult({ exitCode: 1 }), new ExecutionNode()])
      return Promise.resolve([encode('else-out'), new IOResult(), new ExecutionNode()])
    }
    const [stdout, io] = await handleIf(
      execute,
      [[node('c'), [node('b')]]],
      [node('e')],
      new Session({ sessionId: 'test' }),
    )
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('else-out')
  })
})

describe('handleFor', () => {
  it('iterates values, sets env var, runs body per iter', async () => {
    const seen: string[] = []
    const execute: ExecuteNodeFn = (_n, s) => {
      seen.push(s.env.X ?? '')
      return Promise.resolve([
        encode(`iter-${s.env.X ?? ''}\n`),
        new IOResult(),
        new ExecutionNode(),
      ])
    }
    const s = new Session({ sessionId: 'test' })
    const [stdout] = await handleFor(execute, 'X', ['a', 'b', 'c'], [node('body')], s)
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(decode(await materialize(stdout))).toBe('iter-a\niter-b\niter-c\n')
    expect(s.env.X).toBeUndefined()
  })

  it('BreakSignal stops the loop early', async () => {
    const seen: string[] = []
    const execute: ExecuteNodeFn = (_n, s) => {
      seen.push(s.env.X ?? '')
      if (s.env.X === 'b') throw new BreakSignal()
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    await handleFor(
      execute,
      'X',
      ['a', 'b', 'c'],
      [node('body')],
      new Session({ sessionId: 'test' }),
    )
    expect(seen).toEqual(['a', 'b'])
  })

  it('ContinueSignal skips to next iteration', async () => {
    const seen: string[] = []
    const execute: ExecuteNodeFn = (_n, s) => {
      seen.push(s.env.X ?? '')
      if (s.env.X === 'b') throw new ContinueSignal()
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    await handleFor(
      execute,
      'X',
      ['a', 'b', 'c'],
      [node('body')],
      new Session({ sessionId: 'test' }),
    )
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('restores previous value of the loop variable', async () => {
    const s = new Session({ sessionId: 'test', env: { X: 'saved' } })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([null, new IOResult(), new ExecutionNode()])
    await handleFor(execute, 'X', ['a'], [node('body')], s)
    expect(s.env.X).toBe('saved')
  })
})

describe('handleWhile / handleUntil', () => {
  it('while runs body while condition is 0, until runs while condition is nonzero', async () => {
    let i = 0
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond') {
        // Condition: 0 when i<2, nonzero when >=2
        const exit = i < 2 ? 0 : 1
        return Promise.resolve([null, new IOResult({ exitCode: exit }), new ExecutionNode()])
      }
      i += 1
      return Promise.resolve([encode(`${i.toString()};`), new IOResult(), new ExecutionNode()])
    }
    const [stdout] = await handleWhile(
      execute,
      node('cond'),
      [node('body')],
      new Session({ sessionId: 'test' }),
    )
    expect(decode(await materialize(stdout))).toBe('1;2;')
  })

  it('until runs body while condition is nonzero', async () => {
    let i = 0
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond') {
        const exit = i >= 2 ? 0 : 1
        return Promise.resolve([null, new IOResult({ exitCode: exit }), new ExecutionNode()])
      }
      i += 1
      return Promise.resolve([encode(`${i.toString()};`), new IOResult(), new ExecutionNode()])
    }
    const [stdout] = await handleUntil(
      execute,
      node('cond'),
      [node('body')],
      new Session({ sessionId: 'test' }),
    )
    expect(decode(await materialize(stdout))).toBe('1;2;')
  })

  it('while caps at MAX_WHILE iterations with a stderr warning', async () => {
    const execute: ExecuteNodeFn = (n) => {
      if (n.text === 'cond')
        return Promise.resolve([null, new IOResult({ exitCode: 0 }), new ExecutionNode()])
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const [, io] = await handleWhile(
      execute,
      node('cond'),
      [node('body')],
      new Session({ sessionId: 'test' }),
    )
    expect(decode(await materialize(io.stderr))).toMatch(/while loop terminated after 10000/)
  })
})

describe('handleCase', () => {
  it('matches the first pattern that fnmatches the word', async () => {
    let which = ''
    const execute: ExecuteNodeFn = (n) => {
      which = n.text
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const items: [string[], TSNodeLike[]][] = [
      [['a*'], [node('A')]],
      [['b*'], [node('B')]],
      [['*'], [node('catchall')]],
    ]
    await handleCase(execute, 'banana', items, new Session({ sessionId: 'test' }))
    expect(which).toBe('B')
  })

  it('falls through to catchall pattern', async () => {
    let which = ''
    const execute: ExecuteNodeFn = (n) => {
      which = n.text
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const items: [string[], TSNodeLike[]][] = [
      [['a*'], [node('A')]],
      [['*'], [node('catchall')]],
    ]
    await handleCase(execute, 'xyz', items, new Session({ sessionId: 'test' }))
    expect(which).toBe('catchall')
  })

  it('matches nothing when no pattern fits', async () => {
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([null, new IOResult(), new ExecutionNode()])
    const items: [string[], TSNodeLike[]][] = [[['z*'], [node('body')]]]
    const [, io] = await handleCase(execute, 'abc', items, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(0)
  })
})

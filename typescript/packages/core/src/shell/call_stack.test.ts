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
import { CallFrame, CallStack } from './call_stack.ts'
import { NESTING_MAX } from './constants.ts'
import { DiscardSignal } from './errors.ts'

describe('CallFrame', () => {
  it('defaults to empty positional + locals + no function name', () => {
    const f = new CallFrame()
    expect(f.positional).toEqual([])
    expect(f.locals).toEqual({})
    expect(f.functionName).toBe('')
    expect(f.loopLevel).toBe(0)
  })
})

describe('CallStack', () => {
  it('starts with one empty frame', () => {
    const cs = new CallStack()
    expect(cs.depth).toBe(1)
    expect(cs.getAllPositional()).toEqual([])
  })

  it('push and pop manage frames', () => {
    const cs = new CallStack()
    cs.push(['a', 'b'], 'foo')
    expect(cs.depth).toBe(2)
    expect(cs.current.functionName).toBe('foo')
    expect(cs.getAllPositional()).toEqual(['a', 'b'])
    cs.pop()
    expect(cs.depth).toBe(1)
  })

  it('pop on depth 1 returns current frame without shrinking', () => {
    const cs = new CallStack()
    const returned = cs.pop()
    expect(returned).toBe(cs.current)
    expect(cs.depth).toBe(1)
  })

  it('locals resolve from inner to outer frames', () => {
    const cs = new CallStack()
    cs.setLocal('OUTER', 'o1')
    cs.push([], 'f')
    cs.setLocal('INNER', 'i1')
    expect(cs.getLocal('INNER')).toBe('i1')
    expect(cs.getLocal('OUTER')).toBe('o1')
    expect(cs.getLocal('MISSING')).toBeNull()
  })
})

it('fork copies every frame without sharing mutable state', () => {
  const parent = new CallStack()
  parent.setPositional(['outer'])
  parent.setLocal('x', 'outer')
  parent.push(['a', 'b'], 'f')
  parent.setLocal('x', 'inner')
  parent.current.loopLevel = 2
  const child = parent.fork()
  parent.current.positional.push('c')
  parent.setLocal('x', 'changed')
  parent.pop()
  expect(child.depth).toBe(2)
  expect(child.getAllPositional()).toEqual(['a', 'b'])
  expect(child.getLocal('x')).toBe('inner')
  expect(child.current.functionName).toBe('f')
  expect(child.current.loopLevel).toBe(2)
  child.pop()
  child.setLocal('x', 'child')
  child.current.positional.push('child')
  expect(parent.getLocal('x')).toBe('outer')
  expect(parent.getAllPositional()).toEqual(['outer'])
})

it('functionDepth counts the function frames, which a fork keeps', () => {
  const cs = new CallStack()
  cs.push([], 'f')
  cs.push([], 'source', true)
  cs.push([], 'g')
  expect(cs.depth).toBe(4)
  expect(cs.functionDepth).toBe(2)
  expect(cs.fork().functionDepth).toBe(2)
})

it('nesting counts frames and levels, which a fork keeps', async () => {
  const cs = new CallStack()
  cs.push([], 'f')
  cs.push([], 'source', true)
  await cs.nested('eval', () => {
    expect(cs.nesting).toBe(3)
    expect(cs.fork().nesting).toBe(3)
    return Promise.resolve()
  })
  expect(cs.nesting).toBe(2)
})

it('a stack starts at the nesting it is given', () => {
  const cs = new CallStack(3)
  expect(cs.depth).toBe(1)
  expect(cs.functionDepth).toBe(0)
  expect(cs.nesting).toBe(3)
  expect(cs.fork().nesting).toBe(3)
})

it('admit refuses past the limit and leaves the count', async () => {
  const cs = new CallStack()
  cs.levels = NESTING_MAX - 1
  cs.admit('eval')
  cs.levels = NESTING_MAX
  const refused = await cs.nested('eval', () => Promise.resolve()).catch((err: unknown) => err)
  expect(refused).toBeInstanceOf(DiscardSignal)
  expect(new TextDecoder().decode((refused as DiscardSignal).stderr)).toBe(
    'bash: eval: maximum nesting level exceeded (32)\n',
  )
  expect(cs.levels).toBe(NESTING_MAX)
})

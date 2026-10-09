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

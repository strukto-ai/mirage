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
import { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { Session, type SessionInit } from '../session/session.ts'
import { expandBraces, lookupVar, type TSNodeLike } from './variable.ts'

function makeSession(init: Partial<Omit<SessionInit, 'sessionId'>> = {}): Session {
  return new Session({ sessionId: 'test', ...init })
}

function stringNode(type: string, text: string): TSNodeLike {
  return { type, text, children: [], namedChildren: [] }
}

describe('lookupVar', () => {
  it('reads from session env', () => {
    const s = makeSession({ env: { FOO: 'bar' } })
    expect(lookupVar('FOO', s, null)).toBe('bar')
  })

  it('returns empty string for missing var', () => {
    const s = makeSession()
    expect(lookupVar('MISSING', s, null)).toBe('')
  })

  it('$? returns last_exit_code', () => {
    const s = makeSession({ lastExitCode: 42 })
    expect(lookupVar('?', s, null)).toBe('42')
  })

  it('$# returns positional count', () => {
    const s = makeSession({ positionalArgs: ['a', 'b', 'c'] })
    expect(lookupVar('#', s, null)).toBe('3')
  })

  it('$@ / $* join positional with spaces', () => {
    const s = makeSession({ positionalArgs: ['a', 'b'] })
    expect(lookupVar('@', s, null)).toBe('a b')
    expect(lookupVar('*', s, null)).toBe('a b')
  })

  it('$0 is "mirage"', () => {
    const s = makeSession()
    expect(lookupVar('0', s, null)).toBe('mirage')
  })

  it('$1..$N reads positional by index', () => {
    const s = makeSession({ positionalArgs: ['x', 'y', 'z'] })
    expect(lookupVar('1', s, null)).toBe('x')
    expect(lookupVar('3', s, null)).toBe('z')
    expect(lookupVar('4', s, null)).toBe('')
  })

  it('call stack local overrides env', () => {
    const s = makeSession({ env: { X: 'from-env' } })
    const cs = new CallStack()
    cs.setLocal('X', 'from-local')
    expect(lookupVar('X', s, cs)).toBe('from-local')
  })
})

const textExpandChild = (c: TSNodeLike): Promise<string> => Promise.resolve(c.text)

describe('expandBraces', () => {
  it('${VAR} reads from env', async () => {
    const varName = stringNode(NT.VARIABLE_NAME, 'FOO')
    const node: TSNodeLike = {
      type: NT.EXPANSION,
      text: '${FOO}',
      children: [stringNode('${', '${'), varName, stringNode('}', '}')],
      namedChildren: [varName],
    }
    const s = makeSession({ env: { FOO: 'bar' } })
    expect(await expandBraces(node, s, null, textExpandChild)).toBe('bar')
  })

  it('${VAR:-default} falls back when missing', async () => {
    const varName = stringNode(NT.VARIABLE_NAME, 'FOO')
    const op = stringNode(':-', ':-')
    const word = stringNode(NT.WORD, 'default')
    const node: TSNodeLike = {
      type: NT.EXPANSION,
      text: '${FOO:-default}',
      children: [stringNode('${', '${'), varName, op, word, stringNode('}', '}')],
      namedChildren: [varName, word],
    }
    const s = makeSession()
    expect(await expandBraces(node, s, null, textExpandChild)).toBe('default')
  })

  it('${VAR:-default} uses actual value when present', async () => {
    const varName = stringNode(NT.VARIABLE_NAME, 'FOO')
    const op = stringNode(':-', ':-')
    const word = stringNode(NT.WORD, 'default')
    const node: TSNodeLike = {
      type: NT.EXPANSION,
      text: '${FOO:-default}',
      children: [stringNode('${', '${'), varName, op, word, stringNode('}', '}')],
      namedChildren: [varName, word],
    }
    const s = makeSession({ env: { FOO: 'real' } })
    expect(await expandBraces(node, s, null, textExpandChild)).toBe('real')
  })
})

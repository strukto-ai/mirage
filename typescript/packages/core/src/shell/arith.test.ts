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
import { evaluateArith } from './arith.ts'
import { ArithError, ReadonlyError, UnboundVariable } from './errors.ts'
import type { ElementOps } from './types.ts'

describe('evaluateArith', () => {
  it('follows precedence', () => {
    expect(evaluateArith('1 + 2 * 3', {}).value).toBe(7n)
    expect(evaluateArith('(1 + 2) * 3', {}).value).toBe(9n)
    expect(evaluateArith('2 ** 3 ** 2', {}).value).toBe(512n)
  })

  it('truncates division and modulo toward zero like C', () => {
    expect(evaluateArith('-7 / 2', {}).value).toBe(-3n)
    expect(evaluateArith('7 / -2', {}).value).toBe(-3n)
    expect(evaluateArith('-7 % 2', {}).value).toBe(-1n)
    expect(evaluateArith('7 % -2', {}).value).toBe(1n)
  })

  it('parses hex and octal literals', () => {
    expect(evaluateArith('0x10', {}).value).toBe(16n)
    expect(evaluateArith('010', {}).value).toBe(8n)
    expect(() => evaluateArith('08', {})).toThrow('value too great for base')
  })

  it('records assignments as writes', () => {
    expect(evaluateArith('y = 3, y + 2', {})).toEqual({
      value: 5n,
      writes: [{ name: 'y', key: null, value: '3' }],
    })
    expect(evaluateArith('v += 9', { v: '1' })).toEqual({
      value: 10n,
      writes: [{ name: 'v', key: null, value: '10' }],
    })
  })

  it('handles increments and decrements', () => {
    expect(evaluateArith('i++', {})).toEqual({
      value: 0n,
      writes: [{ name: 'i', key: null, value: '1' }],
    })
    expect(evaluateArith('++i', { i: '1' })).toEqual({
      value: 2n,
      writes: [{ name: 'i', key: null, value: '2' }],
    })
    expect(evaluateArith('i--', { i: '5' })).toEqual({
      value: 5n,
      writes: [{ name: 'i', key: null, value: '4' }],
    })
  })

  it('short-circuits side effects', () => {
    expect(evaluateArith('0 && (q = 7)', {})).toEqual({ value: 0n, writes: [] })
    expect(evaluateArith('1 || (q = 7)', {})).toEqual({ value: 1n, writes: [] })
  })

  it('evaluates only the taken ternary arm', () => {
    expect(evaluateArith('1 ? (w = 4) : (w = 9)', {})).toEqual({
      value: 4n,
      writes: [{ name: 'w', key: null, value: '4' }],
    })
    expect(evaluateArith('5 > 3 ? 10 : 20', {}).value).toBe(10n)
  })

  it('resolves variables recursively like bash', () => {
    expect(evaluateArith('x + 1', {}).value).toBe(1n)
    expect(evaluateArith('s * 2', { s: '1+2' }).value).toBe(6n)
    expect(evaluateArith('z + 1', { z: '' }).value).toBe(1n)
  })

  it('normalizes logical and comparison results to 0/1', () => {
    expect(evaluateArith('3 && 4', {}).value).toBe(1n)
    expect(evaluateArith('!5', {}).value).toBe(0n)
    expect(evaluateArith('2 == 2', {}).value).toBe(1n)
    expect(evaluateArith('2 != 2', {}).value).toBe(0n)
  })

  it('supports bitwise operators and shifts', () => {
    expect(evaluateArith('6 & 3', {}).value).toBe(2n)
    expect(evaluateArith('6 | 3', {}).value).toBe(7n)
    expect(evaluateArith('6 ^ 3', {}).value).toBe(5n)
    expect(evaluateArith('~0', {}).value).toBe(-1n)
    expect(evaluateArith('1 << 4', {}).value).toBe(16n)
    expect(evaluateArith('-16 >> 2', {}).value).toBe(-4n)
  })

  it('wraps at 64 bits', () => {
    expect(evaluateArith('(1 << 63) - 1 + 1', {}).value).toBe(-(1n << 63n))
  })

  it('parses base#value literals', () => {
    expect(evaluateArith('16#ff', {}).value).toBe(255n)
    expect(evaluateArith('2#101', {}).value).toBe(5n)
    expect(evaluateArith('8#17', {}).value).toBe(15n)
    expect(evaluateArith('36#z', {}).value).toBe(35n)
    expect(evaluateArith('64#_', {}).value).toBe(63n)
    expect(evaluateArith('16#a + 2#10', {}).value).toBe(12n)
  })

  it('raises ArithError on bad base literals', () => {
    expect(() => evaluateArith('2#9', {})).toThrow(ArithError)
    expect(() => evaluateArith('65#1', {})).toThrow(ArithError)
  })

  it('treats an empty expression as zero', () => {
    expect(evaluateArith('', {})).toEqual({ value: 0n, writes: [] })
  })
})

function fakeElements(): ElementOps {
  const store = new Map([
    ['m a', '7'],
    ['m 0', '4'],
    ['arr 0', '10'],
    ['arr 1', '20'],
  ])
  const ops: ElementOps = {
    isAssoc(name: string) {
      return name === 'm'
    },
    resolve(name, subscript, env) {
      if (name === 'm') return subscript.replace(/^["']|["']$/g, '')
      return evaluateArith(subscript, env, 0, ops).value.toString()
    },
    read(name, key) {
      return store.get(`${name} ${key}`) ?? null
    },
  }
  return ops
}

describe('evaluateArith elements', () => {
  it('reads and writes element lvalues', () => {
    const ops = fakeElements()
    expect(evaluateArith('m[a] + arr[0+1]', {}, 0, ops).value).toBe(27n)
    const result = evaluateArith('m[k] = 5, m[k] + 1', {}, 0, ops)
    expect(result.value).toBe(6n)
    expect(result.writes).toEqual([{ name: 'm', key: 'k', value: '5' }])
  })

  it('keeps evaluation order across bare and subscripted targets', () => {
    // A bare name aliases element 0, so `a[0]=1, a=2` must land a=2
    // last and `a=2, a[0]=1` must land a[0]=1 last; a target written
    // twice is recorded each time, so a refusal partway keeps the writes
    // before it.
    const ops = fakeElements()
    const writes = (expr: string) =>
      evaluateArith(expr, {}, 0, ops).writes.map((w) => [w.name, w.key, w.value])
    expect(writes('arr[0] = 1, arr = 2')).toEqual([
      ['arr', '0', '1'],
      ['arr', null, '2'],
    ])
    expect(writes('arr = 2, arr[0] = 1')).toEqual([
      ['arr', null, '2'],
      ['arr', '0', '1'],
    ])
    expect(writes('arr = 1, arr[0] = 2, arr = 3')).toEqual([
      ['arr', null, '1'],
      ['arr', '0', '2'],
      ['arr', null, '3'],
    ])
  })

  it('reads a bare array name as element 0', () => {
    const ops = fakeElements()
    expect(evaluateArith('arr + 1', {}, 0, ops).value).toBe(11n)
    expect(evaluateArith('m + 1', {}, 0, ops).value).toBe(5n)
  })

  it('increments elements and strips quoted keys', () => {
    const ops = fakeElements()
    const result = evaluateArith('m[a]++', {}, 0, ops)
    expect(result.value).toBe(7n)
    expect(result.writes[0]?.value).toBe('8')
    expect(evaluateArith('m["a"] - 1', {}, 0, ops).value).toBe(6n)
  })

  it('stops at a frozen name after the writes before it', () => {
    // bash: `(( X=5, R=3, X=6 ))` with R readonly binds X=5 and stops; a
    // refusal inside a subscript is marked, since it ends the shell.
    const frozen = (name: string) => (name === 'R' ? name : null)
    const refused = (expr: string): ReadonlyError => {
      try {
        evaluateArith(expr, {}, 0, fakeElements(), null, null, false, frozen)
      } catch (err) {
        if (err instanceof ReadonlyError) return err
        throw err
      }
      throw new Error(`${expr} was not refused`)
    }
    const plain = refused('X=5, R=3, X=6')
    expect([plain.varName, plain.inSubscript, plain.writes]).toEqual([
      'R',
      false,
      [{ name: 'X', key: null, value: '5' }],
    ])
    const element = refused('x=1, arr[R=3]')
    expect([element.inSubscript, element.writes]).toEqual([
      true,
      [{ name: 'x', key: null, value: '1' }],
    ])
  })

  it('refuses subscripts with no element callbacks', () => {
    expect(() => evaluateArith('a[0]', {})).toThrow(ArithError)
  })

  it('tokenizes nested brackets', () => {
    const ops = fakeElements()
    expect(evaluateArith('arr[arr[1] - 19]', {}, 0, ops).value).toBe(20n)
  })
})

describe('dynamic reads', () => {
  it('asks the reader first and tells it of every write', () => {
    // A dynamic name's reader answers before the pending assignments
    // and the environment, and hears each scalar assignment as it is
    // made, nested evaluations included, so it can act on it at once.
    const events: [string, string][] = []
    const result = evaluateArith(
      'D=42, x=D, y',
      { y: 'D+1' },
      0,
      null,
      (name) => (name === 'D' ? '7' : null),
      (name, value) => {
        events.push([name, value])
      },
    )
    expect(result.value).toBe(8n)
    expect(events).toEqual([
      ['D', '42'],
      ['x', '7'],
    ])
    expect(result.writes.map((w) => [w.name, w.value])).toEqual([
      ['D', '42'],
      ['x', '7'],
    ])
  })
})

describe('compound assignment', () => {
  it('reads the target before the right side', () => {
    // bash 5.2: `RANDOM=42, RANDOM-=RANDOM` is the first draw minus the
    // second, so a dynamic name is read for the target first.
    const draws = ['17772', '26794']
    const result = evaluateArith('D-=D', {}, 0, null, () => draws.shift() ?? null)
    expect(result.value).toBe(-9022n)
  })
})

describe('a variable evaluated as an expression', () => {
  it('shares the record of the expression around it', () => {
    // bash: `x='y=5'; $((x))` leaves y at 5, and the nested read sees
    // the pending updates of the expression around it.
    const first = evaluateArith('x, y + 1', { x: 'y=5' })
    expect(first.value).toBe(6n)
    expect(first.writes.map((w) => [w.name, w.value])).toEqual([['y', '5']])
    const second = evaluateArith('y=1, x, y', { x: 'y+=1' })
    expect(second.value).toBe(2n)
    expect(second.writes.map((w) => [w.name, w.value])).toEqual([
      ['y', '1'],
      ['y', '2'],
    ])
  })
})

describe('an indexed subscript', () => {
  it('evaluates in the record of the expression around it', () => {
    // bash: `a[5]=7; $((a[x=5] + x))` is 12 and leaves x at 5; the
    // subscript's assignment is seen by the rest of the expression and
    // recorded with it.
    const result = evaluateArith('arr[x=1] + x', {}, 0, fakeElements())
    expect(result.value).toBe(21n)
    expect(result.writes.map((w) => [w.name, w.key, w.value])).toEqual([['x', null, '1']])
    // An associative subscript stays a key, never an expression.
    const assoc = evaluateArith('m[a] + 1', {}, 0, fakeElements())
    expect(assoc.value).toBe(8n)
    expect(assoc.writes).toEqual([])
  })
})

// `set -u` for the names an expression reads, pinned on bash 5.2.37: an
// unset name is fatal, an empty one is 0, an assignment target and a
// short-circuited operand are never read, and an array name is set
// whatever its element 0 holds.
describe('nounset', () => {
  const unbound = (expr: string, env: Record<string, string> = {}): string => {
    try {
      evaluateArith(expr, env, 0, null, null, null, true)
    } catch (err) {
      if (!(err instanceof UnboundVariable)) throw err
      expect([err.exitCode, err.containedCode]).toEqual([127, 1])
      return new TextDecoder().decode(err.stderr)
    }
    throw new Error(`${expr} did not refuse`)
  }

  it('refuses a name no variable holds', () => {
    expect(unbound('v + 1')).toBe('bash: v: unbound variable\n')
    expect(unbound('v++')).toBe('bash: v: unbound variable\n')
    expect(unbound('v += 1')).toBe('bash: v: unbound variable\n')
    expect(unbound('w', { w: 'v' })).toBe('bash: v: unbound variable\n')
  })

  it('reads what is set and skips what is never read', () => {
    const run = (expr: string, env: Record<string, string> = {}, ops: ElementOps | null = null) =>
      evaluateArith(expr, env, 0, ops, null, null, true).value
    expect(run('v', { v: '' })).toBe(0n)
    expect(run('v = 1, v + 1')).toBe(2n)
    expect(run('1 || v')).toBe(1n)
    expect(run('0 && v')).toBe(0n)
    expect(run('1 ? 2 : v')).toBe(2n)
    const ops: ElementOps = { ...fakeElements(), holdsArray: (name) => name === 'holes' }
    expect(run('holes + 1', {}, ops)).toBe(1n)
  })

  it('reads an unset name as 0 without it', () => {
    expect(evaluateArith('v + 1', {}).value).toBe(1n)
  })
})

/** The line an evaluation's error reads, or null when it evaluates. */
function errorLine(expr: string, env: Record<string, string> = {}): string | null {
  try {
    evaluateArith(expr, env)
  } catch (err) {
    if (err instanceof ArithError) return err.message
    throw err
  }
  return null
}

describe('an error is worded as bash names it', () => {
  // Pinned against bash 5.2.37 (`let "$e"` and `$(( e ))`).
  it.each([
    ['1+', 'syntax error: operand expected (error token is "+")'],
    ['1 2 3', 'syntax error in expression (error token is "2 3")'],
    ['(1+2', 'missing `)\' (error token is "2")'],
    ['1)', 'syntax error in expression (error token is ")")'],
    ['1/0 + 2', 'division by 0 (error token is "0 + 2")'],
    ['-(1/0)', 'division by 0 (error token is "0)")'],
    ['2**-1 + 3', 'exponent less than 0 (error token is "+ 3")'],
    ['3=4', 'attempted assignment to non-variable (error token is "=4")'],
    ['0 && x=08', 'attempted assignment to non-variable (error token is "=08")'],
    ['1?2', '`:\' expected for conditional expression (error token is "2")'],
    ['1 ? : 3', 'expression expected (error token is ": 3")'],
    ['1.5', 'syntax error: invalid arithmetic operator (error token is ".5")'],
    ["'a'", 'syntax error: operand expected (error token is "\'a\'")'],
    ['x[1', 'bad array subscript (error token is "x[1")'],
    ['--x--', '--: assignment requires lvalue (error token is "--")'],
    ['5++', 'syntax error: operand expected (error token is "+")'],
    ['1+ ', 'syntax error: operand expected (error token is "+ ")'],
  ])('%j', (expr, line) => {
    expect(errorLine(expr)).toBe(`${expr.trimStart()}: ${line}`)
  })
})

describe('an error names the expression it happened in', () => {
  // A bad constant names the expression up to its end, an error in a
  // variable's value names that value, and a reference cycle the name at
  // the depth limit, as bash's does.
  it.each([
    ['x=08 + 1', {}, 'x=08: value too great for base (error token is "08")'],
    ['09+1', {}, '09: value too great for base (error token is "09")'],
    ['1#1', {}, '1#1: invalid arithmetic base (error token is "1#1")'],
    ['10#', {}, '10#: invalid integer constant (error token is "10#")'],
    ['2 * x', { x: ' 1+ ' }, '1+ : syntax error: operand expected (error token is "+ ")'],
    ['x', { x: 'y', y: 'x' }, 'y: expression recursion level exceeded (error token is "y")'],
  ])('%j', (expr, env, line) => {
    expect(errorLine(expr, env)).toBe(line)
  })
})

describe('a value is what bash reads', () => {
  // `++` and `--` bind to a name next to them, else read as signs.
  it.each([
    ['1++2', 3n],
    ['1--1', 2n],
    ['++5', 5n],
    ['---1', -1n],
    ['x+++y', 6n],
    ['x---1', 4n],
    ['++ x', 6n],
    ['0x', 0n],
    ['99999999999999999999', 7766279631452241919n],
    ['3 ** 41', -420491770248316829n],
    ['-2 ** 2', 4n],
    ['1 ? 2, 3 : 4', 3n],
    ['0 ? 1/0 : 2', 2n],
    ['0 && 1/0', 0n],
  ])('%j', (expr, value) => {
    expect(evaluateArith(expr, { x: '5', y: '1' }).value).toBe(value)
  })

  it('keeps the writes made before an error', () => {
    let caught: unknown = null
    try {
      evaluateArith('x=7, y++ +', { y: '1' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ArithError)
    expect((caught as ArithError).writes).toEqual([
      { name: 'x', key: null, value: '7' },
      { name: 'y', key: null, value: '2' },
    ])
  })

  it('reads no name it assigns', () => {
    expect(evaluateArith('x=5', { x: '1+' }).value).toBe(5n)
  })

  it('marks an error in a subscript', () => {
    const elements: ElementOps = {
      resolve: (_name, sub) => sub,
      read: () => '1',
      isAssoc: () => false,
    }
    let caught: unknown = null
    try {
      evaluateArith('a[1+] + 1', {}, 0, elements)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ArithError)
    const error = caught as ArithError
    expect(error.message).toBe('1+: syntax error: operand expected (error token is "+")')
    expect(error.inSubscript).toBe(true)
    const signal = error.signal('let')
    expect([signal.exitCode, signal.containedCode]).toEqual([1, 1])
    expect(new TextDecoder().decode(signal.stderr)).toBe(
      'bash: 1+: syntax error: operand expected (error token is "+")\n',
    )
  })
})

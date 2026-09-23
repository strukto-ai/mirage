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
import { AwkSyntaxError } from './errors.ts'
import { RuleKind, type Stmt } from './nodes.ts'
import { parse } from './parser.ts'

function firstStmt(src: string): Stmt {
  const stmt = parse(src).rules[0]?.action?.body[0]
  if (stmt === undefined) throw new Error('no statement')
  return stmt
}

describe('awk parser', () => {
  it('classifies rules', () => {
    const rules = parse('BEGIN{}\n/a/\nNR==1,NR==2{print}\n{print}\nEND{}').rules
    expect(rules.map((r) => r.kind)).toEqual([
      RuleKind.BEGIN,
      RuleKind.PATTERN,
      RuleKind.RANGE,
      RuleKind.ALWAYS,
      RuleKind.END,
    ])
    expect(rules[1]?.action).toBeNull()
  })

  it('keeps the semicolons of a for header', () => {
    const stmt = firstStmt('{for(i=1;i<NF;i++)x=x"  "}')
    expect(stmt.type).toBe('For')
    if (stmt.type === 'For') expect(stmt.cond?.type).toBe('Compare')
  })

  it('parses for-in and a while with an empty body', () => {
    expect(firstStmt('{for(k in a)print k}').type).toBe('ForIn')
    const loop = firstStmt('{while(i++<3);print i}')
    expect(loop).toMatchObject({ type: 'While', body: { type: 'Block', body: [] } })
  })

  it('binds concatenation looser than arithmetic', () => {
    expect(firstStmt('{x = 1 " " 2+3}')).toMatchObject({
      expr: { type: 'Assign', value: { type: 'Concat', right: { type: 'Binary' } } },
    })
  })

  it('binds unary minus looser than power', () => {
    expect(firstStmt('{x = -2^2}')).toMatchObject({
      expr: { value: { type: 'Unary', operand: { type: 'Binary' } } },
    })
  })

  it('reads a print redirect, not a comparison', () => {
    const stmt = firstStmt('{print a, b > "/dev/stderr"}')
    expect(stmt).toMatchObject({ type: 'Print', redirect: { kind: '>' } })
    if (stmt.type === 'Print') expect(stmt.args).toHaveLength(2)
    expect(firstStmt('{print (a > b)}')).toMatchObject({ args: [{ type: 'Compare' }] })
  })

  it('collects functions', () => {
    const program = parse('function f(a, b) { return a+b } {print f(1,2)}')
    expect(program.functions.get('f')?.params).toEqual(['a', 'b'])
  })

  it.each(['{print $(}', '{if x print}', '{break}', '{return 1}', '{print', '/[/', '{x = }'])(
    'refuses %j',
    (src) => {
      expect(() => parse(src)).toThrow(AwkSyntaxError)
    },
  )
})

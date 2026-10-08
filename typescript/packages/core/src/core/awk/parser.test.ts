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
import { GetlineKind, RedirKind, RuleKind, type Stmt } from './nodes.ts'
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

  it('reads a getline file as a primary', () => {
    const stmt = firstStmt('{x = getline line < "a" "b"}')
    expect(stmt).toMatchObject({
      expr: {
        value: {
          type: 'Concat',
          left: { type: 'Getline', kind: GetlineKind.FILE, source: { type: 'Str', value: 'a' } },
        },
      },
    })
  })

  it('compares an unparenthesised getline file result', () => {
    expect(firstStmt('{while (getline line < f > 0) n++}')).toMatchObject({
      cond: { type: 'Compare', left: { type: 'Getline', target: { type: 'Var', name: 'line' } } },
    })
  })

  it('reads the command of an input pipe as a primary', () => {
    expect(firstStmt('{x = "echo " "hi" | getline}')).toMatchObject({
      expr: {
        value: {
          type: 'Concat',
          left: { type: 'Str', value: 'echo ' },
          right: { type: 'Getline', kind: GetlineKind.CMD, source: { type: 'Str', value: 'hi' } },
        },
      },
    })
    expect(firstStmt('{x = 1 + "cmd" | getline}')).toMatchObject({
      expr: { value: { type: 'Binary', right: { type: 'Getline' } } },
    })
  })

  it('lets operators follow an input pipe result', () => {
    expect(firstStmt('{x = "cmd" | getline line > 0}')).toMatchObject({
      expr: {
        value: {
          type: 'Compare',
          left: {
            type: 'Getline',
            kind: GetlineKind.CMD,
            target: { type: 'Var', name: 'line' },
            source: { type: 'Str', value: 'cmd' },
          },
        },
      },
    })
  })

  it('keeps a print pipe an output pipe', () => {
    expect(firstStmt('{print "x" | "cat"}')).toMatchObject({
      type: 'Print',
      redirect: { kind: RedirKind.PIPE },
    })
  })

  it.each(['{print $(}', '{if x print}', '{break}', '{return 1}', '{print', '/[/', '{x = }'])(
    'refuses %j',
    (src) => {
      expect(() => parse(src)).toThrow(AwkSyntaxError)
    },
  )

  it.each([
    ['BEGIN{match("a",\n/a/,\nm)}', "awk: syntax error at ',': expected ')'"],
    ['BEGIN{match("a")}', "awk: syntax error at ')': expected ','"],
    ['BEGIN{match()}', "awk: syntax error at ')': expected an expression"],
    ['BEGIN{sub(/a/)}', "awk: syntax error at ')': expected ','"],
    ['BEGIN{gsub(/a/, "b", x, y)}', "awk: syntax error at ',': expected ')'"],
    ['BEGIN{print length("a", "b")}', "awk: syntax error at ',': expected ')'"],
    ['BEGIN{print substr}', "awk: syntax error at '}': expected '('"],
    ['BEGIN{print substr("abc")}', 'awk: not enough arguments in call to substr: 1 (need 2)'],
    ['BEGIN{print rand(1)}', 'awk: too many arguments in call to rand: 1 (maximum 0)'],
    ['BEGIN{print sprintf()}', 'awk: not enough arguments in call to sprintf: 0 (need 1)'],
    ['BEGIN{print atan2(1, 2, 3)}', 'awk: too many arguments in call to atan2: 3 (maximum 2)'],
  ])('counts the arguments of %j', (src, message) => {
    expect(() => parse(src)).toThrow(new AwkSyntaxError(message))
  })

  it.each([
    ['BEGIN{print length}', 0],
    ['BEGIN{print length()}', 0],
    ['BEGIN{print split("a b", x, " ")}', 3],
    ['BEGIN{print sprintf("%s %s %s", 1, 2, 3)}', 4],
    ['BEGIN{print srand()}', 0],
    ['BEGIN{print fflush()}', 0],
  ] as const)('accepts the arguments of %j', (src, count) => {
    expect(firstStmt(src)).toMatchObject({
      args: [{ type: 'BuiltinCall', args: { length: count } }],
    })
  })
})

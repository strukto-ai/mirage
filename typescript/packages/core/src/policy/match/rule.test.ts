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

import { line, trees } from '../../test-utils.ts'
import { type AdmissionRules, type CommandContext, type CommandRule, Outcome } from '../types.ts'
import { decide } from './decide.ts'
import { ioReach, ioRefusal, namingRules, skippedAtDispatch } from './rule.ts'

// Mirrors python/tests/policy/match/test_rule.py.

function verdict(rules: AdmissionRules, ctx: CommandContext): [Outcome, string | null] {
  const ruling = decide(ctx, rules)
  return [ruling.outcome, ruling.matchedPath]
}

function refusal(
  rules: AdmissionRules | null,
  ctx: CommandContext,
  virtual: string,
  granted: readonly CommandRule[] = [],
): string | null {
  return ioRefusal(rules, namingRules(rules, ctx), virtual, granted)
}

function reach(rules: AdmissionRules | null, ctx: CommandContext, virtual: string): boolean {
  return ioReach(rules, namingRules(rules, ctx), virtual)
}

describe('command trees over paths', () => {
  it('a mount tree reaches a line by its cwd or its paths', () => {
    const rules = trees(null, { '/repo': { rm: { '--force': 'deny' } } })
    expect(verdict(rules, line(['rm', '-f', 'x'], { cwd: '/repo/sub' }))[0]).toBe(Outcome.DENY)
    expect(verdict(rules, line(['rm', '-f', '/repo/x'], { cwd: '/s' }))[0]).toBe(Outcome.DENY)
    expect(verdict(rules, line(['rm', '-f', 'x'], { cwd: '/s' }))[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['rm', '-f', 'x'], { cwd: '/repository' }))[0]).toBe(Outcome.ALLOW)
  })

  it('a walking command touches the mounts under its operands', () => {
    const rules = trees(null, { '/scratch/child': { grep: 'deny' } })
    expect(verdict(rules, line(['grep', '-r', 'x', '/scratch']))[0]).toBe(Outcome.DENY)
    expect(verdict(rules, line(['grep', 'x', '/scratch']))[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['grep', '-r', 'x', '/scratch/f']))[0]).toBe(Outcome.ALLOW)
  })

  it("a leaf's paths read the one path grammar", () => {
    const prod = trees({ rm: { decision: 'deny', paths: ['/data/prod'] } })
    for (const virtual of ['/data/prod', '/data/prod/x'])
      expect(verdict(prod, line(['rm', virtual]))).toEqual([Outcome.DENY, virtual])
    expect(verdict(prod, line(['rm', '/data/production']))[0]).toBe(Outcome.ALLOW)
    const keys = trees({ '*': { decision: 'deny', paths: ['*.key'] } })
    expect(verdict(keys, line(['cat', '/a/b.key/c']))[0]).toBe(Outcome.DENY)
    expect(verdict(keys, line(['cat', '/a/b.keyx']))[0]).toBe(Outcome.ALLOW)
    const one = trees({ '*': { decision: 'deny', paths: ['/d/?.txt', '/d/[ab].c'] } })
    expect(verdict(one, line(['cat', '/d/a.txt']))[0]).toBe(Outcome.DENY)
    expect(verdict(one, line(['cat', '/d/ab.txt']))[0]).toBe(Outcome.ALLOW)
    expect(verdict(one, line(['cat', '/d/b.c']))[0]).toBe(Outcome.DENY)
    expect(verdict(one, line(['cat', '/d/c.c']))[0]).toBe(Outcome.ALLOW)
  })

  it('a subtree command on the directory holding the scope matches', () => {
    const rules = trees({ '*': { decision: 'deny', paths: ['/x/locked/*'] } })
    for (const words of [['rm', '-r'], ['rmdir']]) {
      for (const operand of ['/x/locked', '/x'])
        expect(verdict(rules, line([...words, operand]))).toEqual([Outcome.DENY, operand])
      expect(verdict(rules, line([...words, '/x/other']))[0]).toBe(Outcome.ALLOW)
    }
    expect(verdict(rules, line(['mv', '/x', '/y']))).toEqual([Outcome.DENY, '/x'])
    expect(verdict(rules, line(['mv', '/z', '/x/locked']))).toEqual([Outcome.DENY, '/x/locked'])
    expect(verdict(rules, line(['mv', '/z', '/x']))[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['cat', '/x/locked']))[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['cp', '-r', '/x', '/y']))[0]).toBe(Outcome.ALLOW)
  })

  it('ioRefusal judges a reached file as one more path', () => {
    const rules = trees({
      rm: [
        { decision: 'deny', reason: 'keys', paths: ['*.key'] },
        { decision: 'ask', reason: 'nod', paths: ['/d/*'] },
      ],
    })
    const ctx = line(['rm', '-r', '/d'])
    const nod = decide(ctx, rules).asks
    expect(nod.map((a) => a.reason)).toEqual(['nod'])
    expect(refusal(rules, ctx, '/d/x.key', nod)).toBe('keys')
    expect(refusal(rules, ctx, '/d/a')).toBe('nod')
    expect(refusal(rules, ctx, '/d/a', nod)).toBeNull()
    expect(refusal(rules, ctx, '/open/a')).toBeNull()
    const whole = trees({ rm: { '--recursive': 'deny' } })
    expect(refusal(whole, line(['rm', '/x']), '/x/y')).toBeNull()
    expect(refusal(null, ctx, '/d/a')).toBeNull()
  })

  it('ioReach reads each start point on its own', () => {
    const rules = trees({
      '*': { decision: 'deny', paths: ['/repo/.env'] },
      rm: { decision: 'ask', paths: ['/data/*'] },
    })
    const find = line(['find', '/repo', '/s3', '/data'])
    expect(reach(rules, find, '/repo')).toBe(true)
    expect(reach(rules, find, '/repo/.env')).toBe(true)
    expect(reach(rules, find, '/s3')).toBe(false)
    expect(reach(rules, find, '/data')).toBe(false)
    expect(reach(rules, line(['rm', '-r', '/data']), '/data')).toBe(true)
    const whole = trees({ rm: 'deny' })
    expect(reach(whole, line(['rm', '-r', '/data']), '/data')).toBe(false)
    expect(reach(null, find, '/repo')).toBe(false)
  })

  it('skippedAtDispatch names every tree', () => {
    const rules = trees({ rm: 'deny' }, { '/a': { cp: 'deny' } })
    expect(skippedAtDispatch(rules)).toEqual(['commands', 'mounts./a.commands'])
    expect(skippedAtDispatch(null)).toEqual([])
  })
})

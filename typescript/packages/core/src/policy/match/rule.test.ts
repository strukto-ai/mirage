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

function reach(
  rules: AdmissionRules | null,
  ctx: CommandContext,
  virtual: string,
  granted: readonly CommandRule[] = [],
): boolean {
  return ioReach(rules, namingRules(rules, ctx), virtual, granted)
}

function atOrUnder(virtual: string, root: string): boolean {
  return virtual === root || root === '/' || virtual.startsWith(`${root.replace(/\/+$/, '')}/`)
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
    const walk = line(['grep', '-r', 'x', '/scratch'])
    expect(verdict(rules, { ...walk, walksInto: ['/scratch/child'] })[0]).toBe(Outcome.DENY)
    expect(verdict(rules, walk)[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['grep', 'x', '/scratch']))[0]).toBe(Outcome.ALLOW)
    expect(verdict(rules, line(['grep', '-r', 'x', '/scratch/f']))[0]).toBe(Outcome.ALLOW)
  })

  it('ioRefusal judges a reached file as one more path', () => {
    const rules = trees(null, {
      '/d': { grep: { decision: 'ask', reason: 'nod' } },
      '/d/keys': { grep: { decision: 'deny', reason: 'keys' } },
    })
    const ctx = line(['grep', '-r', 'x', '/d'])
    const nod = decide(ctx, rules).asks
    expect(nod.map((a) => a.reason)).toEqual(['nod'])
    expect(refusal(rules, ctx, '/d/keys/x.key', nod)).toBe('keys')
    expect(refusal(rules, ctx, '/d/a')).toBe('nod')
    expect(refusal(rules, ctx, '/d/a', nod)).toBeNull()
    expect(refusal(rules, ctx, '/open/a')).toBeNull()
    const whole = trees({ rm: { '--recursive': 'deny' } })
    expect(refusal(whole, line(['rm', '/x']), '/x/y')).toBeNull()
    expect(refusal(null, ctx, '/d/a')).toBeNull()
  })

  it('ioReach reads each start point on its own', () => {
    const rules = trees(null, { '/repo/.env': { '*': 'deny' }, '/data': { rm: 'ask' } })
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

  it("a mount tree's leaf with no paths reaches its mount", () => {
    const rules = trees(
      { grep: 'ask' },
      {
        '/repo/private': { git: { decision: 'deny', reason: 'private' } },
        '/repo/open': { git: 'allow' },
      },
    )
    const git = line(['git', 'cat-file', '-p', 'x'], { cwd: '/repo' })
    expect(reach(rules, git, '/repo')).toBe(true)
    expect(reach(rules, git, '/repo/private/s.txt')).toBe(true)
    expect(reach(rules, git, '/repo/open')).toBe(false)
    expect(reach(rules, git, '/other')).toBe(false)
    expect(refusal(rules, git, '/repo/private/s.txt')).toBe('private')
    expect(refusal(rules, git, '/repo/pub.txt')).toBeNull()
    expect(reach(rules, line(['grep', '-r', 'x', '/repo']), '/repo')).toBe(false)
  })

  it('ioReach skips an ask the line holds a grant for', () => {
    const rules = trees(null, { '/data': { rm: 'ask' } })
    const rm = line(['rm', '-rf', '/data'])
    const nod = decide(rm, rules).asks
    expect(reach(rules, rm, '/data')).toBe(true)
    expect(reach(rules, rm, '/data', nod)).toBe(false)
    expect(reach(rules, rm, '/data/sub', nod)).toBe(false)
    const kept = trees(null, { '/data': { grep: 'ask' }, '/data/k': { grep: 'deny' } })
    const grep = line(['grep', '-r', 'x', '/data'])
    const held = decide(grep, kept).asks
    expect(held.length).toBeGreaterThan(0)
    expect(reach(kept, grep, '/data', held)).toBe(true)
    expect(reach(kept, grep, '/data/k', held)).toBe(true)
  })

  it('ioReach covers every entry ioRefusal refuses below it', () => {
    const universe = [
      '/',
      '/dir',
      '/dir/a',
      '/dir/a/x.pem',
      '/dir/secret',
      '/dir/secret/k.pem',
      '/dir/secret/deep/k.txt',
      '/dir2',
      '/dir2/y.pem',
      '/other/z.txt',
    ]
    const table: [
      Record<string, unknown> | null,
      Record<string, Record<string, unknown>>,
      string,
    ][] = [
      [null, { '/dir': { grep: 'ask' } }, '/dir'],
      [null, { '/dir': { grep: 'ask' }, '/dir/secret': { grep: 'deny' } }, '/dir/a'],
      [null, { '/dir': { grep: 'ask' }, '/dir/a/x.pem': { grep: 'deny' } }, '/dir'],
      [{ grep: 'ask' }, { '/dir/secret': { grep: 'deny' } }, '/dir'],
      [null, { '/dir/secret': { grep: 'ask' }, '/dir': { grep: 'ask' } }, '/'],
      [{ grep: 'allow' }, { '/dir2': { '*': 'deny' } }, '/dir'],
    ]
    let checks = 0
    for (const [commands, mounts, operand] of table) {
      const rules = trees(commands, mounts)
      const ctx = line(['grep', '-r', 'x', operand])
      const ruling = decide(ctx, rules)
      expect(ruling.outcome).not.toBe(Outcome.DENY)
      const granted = ruling.outcome === Outcome.ASK ? ruling.asks : []
      const named = namingRules(rules, ctx)
      const refused = universe.filter((p) => ioRefusal(rules, named, p, granted) !== null)
      for (const root of universe.filter((u) => atOrUnder(u, operand))) {
        checks += 1
        if (ioReach(rules, named, root, granted)) continue
        expect(refused.filter((p) => atOrUnder(p, root))).toEqual([])
      }
    }
    expect(checks).toBeGreaterThan(0)
  })

  it('skippedAtDispatch names every tree', () => {
    const rules = trees({ rm: 'deny' }, { '/a': { cp: 'deny' } })
    expect(skippedAtDispatch(rules)).toEqual(['commands', 'mounts./a.commands'])
    expect(skippedAtDispatch(null)).toEqual([])
  })
})

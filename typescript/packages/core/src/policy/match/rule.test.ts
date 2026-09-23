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

import { PathSpec } from '../../types.ts'
import { classifyPaths } from '../../utils/hidden.ts'
import type { CommandContext, CommandRule, AdmissionRules, OpsContext } from '../types.ts'
import {
  ioRefusal,
  matchIo,
  matchOp,
  opRefusal,
  matchRule,
  ruleReach,
  ruleScope,
  subjects,
  type Subject,
} from './rule.ts'

const registry = { isMountRoot: () => false }

function path(virtual: string, raw = ''): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual,
    resolved: true,
    rawPath: raw,
  })
}

function ctx(
  command: string,
  extra: Partial<Omit<CommandContext, 'command' | 'registry'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', registry, ...extra }
}

function subject(virtual: string): Subject {
  return { path: path(virtual), holds: false, ancestors: true }
}

describe('rules', () => {
  it('matchRule by command pattern, operand and mount', () => {
    const whole: CommandRule = { reason: 'no', commands: ['git push'] }
    expect(matchRule(whole, null, ctx('git', { tokens: ['git', 'push', 'origin'] }))).toEqual({
      operand: null,
      depth: 0,
    })
    expect(matchRule(whole, null, ctx('git', { tokens: ['git', 'pull'] }))).toBeNull()
    const scoped: CommandRule = { reason: 'no', commands: ['rm'], paths: ['/repo/*'] }
    const scope = classifyPaths(scoped.paths ?? [])
    // The depth is the matched entry's, which is what the path axis
    // orders by.
    expect(
      matchRule(scoped, scope, ctx('rm', { paths: [path('/repo/x', 'x')], cwd: '/repo' })),
    ).toEqual({ operand: 'x', depth: 1 })
    expect(matchRule(scoped, scope, ctx('rm', { paths: [path('/scratch/x')] }))).toBeNull()
    // A mount-tier rule applies to a line whose cwd or paths lie under
    // the mount, and to nothing else.
    const mount: CommandRule = { reason: 'ro', commands: ['git push'], mount: '/repo' }
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repo/sub' })),
    ).not.toBeNull()
    expect(
      matchRule(
        mount,
        null,
        ctx('git', { tokens: ['git', 'push'], cwd: '/scratch', paths: [path('/repo')] }),
      ),
    ).not.toBeNull()
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/scratch' })),
    ).toBeNull()
    expect(
      matchRule(mount, null, ctx('git', { tokens: ['git', 'push'], cwd: '/repository' })),
    ).toBeNull()
    // An every-command rule (no patterns) matches whatever line.
    expect(matchRule({ reason: 'locked' }, null, ctx('ls'))).not.toBeNull()
  })

  it('a walking command touches the mounts under its operands', () => {
    // `grep -r x /scratch` enters `/scratch/child`: the fan-out reruns
    // the traversal inside each descendant mount and no admission fires
    // again there, so the ancestor operand is where the mount's rule
    // speaks. A command that does not walk, or an operand that is not
    // above the root, stays untouched.
    const mount: CommandRule = { reason: 'boxed', mount: '/scratch/child' }
    expect(matchRule(mount, null, ctx('grep', { paths: [path('/scratch')], walks: true }))).toEqual(
      { operand: null, depth: 0 },
    )
    expect(matchRule(mount, null, ctx('grep', { paths: [path('/scratch')] }))).toBeNull()
    expect(
      matchRule(mount, null, ctx('grep', { paths: [path('/scratch/file.txt')], walks: true })),
    ).toBeNull()
  })

  it('opRefusal reads depth before verb and honours a grant', () => {
    const broad: CommandRule = { reason: 'repo is sealed', paths: ['/repo/*'] }
    const carve: CommandRule = { reason: 'outbox nod', paths: ['/repo/outbox/*'] }
    const rules: AdmissionRules = { allow: null, deny: [broad], ask: [carve] }
    const inside: OpsContext = {
      op: 'write',
      path: path('/repo/outbox/a'),
      write: true,
      prefix: '/repo/',
    }
    // The deeper ask wins where both reach, exactly as the command door
    // ranks them, so a broad deny cannot overrule an approved carve-out.
    expect(opRefusal(rules, inside, [])).toBe('outbox nod')
    expect(opRefusal(rules, inside, [carve])).toBeNull()
    // Outside the carve-out the deny is what is left, and a grant for
    // the ask says nothing about it.
    const outside: OpsContext = {
      op: 'write',
      path: path('/repo/sealed/a'),
      write: true,
      prefix: '/repo/',
    }
    expect(opRefusal(rules, outside, [carve])).toBe('repo is sealed')
    // A metadata op is reached by neither: deny is present and refused.
    const stat: OpsContext = {
      op: 'stat',
      path: path('/repo/outbox/a'),
      write: false,
      prefix: '/repo/',
    }
    expect(opRefusal(rules, stat, [])).toBeNull()
    // No rules at all, and a rule naming a command, are both silent.
    expect(opRefusal(null, inside, [])).toBeNull()
    const named: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'x', commands: ['rm'], paths: ['/repo/*'] }],
    }
    expect(opRefusal(named, inside, [])).toBeNull()
  })

  it('matchOp only for pure path rules', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    const op: OpsContext = {
      op: 'write',
      path: path('/data/locked/a'),
      write: true,
      prefix: '/data/',
    }
    expect(matchOp(rule, scope, op)).toBe(true)
    expect(
      matchOp(rule, scope, {
        op: 'write',
        path: path('/data/open/a'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
    const named: CommandRule = { reason: 'x', commands: ['rm'], paths: ['/data/*'] }
    expect(matchOp(named, classifyPaths(named.paths ?? []), op)).toBe(false)
    expect(matchOp({ reason: 'x', commands: ['rm'] }, null, op)).toBe(false)
  })

  function subtreeCtx(command: string, ...operands: string[]): CommandContext {
    const paths = operands.map((o) => path(o, o))
    return ctx(command, { paths, operands: paths, argv: operands, tokens: [command, ...operands] })
  }

  it('a subtree command on the directory holding the scope matches', () => {
    // `/x/locked/*` protects the children; `rm -r /x/locked`, `rm -r /x`
    // and `mv /x/locked elsewhere` take them along, so for rm, rmdir and
    // mv the operand at or above the holding directory matches.
    const rule: CommandRule = { reason: 'frozen', paths: ['/x/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    for (const command of ['rm', 'rmdir']) {
      for (const operand of ['/x/locked', '/x', '/']) {
        expect(matchRule(rule, scope, subtreeCtx(command, operand))).toEqual({ operand, depth: 2 })
      }
      expect(matchRule(rule, scope, subtreeCtx(command, '/x/other'))).toBeNull()
    }
    expect(matchRule(rule, scope, subtreeCtx('mv', '/x/locked', '/y'))).toEqual({
      operand: '/x/locked',
      depth: 2,
    })
    expect(matchRule(rule, scope, subtreeCtx('mv', '/x', '/y'))).toEqual({
      operand: '/x',
      depth: 2,
    })
    // mv's destination matches only as the holding directory itself:
    // moving into it lands in the scope, moving into an ancestor does not.
    expect(matchRule(rule, scope, subtreeCtx('mv', '/z', '/x/locked'))).toEqual({
      operand: '/x/locked',
      depth: 2,
    })
    expect(matchRule(rule, scope, subtreeCtx('mv', '/z', '/x'))).toBeNull()
    // A reader given the same operand is not a whole-line refusal: its
    // I/O under the scope is the command tier's to refuse, file by file.
    expect(matchRule(rule, scope, subtreeCtx('cat', '/x/locked'))).toBeNull()
    expect(matchRule(rule, scope, subtreeCtx('cp', '/x', '/y'))).toBeNull()
    // A command-scoped rule judges its own command the same way.
    const named: CommandRule = { reason: 'locked', commands: ['rm'], paths: ['/x/locked/*'] }
    const namedScope = classifyPaths(named.paths ?? [])
    expect(matchRule(named, namedScope, subtreeCtx('rm', '/x'))).toEqual({
      operand: '/x',
      depth: 2,
    })
    expect(matchRule(named, namedScope, subtreeCtx('mv', '/x', '/y'))).toBeNull()
  })

  it("subjects are the line's paths, then its subtree operands", () => {
    // A reader is asked one question per path: does it lie inside a
    // scope. A subtree command is asked a second, per operand: does it
    // hold one. `mv`'s destination is the operand where an ancestor of
    // the scope does not count.
    expect(subjects(subtreeCtx('cat', '/a', '/b')).map((s) => [s.path?.virtual, s.holds])).toEqual([
      ['/a', false],
      ['/b', false],
    ])
    expect(
      subjects(subtreeCtx('mv', '/a', '/b')).map((s) => [s.path?.virtual, s.holds, s.ancestors]),
    ).toEqual([
      ['/a', false, true],
      ['/b', false, true],
      ['/a', true, true],
      ['/b', true, false],
    ])
    // A line naming no path is one subject, itself.
    const bare = subjects(ctx('git', { tokens: ['git', 'push'] }))
    expect(bare.length).toBe(1)
    expect(bare[0]?.path).toBeNull()
  })

  it('ruleReach scores the entry that reached and no other', () => {
    const inside: CommandRule = { reason: 'x', paths: ['/a/*', '/deep/b/c/*'] }
    const scope = ruleScope(inside)
    expect(ruleReach(inside, scope, subject('/a/x'))).toBe(1)
    expect(ruleReach(inside, scope, subject('/deep/b/c/x'))).toBe(3)
    expect(ruleReach(inside, scope, subject('/elsewhere'))).toBeNull()
    // A rule naming no paths reaches every subject at depth 0, which is
    // off the path axis, and a line's own subject only through one.
    const pathless: CommandRule = { reason: 'x' }
    expect(ruleReach(pathless, null, subject('/a/x'))).toBe(0)
    expect(ruleReach(pathless, null, { path: null, holds: false, ancestors: true })).toBe(0)
    expect(ruleReach(inside, scope, { path: null, holds: false, ancestors: true })).toBeNull()
    // Holding the scope is the subtree operand's question alone.
    expect(ruleReach(inside, scope, subject('/'))).toBeNull()
    expect(ruleReach(inside, scope, { ...subject('/'), holds: true })).toBe(3)
  })

  it('matchOp refuses a subtree op on the directory holding the scope', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    for (const [op, virtual] of [
      ['rename', '/data/locked'],
      ['rename', '/data'],
      ['rmdir', '/data/locked'],
      ['rm_r', '/data'],
    ] as const) {
      expect(matchOp(rule, scope, { op, path: path(virtual), write: true, prefix: '/data/' })).toBe(
        true,
      )
    }
    // A read or write of the directory itself is not in the scope, and a
    // subtree op beside the scope is not either.
    expect(
      matchOp(rule, scope, {
        op: 'readdir',
        path: path('/data/locked'),
        write: false,
        prefix: '/data/',
      }),
    ).toBe(false)
    expect(
      matchOp(rule, scope, {
        op: 'rename',
        path: path('/data/other'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
  })
  it('matchOp lets a metadata op through', () => {
    // Deny is present and refused: the entry stats, the read is refused.
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const scope = classifyPaths(rule.paths ?? [])
    for (const op of ['stat', 'exists']) {
      expect(
        matchOp(rule, scope, { op, path: path('/data/locked/a'), write: false, prefix: '/data/' }),
      ).toBe(false)
    }
    expect(
      matchOp(rule, scope, {
        op: 'read',
        path: path('/data/locked/a'),
        write: false,
        prefix: '/data/',
      }),
    ).toBe(true)
  })

  it('matchIo names the line and holds the entry', () => {
    const pure: CommandRule = { reason: 'sealed', paths: ['/data/sealed'] }
    const scope = ruleScope(pure)
    expect(matchIo(pure, scope, ['grep', '-r', 'x', '/data'], '/data/sealed/deep/f')).toBe(true)
    expect(matchIo(pure, scope, ['du', '/data'], '/data/sealed')).toBe(true)
    expect(matchIo(pure, scope, ['du', '/data'], '/data/open/f')).toBe(false)
    // A command-scoped rule reads the line's tokens, so a pattern with a
    // token after the name applies only to the line that carries it.
    const scoped: CommandRule = { reason: 'no', commands: ['grep -r'], paths: ['/data/private'] }
    expect(
      matchIo(scoped, ruleScope(scoped), ['grep', '-r', 'k', '/data'], '/data/private/k'),
    ).toBe(true)
    expect(matchIo(scoped, ruleScope(scoped), ['grep', 'k', '/data'], '/data/private/k')).toBe(
      false,
    )
    expect(matchIo(scoped, ruleScope(scoped), ['cat', '/data'], '/data/private/k')).toBe(false)
    // A whole-line rule spoke at admission and says nothing at an entry;
    // the directory holding a children pattern is not in it.
    const whole: CommandRule = { reason: 'no', commands: ['rm'] }
    expect(matchIo(whole, ruleScope(whole), ['rm', '/data/x'], '/data/x')).toBe(false)
    const children: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    expect(matchIo(children, ruleScope(children), ['ls', '/data'], '/data/locked')).toBe(false)
    expect(matchIo(children, ruleScope(children), ['ls', '/data'], '/data/locked/y')).toBe(true)
  })

  it('ruleScope is null for a whole-line rule and remembered per rule', () => {
    const whole: CommandRule = { reason: 'no', commands: ['rm'] }
    expect(ruleScope(whole)).toBeNull()
    const scoped: CommandRule = { reason: 'no', paths: ['/data/*'] }
    expect(ruleScope(scoped)).toBe(ruleScope(scoped))
  })

  it('ioRefusal applies the gate precedence to an entry', () => {
    const deny: CommandRule = { reason: 'locked', commands: ['rm'], paths: ['/data/both/locked/*'] }
    const ask: CommandRule = {
      reason: 'needs a nod',
      commands: ['rm'],
      paths: ['/data/both/*'],
    }
    const later: CommandRule = {
      reason: 'a later nod',
      commands: ['rm'],
      paths: ['/data/both/*'],
    }
    const rules: AdmissionRules = { allow: null, ask: [ask, later], deny: [deny] }
    const tokens = ['rm', '-r', '/data/both']
    // deny > ask, wherever either was written.
    expect(ioRefusal(rules, tokens, '/data/both/locked/y', [ask])).toBe('locked')
    // The first matching ask rule speaks: refused without a grant under
    // it, passed with one, and the later rule never gets a say.
    expect(ioRefusal(rules, tokens, '/data/both/a', [])).toBe('needs a nod')
    expect(ioRefusal(rules, tokens, '/data/both/a', [ask])).toBeNull()
    expect(ioRefusal(rules, tokens, '/data/both/a', [later])).toBe('needs a nod')
    // An entry no rule holds passes; so does one a whole-line rule names.
    expect(ioRefusal(rules, tokens, '/data/open/a', [])).toBeNull()
    const whole: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'] }],
    }
    expect(ioRefusal(whole, tokens, '/data/x', [])).toBeNull()
    expect(ioRefusal(null, tokens, '/data/x', [])).toBeNull()
  })

  it('ioRefusal orders by anchor depth like the admission gate', () => {
    // A broad deny with an approved ask carved out of it. The gate
    // admits `rm -r /repo` under the deeper ask, so the entry gate has
    // to read the same way: taking every deny before any ask would
    // refuse every entry the carve-out was written for, leaving a line
    // that was admitted unable to touch anything.
    const deny: CommandRule = { reason: 'ro repo', commands: ['rm'], paths: ['/repo/*'] }
    const ask: CommandRule = { reason: 'sealed', commands: ['rm'], paths: ['/repo/sealed/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [deny] }
    const tokens = ['rm', '-r', '/repo']
    expect(ioRefusal(rules, tokens, '/repo/sealed/secret', [ask])).toBeNull()
    // Without the grant the deeper ask still wins, and asks.
    expect(ioRefusal(rules, tokens, '/repo/sealed/secret', [])).toBe('sealed')
    // Outside the carve-out the broad deny is what is left.
    expect(ioRefusal(rules, tokens, '/repo/other/x', [ask])).toBe('ro repo')
  })
})

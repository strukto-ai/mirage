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
import {
  CommandWord,
  Outcome,
  type CommandContext,
  type CommandRule,
  type AdmissionRules,
  type VfsContext,
} from '../types.ts'
import { WordKind } from '../../commands/spec/types.ts'
import { decide } from './decide.ts'
import { ioReach, ioRefusal, opRuling, skippedAtDispatch } from './rule.ts'
import { CALLS } from '../../workspace/dispatcher/constants.ts'
import { Effect, Target, type VfsCall } from '../../vfs/types.ts'

function callOf(name: string): VfsCall {
  const call = CALLS.get(name)
  if (call === undefined) throw new Error(`no call ${name}`)
  return call
}

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
  extra: Partial<Omit<CommandContext, 'command'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', ...extra }
}

/**
 * How a profile holding this one deny rule answers a line: refused or
 * not, and the operand the refusal names (null for the whole line).
 */
function verdict(rule: CommandRule, line: CommandContext): [Outcome, string | null] {
  const ruling = decide(line, { allow: null, deny: [rule], ask: [] })
  return [ruling.outcome, ruling.matchedPath]
}

/** Whether a profile holding this one deny rule refuses an op. */
function refusesOp(rule: CommandRule, op: VfsContext): boolean {
  return opRuling({ allow: null, deny: [rule], ask: [] }, op, []) !== null
}

const DENY_LINE = [Outcome.DENY, null]
const ALLOW = [Outcome.ALLOW, null]

describe('rules', () => {
  it('a rule reaches a line by command pattern, operand and mount', () => {
    const whole: CommandRule = { reason: 'no', commands: ['git push'] }
    expect(verdict(whole, ctx('git', { tokens: ['git', 'push', 'origin'] }))).toEqual(DENY_LINE)
    expect(verdict(whole, ctx('git', { tokens: ['git', 'pull'] }))).toEqual(ALLOW)
    const scoped: CommandRule = { reason: 'no', commands: ['rm'], paths: ['/repo/*'] }
    expect(verdict(scoped, ctx('rm', { paths: [path('/repo/x', 'x')], cwd: '/repo' }))).toEqual([
      Outcome.DENY,
      'x',
    ])
    expect(verdict(scoped, ctx('rm', { paths: [path('/scratch/x')] }))).toEqual(ALLOW)
    // A mount-tier rule applies to a line whose cwd or paths lie under
    // the mount, and to nothing else.
    const mount: CommandRule = { reason: 'ro', commands: ['git push'], mount: '/repo' }
    const push = ['git', 'push']
    expect(verdict(mount, ctx('git', { tokens: push, cwd: '/repo/sub' }))).toEqual(DENY_LINE)
    expect(
      verdict(mount, ctx('git', { tokens: push, cwd: '/scratch', paths: [path('/repo')] })),
    ).toEqual(DENY_LINE)
    expect(verdict(mount, ctx('git', { tokens: push, cwd: '/scratch' }))).toEqual(ALLOW)
    expect(verdict(mount, ctx('git', { tokens: push, cwd: '/repository' }))).toEqual(ALLOW)
    // An every-command rule (no patterns) matches whatever line.
    expect(verdict({ reason: 'locked' }, ctx('ls'))).toEqual(DENY_LINE)
  })

  it("a rule's paths read the one path grammar", () => {
    // A plain entry is an exact path and its subtree, so `/data/prod`
    // covers `/data/prod/x` but not `/data/production`; a slashless glob
    // matches any name component; `?` and a class are patterns too.
    const prod: CommandRule = { reason: 'prod', commands: ['rm'], paths: ['/data/prod'] }
    for (const virtual of ['/data/prod', '/data/prod/x']) {
      expect(verdict(prod, ctx('rm', { paths: [path(virtual)] }))).toEqual([Outcome.DENY, virtual])
    }
    expect(verdict(prod, ctx('rm', { paths: [path('/data/production')] }))).toEqual(ALLOW)
    const keys: CommandRule = { reason: 'keys', paths: ['*.key'] }
    expect(verdict(keys, ctx('cat', { paths: [path('/a/b.key/c')] }))).toEqual([
      Outcome.DENY,
      '/a/b.key/c',
    ])
    expect(verdict(keys, ctx('cat', { paths: [path('/a/b.keyx')] }))).toEqual(ALLOW)
    const one: CommandRule = { reason: 'one', paths: ['/data/?.txt'] }
    expect(verdict(one, ctx('cat', { paths: [path('/data/a.txt')] }))[0]).toBe(Outcome.DENY)
    expect(verdict(one, ctx('cat', { paths: [path('/data/ab.txt')] }))).toEqual(ALLOW)
    const cls: CommandRule = { reason: 'cls', paths: ['/data/[ab].txt'] }
    expect(verdict(cls, ctx('cat', { paths: [path('/data/b.txt')] }))[0]).toBe(Outcome.DENY)
    expect(verdict(cls, ctx('cat', { paths: [path('/data/c.txt')] }))).toEqual(ALLOW)
  })

  it('a walking command touches the mounts under its operands', () => {
    // `grep -r x /scratch` enters `/scratch/child`: the fan-out reruns
    // the traversal inside each descendant mount and no admission fires
    // again there, so the ancestor operand is where the mount's rule
    // speaks. A command that does not walk, or an operand that is not
    // above the root, stays untouched.
    const mount: CommandRule = { reason: 'boxed', mount: '/scratch/child' }
    const above = [path('/scratch')]
    expect(verdict(mount, ctx('grep', { paths: above, walks: true }))).toEqual(DENY_LINE)
    expect(verdict(mount, ctx('grep', { paths: above }))).toEqual(ALLOW)
    const beside = [path('/scratch/file.txt')]
    expect(verdict(mount, ctx('grep', { paths: beside, walks: true }))).toEqual(ALLOW)
  })

  it('opRuling reads depth before verb and honours a grant', () => {
    const broad: CommandRule = { reason: 'repo is sealed', paths: ['/repo/*'] }
    const carve: CommandRule = { reason: 'outbox nod', paths: ['/repo/outbox/*'] }
    const rules: AdmissionRules = { allow: null, deny: [broad], ask: [carve] }
    const inside: VfsContext = {
      call: callOf('write'),
      path: path('/repo/outbox/a'),
      write: true,
      prefix: '/repo/',
    }
    // The deeper ask wins where both reach, exactly as command admission
    // ranks them, so a broad deny cannot overrule an approved carve-out.
    expect(opRuling(rules, inside, [])).toEqual([carve, true])
    expect(opRuling(rules, inside, [carve])).toBeNull()
    // Outside the carve-out the deny is what is left, and a grant for
    // the ask says nothing about it.
    const outside: VfsContext = {
      call: callOf('write'),
      path: path('/repo/sealed/a'),
      write: true,
      prefix: '/repo/',
    }
    expect(opRuling(rules, outside, [carve])).toEqual([broad, false])
    // A metadata op is reached by neither: deny is present and refused.
    const stat: VfsContext = {
      call: callOf('stat'),
      path: path('/repo/outbox/a'),
      write: false,
      prefix: '/repo/',
    }
    expect(opRuling(rules, stat, [])).toBeNull()
    // No rules at all, and a rule naming a command, are both silent.
    expect(opRuling(null, inside, [])).toBeNull()
    const named: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'x', commands: ['rm'], paths: ['/repo/*'] }],
    }
    expect(opRuling(named, inside, [])).toBeNull()
  })

  it('an op meets pure path rules only', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const op: VfsContext = {
      call: callOf('write'),
      path: path('/data/locked/a'),
      write: true,
      prefix: '/data/',
    }
    expect(refusesOp(rule, op)).toBe(true)
    expect(
      refusesOp(rule, {
        call: callOf('write'),
        path: path('/data/open/a'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
    const named: CommandRule = { reason: 'x', commands: ['rm'], paths: ['/data/*'] }
    expect(refusesOp(named, op)).toBe(false)
    expect(refusesOp({ reason: 'x', commands: ['rm'] }, op)).toBe(false)
  })

  function subtreeCtx(command: string, ...operands: string[]): CommandContext {
    const paths = operands.map((o) => path(o, o))
    const words = [
      new CommandWord(command, WordKind.NAME),
      ...paths.map((p) => new CommandWord(p.rawPath, WordKind.OPERAND, null, p)),
    ]
    return ctx(command, { paths, words, argv: operands, tokens: [command, ...operands] })
  }

  it('a subtree command on the directory holding the scope matches', () => {
    // `/x/locked/*` protects the children; `rm -r /x/locked`, `rm -r /x`
    // and `mv /x/locked elsewhere` take them along, so for rm, rmdir and
    // mv the operand at or above the holding directory matches.
    const rule: CommandRule = { reason: 'frozen', paths: ['/x/locked/*'] }
    for (const command of ['rm', 'rmdir']) {
      for (const operand of ['/x/locked', '/x', '/']) {
        expect(verdict(rule, subtreeCtx(command, operand))).toEqual([Outcome.DENY, operand])
      }
      expect(verdict(rule, subtreeCtx(command, '/x/other'))).toEqual(ALLOW)
    }
    expect(verdict(rule, subtreeCtx('mv', '/x/locked', '/y'))).toEqual([Outcome.DENY, '/x/locked'])
    expect(verdict(rule, subtreeCtx('mv', '/x', '/y'))).toEqual([Outcome.DENY, '/x'])
    // mv's destination matches only as the holding directory itself:
    // moving into it lands in the scope, moving into an ancestor does not.
    expect(verdict(rule, subtreeCtx('mv', '/z', '/x/locked'))).toEqual([Outcome.DENY, '/x/locked'])
    expect(verdict(rule, subtreeCtx('mv', '/z', '/x'))).toEqual(ALLOW)
    // A reader given the same operand is not a whole-line refusal: its
    // I/O under the scope is the command tier's to refuse, file by file.
    expect(verdict(rule, subtreeCtx('cat', '/x/locked'))).toEqual(ALLOW)
    expect(verdict(rule, subtreeCtx('cp', '/x', '/y'))).toEqual(ALLOW)
    // A command-scoped rule judges its own command the same way.
    const named: CommandRule = { reason: 'locked', commands: ['rm'], paths: ['/x/locked/*'] }
    expect(verdict(named, subtreeCtx('rm', '/x'))).toEqual([Outcome.DENY, '/x'])
    expect(verdict(named, subtreeCtx('mv', '/x', '/y'))).toEqual(ALLOW)
  })

  it('a subtree op on the directory holding the scope is refused', () => {
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    for (const [op, virtual] of [
      ['rename', '/data/locked'],
      ['rename', '/data'],
      ['rmdir', '/data/locked'],
      ['rm_r', '/data'],
    ] as const) {
      expect(
        refusesOp(rule, {
          call: callOf(op),
          path: path(virtual),
          write: true,
          prefix: '/data/',
        }),
      ).toBe(true)
    }
    // A read or write of the directory itself is not in the scope, and a
    // subtree op beside the scope is not either.
    expect(
      refusesOp(rule, {
        call: callOf('readdir'),
        path: path('/data/locked'),
        write: false,
        prefix: '/data/',
      }),
    ).toBe(false)
    expect(
      refusesOp(rule, {
        call: callOf('rename'),
        path: path('/data/other'),
        write: true,
        prefix: '/data/',
      }),
    ).toBe(false)
  })
  it('a metadata op is let through', () => {
    // Deny is present and refused: the entry stats, the read is refused.
    const rule: CommandRule = { reason: 'frozen', paths: ['/data/locked/*'] }
    const exists: VfsCall = {
      name: 'exists',
      effect: Effect.METADATA,
      target: Target.ANY,
      creates: false,
      subtree: false,
    }
    for (const call of [callOf('stat'), exists]) {
      expect(
        refusesOp(rule, {
          call,
          path: path('/data/locked/a'),
          write: false,
          prefix: '/data/',
        }),
      ).toBe(false)
    }
    expect(
      refusesOp(rule, {
        call: callOf('read'),
        path: path('/data/locked/a'),
        write: false,
        prefix: '/data/',
      }),
    ).toBe(true)
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

  it('ioReach reads each start point on its own', () => {
    // A native walk asks per operand whether a rule could reach anything
    // under it: a rule on /repo/.env holds the walk of /repo, and leaves
    // the walk of /s3 its native op.
    const env: CommandRule = { reason: 'secrets', paths: ['/repo/.env'] }
    const rmOnly: CommandRule = { reason: 'no deletes', commands: ['rm'], paths: ['/data/*'] }
    const rules: AdmissionRules = { allow: null, deny: [env], ask: [rmOnly] }
    const find = ['find', '/repo', '/s3', '/data']
    expect(ioReach(rules, find, '/repo')).toBe(true)
    expect(ioReach(rules, find, '/repo/.env')).toBe(true)
    expect(ioReach(rules, find, '/s3')).toBe(false)
    // A rule naming another command does not reach this line's walk.
    expect(ioReach(rules, find, '/data')).toBe(false)
    expect(ioReach(rules, ['rm', '-r', '/data'], '/data')).toBe(true)
    // A whole-line rule has no paths to reach an entry with.
    const whole: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'] }],
    }
    expect(ioReach(whole, ['rm', '-r', '/data'], '/data')).toBe(false)
    expect(ioReach(null, find, '/repo')).toBe(false)
  })

  it('skippedAtDispatch names the command-level rules', () => {
    const keys: CommandRule = { reason: 'keys', paths: ['/k/*'] }
    const rules: AdmissionRules = {
      allow: ['ls'],
      deny: [keys, { reason: 'no rm', commands: ['rm'] }],
      ask: [{ reason: 'nod', commands: ['cp'], paths: ['/x/*'] }],
    }
    expect(skippedAtDispatch(rules)).toEqual([
      'commands.allow',
      'commands.deny: no rm',
      'commands.ask: nod',
    ])
    expect(skippedAtDispatch({ allow: null, ask: [], deny: [keys] })).toEqual([])
    expect(skippedAtDispatch(null)).toEqual([])
  })
})

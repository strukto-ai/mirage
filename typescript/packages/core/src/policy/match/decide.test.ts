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
import { ASK_SECOND, DENY_FIRST } from '../constants.ts'
import { Outcome, type CommandContext, type CommandRule, type AdmissionRules } from '../types.ts'
import { decide, outranks, sourceOf } from './decide.ts'

const registry = { isMountRoot: () => false }

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual,
    resolved: true,
    rawPath: virtual,
  })
}

function ctx(command: string, ...paths: string[]): CommandContext {
  const specs = paths.map(path)
  return {
    command,
    paths: specs,
    operands: specs,
    argv: paths,
    cwd: '/',
    registry,
    tokens: [command, ...paths],
  }
}

describe('decide', () => {
  it('answers with silence and with the allow list before any rule', () => {
    expect(decide(ctx('ls'), null).outcome).toBe(Outcome.ALLOW)
    expect(decide(ctx('ls'), { allow: null, ask: [], deny: [] }).outcome).toBe(Outcome.ALLOW)
    const listed: AdmissionRules = { allow: ['cat'], ask: [], deny: [] }
    expect(decide(ctx('cat', '/x'), listed).outcome).toBe(Outcome.ALLOW)
    const refused = decide(ctx('rm', '/x'), listed)
    // The allow list refuses as DENY like any rule; the empty `rule` is
    // the only thing separating it from one, and is what leaves the
    // refusal with no operator reason to print.
    expect(refused.outcome).toBe(Outcome.DENY)
    expect(refused.rule).toBeNull()
    expect(refused.source).toBe('commands.allow')
  })

  it('takes the deeper entry and breaks a tie with deny', () => {
    const broad: CommandRule = { reason: 'broad', commands: ['cat'], paths: ['/a/*'] }
    const deep: CommandRule = { reason: 'deep', commands: ['cat'], paths: ['/a/b/c/*'] }
    const rules: AdmissionRules = { allow: null, ask: [deep], deny: [broad] }
    expect(decide(ctx('cat', '/a/b/c/x'), rules).rule).toBe(deep)
    expect(decide(ctx('cat', '/a/other'), rules).rule).toBe(broad)
    const tied: CommandRule = { reason: 'tied', commands: ['cat'], paths: ['/a/*'] }
    expect(decide(ctx('cat', '/a/x'), { allow: null, ask: [tied], deny: [broad] }).rule).toBe(broad)
  })

  it("never lets one operand's ask answer for another operand's deny", () => {
    // The whole reason a line is judged subject by subject: reading one
    // best match for the line let the destination's deeper ask carry the
    // source out of a deny written for it.
    const deny: CommandRule = { reason: 'protected', commands: ['cp'], paths: ['/protected/*'] }
    const ask: CommandRule = { reason: 'review nod', commands: ['cp'], paths: ['/review/deep/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [deny] }
    const decision = decide(ctx('cp', '/protected/secret', '/review/deep/out'), rules)
    expect(decision.outcome).toBe(Outcome.DENY)
    expect(decision.rule).toBe(deny)
    expect(decision.matchedPath).toBe('/protected/secret')
    // Each operand on its own still reads as it always did.
    expect(decide(ctx('cp', '/protected/secret', '/elsewhere/out'), rules).rule).toBe(deny)
    expect(decide(ctx('cp', '/review/deep/x', '/elsewhere/out'), rules).rule).toBe(ask)
  })

  it('still reopens the operand a carve-out was written for', () => {
    // The per-subject law must not undo the deeper-wins law: one operand
    // covered by both rules is still the deeper one's.
    const deny: CommandRule = { reason: 'sealed', commands: ['cat'], paths: ['/a/*'] }
    const ask: CommandRule = { reason: 'nod', commands: ['cat'], paths: ['/a/open/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [deny] }
    expect(decide(ctx('cat', '/a/open/x'), rules).rule).toBe(ask)
    // A second operand the carve-out says nothing about brings the deny
    // back, because the line has to survive every path it names.
    expect(decide(ctx('cat', '/a/open/x', '/a/sealed'), rules).rule).toBe(deny)
  })

  it('reaches every subject with a pathless rule, at depth zero', () => {
    // It is off the path axis, so an entry naming a place outranks it,
    // but it still speaks about an operand no entry covers.
    const pathless: CommandRule = { reason: 'no rm', commands: ['rm'] }
    const ask: CommandRule = { reason: 'wip nod', commands: ['rm'], paths: ['/wip/*'] }
    const rules: AdmissionRules = { allow: null, ask: [ask], deny: [pathless] }
    expect(decide(ctx('rm', '/wip/x'), rules).rule).toBe(ask)
    expect(decide(ctx('rm', '/wip/x', '/elsewhere'), rules).rule).toBe(pathless)
    // A line naming no path at all is one subject, itself.
    const whole = decide(ctx('rm'), rules)
    expect(whole.rule).toBe(pathless)
    expect(whole.matchedPath).toBeNull()
  })

  it('reports the rule and where it was written', () => {
    const top: CommandRule = { reason: 'top', commands: ['rm'], paths: ['/a/*'] }
    const inside: CommandRule = {
      reason: 'mount',
      commands: ['rm'],
      paths: ['/a/b/*'],
      mount: '/a',
    }
    const decision = decide(ctx('rm', '/a/b/x'), { allow: null, ask: [], deny: [top, inside] })
    expect(decision.rule).toBe(inside)
    expect(decision.source).toBe('mounts./a')
    expect(sourceOf(top)).toBe('top')
  })

  it('reads the verb first in outranks where betterMatch reads depth', () => {
    // Two subjects of one line are a question of severity, so a deny at
    // depth 0 outranks an ask at depth 3.
    expect(outranks([ASK_SECOND, 3], DENY_FIRST, 0)).toBe(true)
    expect(outranks([DENY_FIRST, 0], ASK_SECOND, 3)).toBe(false)
    expect(outranks([DENY_FIRST, 1], DENY_FIRST, 2)).toBe(true)
    expect(outranks([DENY_FIRST, 2], DENY_FIRST, 2)).toBe(false)
  })

  it("reports every subject's ask, not just the winner", () => {
    const source: CommandRule = { reason: 'source nod', commands: ['cp'], paths: ['/a/*'] }
    const dest: CommandRule = { reason: 'dest nod', commands: ['cp'], paths: ['/deep/b/*'] }
    const rules: AdmissionRules = { allow: null, ask: [source, dest], deny: [] }
    const decision = decide(ctx('cp', '/a/x', '/deep/b/y'), rules)
    // The deeper anchor is still the decision, which is what the agent is
    // told; both are what the door has to collect.
    expect(decision.outcome).toBe(Outcome.ASK)
    expect(decision.rule).toBe(dest)
    expect(decision.asks).toEqual([source, dest])
    // One rule covering two operands is one question, not two.
    const both: CommandRule = { reason: 'either', commands: ['cp'], paths: ['/a/*'] }
    const one = decide(ctx('cp', '/a/x', '/a/y'), { allow: null, ask: [both], deny: [] })
    expect(one.asks).toEqual([both])
    // A deny anywhere refuses the line, so there is nothing to ask about.
    const stopped = decide(ctx('cp', '/a/x', '/deep/b/y'), {
      allow: null,
      ask: [dest],
      deny: [{ reason: 'no', commands: ['cp'], paths: ['/a/*'] }],
    })
    expect(stopped.outcome).toBe(Outcome.DENY)
    expect(stopped.asks).toEqual([])
  })
})

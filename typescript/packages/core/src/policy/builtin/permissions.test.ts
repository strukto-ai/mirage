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
import { Policies } from '../policies.ts'
import type { CommandContext, AdmissionRules, CommandRule, OpsContext } from '../types.ts'
import { PermissionsPolicy } from './permissions.ts'

const registry = { isMountRoot: () => false }

// A SessionCommandsQuery: one compiled document per session id.
class Sessions {
  constructor(private readonly rules: Record<string, AdmissionRules>) {}

  commandsOf(sessionId: string): AdmissionRules | null {
    return this.rules[sessionId] ?? null
  }
}

function path(virtual: string, raw = ''): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual,
    resolved: true,
    rawPath: raw,
  })
}

function ctx(
  command: string,
  args: string[] = [],
  extra: Partial<Omit<CommandContext, 'command' | 'registry'>> = {},
): CommandContext {
  return {
    command,
    paths: [],
    argv: args,
    cwd: '/',
    registry,
    sessionId: 's',
    tokens: [command, ...args],
    program: [command],
    ...extra,
  }
}

// One profile, compiled: its own rules plus the ones its `mounts./repo`
// section carries, which the compiler stamped with that root.
const MOUNT_DENY: CommandRule = {
  reason: 'history is read-only here',
  commands: ['git push'],
  mount: '/repo',
}
const ASK_PUSH: CommandRule = { reason: 'sign-off', commands: ['git push'] }
const FULL: AdmissionRules = {
  allow: ['ls', 'cat', 'rm', 'git', 'python3'],
  deny: [
    MOUNT_DENY,
    { reason: 'no deletes in the repo', commands: ['rm'], paths: ['/repo/*'] },
    { reason: 'frozen', paths: ['/repo/locked/*'] },
  ],
  ask: [ASK_PUSH],
}
const REVIEWER: AdmissionRules = {
  allow: ['ls', 'cat', 'git log', 'git status'],
  ask: [],
  deny: [],
}

const policy = () => new PermissionsPolicy(new Sessions({ s: FULL, rev: REVIEWER }))

describe('PermissionsPolicy', () => {
  it('no rules means no opinion', () => {
    const p = new PermissionsPolicy(new Sessions({}))
    expect(p.preCommand(ctx('rm', ['-rf', '/']))).toBeNull()
    expect(p.preOps({ op: 'unlink', path: path('/x'), write: true, prefix: '/' })).toBeNull()
  })

  it('the allow list refuses a visible head it does not cover', () => {
    const p = policy()
    expect(p.preCommand(ctx('ls', ['-la'], { sessionId: 'rev' }))).toBeNull()
    expect(
      p.preCommand(ctx('git', ['log', '-1'], { sessionId: 'rev', program: ['git', 'log'] })),
    ).toBeNull()
    // `git` is visible in the reviewer session (some git lines are
    // allowed) but `git push` matches nothing there: a whole-command
    // refusal naming the program, not "command not found".
    expect(
      p.preCommand(ctx('git', ['push'], { sessionId: 'rev', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'git push is not allowed' })
    // A word that is not a tool is never refused by an allow list.
    expect(p.preCommand(ctx('cd', ['/x'], { sessionId: 'rev', tool: false }))).toBeNull()
    expect(p.preCommand(ctx('python3', ['-c', '1']))).toBeNull()
  })

  it('a deny rule speaks by scope and by where it was written', () => {
    const p = policy()
    // Whole-command rule: reason only, the door renders `git: policy
    // denied: ...` at 126. A mount section's rule applies when the line
    // works inside that mount (here by cwd).
    expect(
      p.preCommand(ctx('git', ['push'], { cwd: '/repo/sub', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'history is read-only here' })
    // Off the mount, the same line falls through to the ask rule: the
    // deny rules ran first and had no opinion.
    expect(
      p.preCommand(ctx('git', ['push'], { cwd: '/scratch', program: ['git', 'push'] })),
    ).toEqual({ kind: 'ask', reason: 'sign-off', rule: ASK_PUSH, rules: [ASK_PUSH] })
    // Operand-scoped rule: the operand as typed, in the GNU voice.
    expect(p.preCommand(ctx('rm', ['x'], { paths: [path('/repo/x', 'x')], cwd: '/repo' }))).toEqual(
      {
        kind: 'deny',
        reason: 'x: no deletes in the repo',
        scope: 'operand',
      },
    )
    expect(p.preCommand(ctx('rm', ['/scratch/x'], { paths: [path('/scratch/x')] }))).toBeNull()
    // A pure path rule refuses any command that names the path.
    expect(
      p.preCommand(ctx('cat', ['/repo/locked/a'], { paths: [path('/repo/locked/a')] })),
    ).toEqual({ kind: 'deny', reason: '/repo/locked/a: frozen', scope: 'operand' })
  })

  it('the deeper anchor wins and deny breaks a tie', () => {
    // The path axis: two rules matching one operand are ordered by how
    // many literal components each anchors, deepest first, and only a
    // tie is broken by the verb.
    const deep: CommandRule = { reason: 'sealed', commands: ['rm'], paths: ['/repo/sealed/*'] }
    const shallow: CommandRule = { reason: 'needs a nod', commands: ['rm'], paths: ['/repo/*'] }
    const p = new PermissionsPolicy(
      new Sessions({ s: { allow: null, ask: [shallow], deny: [deep] } }),
    )
    expect(
      p.preCommand(ctx('rm', ['/repo/sealed/y'], { paths: [path('/repo/sealed/y')] })),
    ).toEqual({ kind: 'deny', reason: '/repo/sealed/y: sealed', scope: 'operand' })
    // Outside the deeper rule's anchor the shallow one is what is left.
    expect(p.preCommand(ctx('rm', ['/repo/x'], { paths: [path('/repo/x')] }))).toEqual({
      kind: 'ask',
      reason: 'needs a nod',
      rule: shallow,
      rules: [shallow],
    })
    // The other way round: an ask anchored deeper than a deny wins, so a
    // profile can carve an exception out of a broad refusal.
    const flipped = new PermissionsPolicy(
      new Sessions({
        s: {
          allow: null,
          ask: [{ reason: 'nod here', commands: ['rm'], paths: ['/repo/sealed/*'] }],
          deny: [{ reason: 'no deletes', commands: ['rm'], paths: ['/repo/*'] }],
        },
      }),
    )
    expect(
      flipped.preCommand(ctx('rm', ['/repo/sealed/y'], { paths: [path('/repo/sealed/y')] })),
    ).toMatchObject({ kind: 'ask', reason: 'nod here' })
  })

  it('an unrelated entry does not lend a rule its depth', () => {
    // The rule is scored by the entry that covered this operand, not by
    // its deepest entry. Scoring the deepest would let
    // `/else/very/deep/*` -- which says nothing about /repo -- carry the
    // ask past a deny anchored right at /repo/private, and an approval
    // would then reopen exactly what the deny sealed.
    const ask: CommandRule = {
      reason: 'review',
      commands: ['cat'],
      paths: ['/repo/*', '/else/very/deep/*'],
    }
    const deny: CommandRule = { reason: 'private', commands: ['cat'], paths: ['/repo/private/*'] }
    const p = new PermissionsPolicy(new Sessions({ s: { allow: null, ask: [ask], deny: [deny] } }))
    expect(
      p.preCommand(ctx('cat', ['/repo/private/x'], { paths: [path('/repo/private/x')] })),
    ).toEqual({ kind: 'deny', reason: '/repo/private/x: private', scope: 'operand' })
    // The unrelated entry still speaks where it does anchor.
    expect(
      p.preCommand(ctx('cat', ['/else/very/deep/x'], { paths: [path('/else/very/deep/x')] })),
    ).toMatchObject({ kind: 'ask', reason: 'review' })
  })

  it('a pathless rule is read by verb wherever it is written', () => {
    // The command axis, and the one thing it deliberately cannot say.
    // A rule naming no path scores nothing on the path axis even when a
    // mount section holds it, so "denied generally, asked inside one
    // mount" is inexpressible for a pathless rule: the deny wins. That
    // is correct for what such a rule covers in practice, an account CLI
    // that reaches a service and touches no mount at all.
    const deny: CommandRule = { reason: 'no branches', commands: ['git branch'] }
    const ask: CommandRule = {
      reason: 'branches need a nod',
      commands: ['git branch'],
      mount: '/repo',
    }
    const p = new PermissionsPolicy(new Sessions({ s: { allow: null, ask: [ask], deny: [deny] } }))
    expect(
      p.preCommand(ctx('git', ['branch'], { cwd: '/repo', program: ['git', 'branch'] })),
    ).toEqual({ kind: 'deny', reason: 'no branches' })
    // Give the mount rule a path and it is on the other axis, where
    // being deeper is what lets it carve out the exception.
    const scopedRule: CommandRule = {
      reason: 'branches need a nod',
      commands: ['git branch'],
      paths: ['/repo/wip/*'],
      mount: '/repo',
    }
    const carved = new PermissionsPolicy(
      new Sessions({ s: { allow: null, ask: [scopedRule], deny: [deny] } }),
    )
    expect(
      carved.preCommand(
        ctx('git', ['branch', '/repo/wip/x'], {
          paths: [path('/repo/wip/x')],
          cwd: '/repo',
          program: ['git', 'branch'],
        }),
      ),
    ).toMatchObject({ kind: 'ask', reason: 'branches need a nod' })
  })

  it('an ask rule speaks after every deny', () => {
    const p = policy()
    // A line an ask rule covers, refused by nothing: the Ask names the
    // rule so the door can key a session grant on it.
    expect(
      p.preCommand(
        ctx('git', ['push', 'origin', 'main'], { cwd: '/scratch', program: ['git', 'push'] }),
      ),
    ).toEqual({ kind: 'ask', reason: 'sign-off', rule: ASK_PUSH, rules: [ASK_PUSH] })
    // Deny runs first: on the mount the same line is refused, and a
    // grant could never re-open it because no Ask is raised.
    expect(p.preCommand(ctx('git', ['push'], { cwd: '/repo', program: ['git', 'push'] }))).toEqual({
      kind: 'deny',
      reason: 'history is read-only here',
    })
    // An operand-scoped ask rule asks only when the line names the path.
    const shared: AdmissionRules = {
      allow: null,
      ask: [{ reason: 'shared', commands: ['rm'], paths: ['/repo/shared/*'] }],
      deny: [],
    }
    const door = new PermissionsPolicy(new Sessions({ s: shared }))
    expect(
      door.preCommand(ctx('rm', ['/repo/shared/a'], { paths: [path('/repo/shared/a')] })),
    ).toEqual({ kind: 'ask', reason: 'shared', rule: shared.ask[0], rules: [shared.ask[0]] })
    expect(door.preCommand(ctx('rm', ['/repo/b'], { paths: [path('/repo/b')] }))).toBeNull()
  })

  it('preOps holds the pure path rules', () => {
    const p = policy()
    const locked: OpsContext = {
      op: 'write',
      path: path('/repo/locked/a'),
      write: true,
      prefix: '/repo/',
      sessionId: 's',
    }
    expect(p.preOps(locked)).toEqual({ kind: 'deny', reason: 'frozen' })
    // Command-scoped rules do not reach the op door: an op does not
    // know which command issued it.
    expect(
      p.preOps({
        op: 'unlink',
        path: path('/repo/x'),
        write: true,
        prefix: '/repo/',
        sessionId: 's',
      }),
    ).toBeNull()
  })

  it('seeded in a Policies chain after the builtins', async () => {
    const policies = new Policies([policy()])
    expect(
      await policies.preCommand(ctx('git', ['push'], { cwd: '/repo', program: ['git', 'push'] })),
    ).toEqual({ kind: 'deny', reason: 'history is read-only here', policy: 'PermissionsPolicy' })
    expect(policies.wants('preOps')).toBe(true)
  })
})

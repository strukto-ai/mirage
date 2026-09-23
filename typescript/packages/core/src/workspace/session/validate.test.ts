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

import { CLISpec } from '../../commands/cli/types.ts'
import { IOResult } from '../../io/types.ts'
import type { AdmissionRules, CommandRule } from '../../policy/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { Workspace } from '../workspace/workspace.ts'
import { checkCliVerbs, checkRules } from './validate.ts'

function rules(over: Partial<AdmissionRules> = {}): AdmissionRules {
  return { allow: null, ask: [], deny: [], ...over }
}

function rule(over: Partial<CommandRule> & { reason: string }): CommandRule {
  return { commands: [], paths: [], mount: '', ...over }
}

describe('checkRules', () => {
  it('refuses a rule on a builtin the allow list omits', () => {
    // The whole point of the check: `rm` reads as guarded in the
    // document and is not guarded at all, because it was never
    // installed, so nothing ever reaches the rule.
    expect(() => {
      checkRules(rules({ allow: ['ls', 'cat'], deny: [rule({ reason: 'no', commands: ['rm'] })] }))
    }).toThrow(/never installs/)
    expect(() => {
      checkRules(rules({ allow: ['ls'], ask: [rule({ reason: 'sign-off', commands: ['rm'] })] }))
    }).toThrow(/never installs/)
  })

  it('passes a rule on an installed builtin', () => {
    checkRules(rules({ allow: ['ls', 'rm'], deny: [rule({ reason: 'no', commands: ['rm'] })] }))
    // No allow list installs everything, so nothing is dead.
    checkRules(rules({ deny: [rule({ reason: 'no', commands: ['rm'] })] }))
  })

  it('leaves a word that is not a builtin alone', () => {
    // It may be a CLI the host registers after the workspace is built,
    // which is what checkCliVerbs covers at createSession.
    checkRules(rules({ allow: ['ls'], deny: [rule({ reason: 'no', commands: ['mycli run'] })] }))
  })

  it('refuses an ask an outranking deny covers', () => {
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
          deny: [rule({ reason: 'no', commands: ['rm'] })],
        }),
      )
    }).toThrow(/can never fire/)
    // A shorter deny pattern covers a longer ask.
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['git push'] })],
          deny: [rule({ reason: 'no', commands: ['git'] })],
        }),
      )
    }).toThrow(/can never fire/)
    // A deny naming no commands refuses everything.
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
          deny: [rule({ reason: 'no' })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('allows a deny that leaves the ask work', () => {
    // Path-scoped: the ask still fires on every operand the deny does
    // not name.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
        deny: [rule({ reason: 'no', commands: ['rm'], paths: ['/prod/*'] })],
      }),
    )
    // A longer deny does not cover a shorter ask.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['git'] })],
        deny: [rule({ reason: 'no', commands: ['git push'] })],
      }),
    )
    // An ask naming two commands the deny only half covers.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm', 'mv'] })],
        deny: [rule({ reason: 'no', commands: ['rm'] })],
      }),
    )
  })

  it('does not let a mount-scoped deny kill a rule outside it', () => {
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
        deny: [rule({ reason: 'no', commands: ['rm'], mount: '/repo' })],
      }),
    )
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'], mount: '/repo' })],
          deny: [rule({ reason: 'no', commands: ['rm'], mount: '/repo' })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('leaves a deny at a different anchor to the run', () => {
    // A top-level deny does shadow a mount-scoped ask on the same
    // command, but across anchors the deeper rule leads and which one
    // that is depends on the line, so this reports nothing rather than
    // guess. `conflict_a_later_tiers_deny_outranks_an_earlier_tiers_ask`
    // in integ/session/commands/conflicts.json is exactly that document.
    checkRules(
      rules({
        ask: [rule({ reason: 'log it', commands: ['git branch'], mount: '/repo' })],
        deny: [rule({ reason: 'no branches', commands: ['git branch'] })],
      }),
    )
  })

  it('reads a wildcard token in a deny as covering whatever the ask names', () => {
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['git push'] })],
          deny: [rule({ reason: 'no', commands: ['git *'] })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('passes when there is nothing to check', () => {
    checkRules(null)
    checkRules(rules())
  })
})

describe('checkCliVerbs', () => {
  const verbs = new Map<string, ReadonlySet<string>>([['git', new Set(['status', 'push'])]])

  it('refuses a rule naming a verb its CLI does not have', () => {
    expect(() => {
      checkCliVerbs(rules({ deny: [rule({ reason: 'no', commands: ['git shove'] })] }), verbs)
    }).toThrow(/no verb for/)
  })

  it('passes a known verb, a wildcard, an unclaimed head word and a bare name', () => {
    checkCliVerbs(rules({ deny: [rule({ reason: 'no', commands: ['git push'] })] }), verbs)
    checkCliVerbs(rules({ deny: [rule({ reason: 'no', commands: ['git *'] })] }), verbs)
    checkCliVerbs(rules({ deny: [rule({ reason: 'no', commands: ['slack send'] })] }), verbs)
    checkCliVerbs(rules({ deny: [rule({ reason: 'no', commands: ['git'] })] }), verbs)
    checkCliVerbs(null, verbs)
  })
})

function noopVerb(): [null, IOResult] {
  return [null, new IOResult()]
}

describe('createSession reads the verbs of an installed CLI', () => {
  it('refuses a rule naming a verb the CLI does not declare', () => {
    // Reached through the workspace, not the helper, because the wiring
    // is the part that broke: this read the registry with
    // Object.entries over a Map and silently saw no CLIs at all, so the
    // check passed everything.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    ws.registerCli(
      'prog',
      new CLISpec({ name: 'prog', subcommands: [new CLISpec({ name: 'run', fn: noopVerb })] }),
    )
    expect(() =>
      ws.createSession('bad', {
        permissions: parseSessionProfile({
          commands: { deny: [{ reason: 'no', commands: ['prog walk'] }] },
        }),
      }),
    ).toThrow(/no verb for/)
    ws.createSession('good', {
      permissions: parseSessionProfile({
        commands: { deny: [{ reason: 'no', commands: ['prog run'] }] },
      }),
    })
  })
})

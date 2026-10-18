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

import type { CommandRule, AdmissionRules, Decision } from '../../policy/types.ts'
import { Outcome, Scope } from '../../policy/types.ts'
import {
  commandsFromDict,
  commandsToDict,
  decisionFromDict,
  decisionToDict,
  ruleFromDict,
  ruleToDict,
} from './serialize.ts'

describe('session record codecs', () => {
  it('a rule round-trips and writes mount only when set', () => {
    const bare: CommandRule = { reason: 'no', commands: ['rm'] }
    const data = ruleToDict(bare)
    expect(data).toEqual({ reason: 'no', commands: ['rm'], paths: [] })
    expect(ruleFromDict(data)).toEqual({ reason: 'no', commands: ['rm'], paths: [], mount: '' })
    const scoped: CommandRule = {
      reason: 'ro',
      commands: ['git push'],
      paths: ['/repo/*'],
      mount: '/repo',
    }
    expect(ruleToDict(scoped).mount).toBe('/repo')
    expect(ruleFromDict(ruleToDict(scoped))).toEqual(scoped)
    // A record written before a field existed reads with the default.
    expect(ruleFromDict({ reason: 'x' })).toEqual({
      reason: 'x',
      commands: [],
      paths: [],
      mount: '',
    })
  })

  it('a command tier round-trips and keeps an absent allow list', () => {
    const spec: AdmissionRules = {
      allow: ['ls', 'git log'],
      ask: [{ reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    }
    expect(commandsFromDict(commandsToDict(spec))).toEqual(spec)
    const unlisted: AdmissionRules = {
      allow: null,
      ask: [],
      deny: [{ reason: 'x', commands: [], paths: [], mount: '' }],
    }
    const data = commandsToDict(unlisted)
    expect(data.allow).toBeNull()
    expect(commandsFromDict(data)).toEqual(unlisted)
  })

  it('a decision round-trips', () => {
    const rule: CommandRule = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }
    const record: Decision = {
      id: 'd1',
      sessionId: 'agent',
      command: 'git',
      argv: ['push'],
      cwd: '/repo',
      paths: ['/repo'],
      reason: 'sign-off',
      rule,
      outcome: Outcome.ALLOW,
      scope: Scope.SESSION,
      note: 'ok',
    }
    expect(decisionFromDict(decisionToDict(record))).toEqual(record)
    // A record still waiting has no outcome.
    const waiting: Decision = { ...record, id: 'd2', outcome: null, scope: Scope.ONCE, note: '' }
    expect(decisionFromDict(decisionToDict(waiting))).toEqual(waiting)
    expect(decisionToDict(record).outcome).toBe('allow')
    expect(decisionToDict(record).scope).toBe('session')
  })
})

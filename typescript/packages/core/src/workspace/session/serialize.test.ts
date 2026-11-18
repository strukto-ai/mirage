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

import type { CommandRule, Decision, ProfileScript } from '../../policy/types.ts'
import { Outcome, Scope } from '../../policy/types.ts'
import {
  commandsFromDict,
  commandsToDict,
  decisionFromDict,
  decisionToDict,
  ruleFromDict,
  ruleToDict,
  scriptFromDict,
  scriptToDict,
} from './serialize.ts'
import { ScriptSource } from '../../runtime/types.ts'
import { trees } from '../../test-utils.ts'
import { OLDER_FORMAT } from './constants.ts'

describe('session record codecs', () => {
  it('a rule round-trips and writes its optional fields only when set', () => {
    const leaf: CommandRule = {
      reason: 'ro',
      decision: Outcome.DENY,
      at: '/git/push/*',
      paths: ['/repo/*'],
      mount: '/repo',
    }
    const data = ruleToDict(leaf)
    expect(data).toEqual({
      reason: 'ro',
      decision: 'deny',
      paths: ['/repo/*'],
      at: '/git/push/*',
      mount: '/repo',
    })
    expect(ruleFromDict(data)).toEqual({ ...leaf, commands: [] })
    const coded: CommandRule = { reason: 'no', commands: ['rm'] }
    expect(ruleToDict(coded)).toEqual({ reason: 'no', paths: [], commands: ['rm'] })
    expect(ruleFromDict(ruleToDict(coded))).toEqual({
      reason: 'no',
      decision: Outcome.ASK,
      at: '',
      paths: [],
      mount: '',
      commands: ['rm'],
    })
  })

  it('command trees round-trip with their mounts', () => {
    const spec = trees(
      { '*': 'deny', ls: 'allow', rm: { '-r': 'ask' } },
      { '/repo': { git: { push: 'deny' } } },
      { cp: 'deny' },
    )
    const data = commandsToDict(spec)
    expect(data).toEqual([
      { mount: '', commands: { '*': 'deny', ls: 'allow', rm: { '--recursive': 'ask' } } },
      { mount: '/repo', commands: { git: { push: 'deny' } } },
      { mount: '', commands: { cp: 'deny' }, inline: true },
    ])
    expect(commandsFromDict(data)).toEqual(spec)
    expect(commandsFromDict(undefined)).toBeNull()
  })

  it('flat rules read back as the closed tree', () => {
    const flat = { allow: ['ls'], ask: [], deny: [] }
    expect(commandsFromDict(undefined, flat)).toEqual(OLDER_FORMAT)
    expect(commandsFromDict(commandsToDict(trees({})), flat)).toEqual(trees({}))
  })

  it('a decision round-trips', () => {
    const rule: CommandRule = {
      reason: 'sign-off',
      decision: Outcome.ASK,
      at: '',
      commands: ['git push'],
      paths: [],
      mount: '',
    }
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

  it('a script keeps an env pointer as the pointer', () => {
    const entry: ProfileScript = {
      profile: 'release',
      script: new ScriptSource('pass\n', 'python'),
      runtime: 'monty',
      config: {},
      env: {
        LLM_URL: 'https://llm/v1',
        LLM_KEY: { from: 'aws-sm', ref: 'prod/llm', key: 'key' },
      },
    }
    const data = scriptToDict(entry)
    expect(data.env).toEqual({
      LLM_URL: 'https://llm/v1',
      LLM_KEY: { from: 'aws-sm', ref: 'prod/llm', key: 'key' },
    })
    expect(scriptFromDict(data)).toEqual(entry)
    const older = { ...data }
    delete older.env
    expect(scriptFromDict(older).env).toEqual({})
  })
})

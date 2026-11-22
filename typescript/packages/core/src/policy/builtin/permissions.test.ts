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
import { Policies } from '../policies.ts'
import { type AdmissionRules, type Ask, type CommandContext, type Deny, Outcome } from '../types.ts'
import { PermissionsPolicy } from './permissions.ts'

// Mirrors python/tests/policy/builtin/test_permissions.py.

// A SessionCommandsQuery: one compiled document per session id.
class Sessions {
  constructor(private readonly rules: Record<string, AdmissionRules>) {}

  commandsOf(sessionId: string): AdmissionRules | null {
    return this.rules[sessionId] ?? null
  }
}

const FULL = trees(
  { cp: { decision: 'ask', reason: 'sign-off' } },
  {
    '/repo': {
      rm: { decision: 'deny', reason: 'no repo deletes' },
      cp: { decision: 'deny', reason: 'read-only' },
    },
  },
)
const REVIEWER = trees({ '*': 'deny', ls: 'allow', cat: 'allow' })

function policy(): PermissionsPolicy {
  return new PermissionsPolicy(new Sessions({ s: FULL, rev: REVIEWER }))
}

function judge(
  p: PermissionsPolicy,
  words: string[],
  options: { session?: string; cwd?: string; tool?: boolean } = {},
): Deny | Ask | null {
  const ctx: CommandContext = line(words, {
    sessionId: options.session ?? 's',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.tool === undefined ? {} : { tool: options.tool }),
  })
  return p.preCommand(ctx) as Deny | Ask | null
}

describe('PermissionsPolicy', () => {
  it('no tree means no opinion', () => {
    expect(judge(new PermissionsPolicy(new Sessions({})), ['rm', '-rf', '/'])).toBeNull()
  })

  it('a closed root refuses every command it names no allow for', () => {
    const p = policy()
    expect(judge(p, ['ls', '-la'], { session: 'rev' })).toBeNull()
    const deny = judge(p, ['rm', '/x'], { session: 'rev' })
    expect(deny?.kind).toBe('deny')
    expect(deny?.kind === 'deny' ? deny.rule?.at : null).toBe('/*')
    expect(deny?.reason).toBe('rm is not allowed')
    expect(judge(p, ['cd', '/x'], { session: 'rev', tool: false })).toBeNull()
  })

  it('a leaf speaks by its paths and by where it was written', () => {
    const p = policy()
    const deny = judge(p, ['cp', 'a', 'b'], { cwd: '/repo/sub' })
    expect(deny?.kind).toBe('deny')
    expect(deny?.reason).toBe('read-only')
    expect(deny?.kind === 'deny' ? deny.rule?.mount : null).toBe('/repo')
    const ask = judge(p, ['cp', 'a', 'b'], { cwd: '/scratch' })
    expect(ask?.kind).toBe('ask')
    expect(ask?.reason).toBe('sign-off')
    if (ask?.kind === 'ask') expect(ask.rules).toEqual([ask.rule])
    const refused = judge(p, ['rm', '/repo/x'])
    expect(refused?.kind).toBe('deny')
    if (refused?.kind === 'deny') {
      expect(refused.reason).toBe('no repo deletes')
      expect(refused.rule?.mount).toBe('/repo')
      expect(refused.rule?.decision).toBe(Outcome.DENY)
    }
    expect(judge(p, ['rm', '/scratch/x'])).toBeNull()
  })

  it('seeded in a Policies chain after the builtins', async () => {
    const policies = new Policies([policy()])
    const deny = await policies.preCommand(line(['cp', 'a', 'b'], { cwd: '/repo', sessionId: 's' }))
    expect(deny?.kind).toBe('deny')
    expect(deny?.reason).toBe('read-only')
    expect(deny?.policy).toBe('PermissionsPolicy')
    expect(policies.wants('preVfs')).toBe(false)
  })
})

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

import { admissionMatcher } from '../../rs/policy.ts'
import {
  Outcome,
  type AdmissionRules,
  type CommandContext,
  type CommandRule,
  type Ruling,
} from '../types.ts'
import { commandFacts } from './rule.ts'
import { lineTokens } from './allow.ts'

export function sourceOf(rule: CommandRule): string {
  return rule.mount ? `mounts.${rule.mount}` : 'top'
}

export function decide(ctx: CommandContext, rules: AdmissionRules | null): Ruling {
  if (rules === null || (rules.allow === null && rules.deny.length === 0 && rules.ask.length === 0))
    return { outcome: Outcome.ALLOW, rule: null, matchedPath: null, source: '', asks: [] }
  const matcher = admissionMatcher(rules)
  if (!matcher.lineAllowed(lineTokens(ctx), ctx.tool ?? true)) {
    return {
      outcome: Outcome.DENY,
      rule: null,
      matchedPath: null,
      source: 'commands.allow',
      asks: [],
    }
  }
  const answer = matcher.decide(commandFacts(ctx))
  const listed = [...rules.deny, ...rules.ask]
  const ruleAt = (id: number): CommandRule => {
    const rule = listed[id]
    if (rule === undefined) throw new Error('Invalid policy rule reply')
    return rule
  }
  const outcome =
    answer.outcome === 0
      ? Outcome.ALLOW
      : answer.outcome === 1
        ? Outcome.DENY
        : answer.outcome === 2
          ? Outcome.ASK
          : null
  if (outcome === null) throw new Error('Invalid policy outcome reply')
  const rule = answer.rule === null ? null : ruleAt(answer.rule)
  return {
    outcome,
    rule,
    matchedPath: answer.matched,
    source: answer.allowList ? 'commands.allow' : rule === null ? '' : sourceOf(rule),
    asks: answer.asks.map(ruleAt),
  }
}

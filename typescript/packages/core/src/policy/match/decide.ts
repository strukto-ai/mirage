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

import { fromUnits } from '../../rs/document.ts'
import { admissionMatcher, ruleTable } from '../../rs/policy.ts'
import {
  Outcome,
  type AdmissionRules,
  type CommandContext,
  type CommandRule,
  type Ruling,
} from '../types.ts'
import { commandFacts, reasonOf } from './rule.ts'

/**
 * Where in the document a leaf was written, as a host reads it: the
 * mount section it belongs to, or the top level.
 */
export function sourceOf(rule: CommandRule): string {
  return rule.mount ? `mounts.${rule.mount}` : 'top'
}

/**
 * The profile's answer about one line: the whole law, in one place.
 *
 * Each tree that applies to the line is walked once: the words pick the
 * deepest node with a decision, its options and operands only tighten
 * it, and the strictest decision wins, deny over ask over allow. A
 * mount's tree applies to a line working inside that mount; the
 * top-level tree to every line. Every tree speaks, and the strictest
 * answer is the line's.
 *
 * All of which is settled *per subject*, and only then across them,
 * because a line names more than one path and a leaf written for one of
 * them must not answer for the rest: with `cp: {decision: deny, paths:
 * [/protected/*]}` and `cp: {decision: ask, paths: [/review/*]}`, `cp
 * /protected/secret /review/out` is the source's deny. A line naming no
 * path is judged once, and a leaf with paths says nothing for it.
 *
 * Ranking across subjects is the whole answer for a deny, which refuses
 * the line, and only half of it for an ask, which is a question the host
 * still has to answer. So every ask that spoke for a subject is reported
 * (`Ruling.asks`) and the entry point requires all of them.
 *
 * `PermissionsPolicy` renders this into the outcome table and `explain`
 * reports it, so the two cannot disagree about what a line would do.
 */
export function decide(ctx: CommandContext, rules: AdmissionRules | null): Ruling {
  if (rules === null)
    return {
      outcome: Outcome.ALLOW,
      rule: null,
      matchedPath: null,
      source: '',
      asks: [],
      matched: null,
      reason: '',
    }
  const answer = admissionMatcher(rules).ask('decide', { facts: commandFacts(ctx) }) as {
    readonly outcome: Outcome
    readonly rule: number | null
    readonly matched_path: number[] | null
    readonly asks: readonly number[]
    readonly matched: {
      readonly command: number[][]
      readonly flags: number[][]
      readonly keys: number[][]
    } | null
  }
  const table = ruleTable(rules)
  const ruleAt = (id: number): CommandRule => {
    const rule = table[id]
    if (rule === undefined) throw new Error('Invalid policy rule reply')
    return rule
  }
  const rule = answer.rule === null ? null : ruleAt(answer.rule)
  const matched =
    answer.matched === null
      ? null
      : {
          command: answer.matched.command.map(fromUnits),
          flags: answer.matched.flags.map(fromUnits),
          keys: answer.matched.keys.map(fromUnits),
        }
  return {
    outcome: answer.outcome,
    rule,
    matchedPath: answer.matched_path === null ? null : fromUnits(answer.matched_path),
    source: rule === null ? '' : sourceOf(rule),
    asks: answer.asks.map(ruleAt),
    matched,
    reason: rule === null ? '' : reasonOf(rule, matched),
  }
}

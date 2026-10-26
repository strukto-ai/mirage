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

import { admissionMatcher, fromUnits } from '../../rs/policy.ts'
import {
  Outcome,
  type AdmissionRules,
  type CommandContext,
  type CommandRule,
  type Ruling,
} from '../types.ts'
import { commandFacts } from './rule.ts'

interface RulingReply {
  readonly outcome: Outcome
  readonly rule: number | null
  readonly matched_path: number[] | null
  readonly allow_list: boolean
  readonly asks: readonly number[]
}

/**
 * Where in the document a rule was written, as a host reads it: the
 * mount section it belongs to, or the top level.
 */
export function sourceOf(rule: CommandRule): string {
  return rule.mount ? `mounts.${rule.mount}` : 'top'
}

/**
 * The profile's answer about one line: the whole law, in one place.
 *
 * Two rules, because a command name and a path are not the same kind of
 * thing. A rule naming no path is read by verb, deny before ask,
 * wherever it was written: it is off the path axis entirely, so one in a
 * mount section scores 0 exactly as a top-level one does. Writing it
 * under `mounts./repo` scopes it to lines working inside that mount
 * (the rule reads `rule.mount`); it does not make it more specific
 * than a rule about the whole session. That is what keeps "denied
 * generally, asked inside one mount" inexpressible for a pathless rule,
 * which in practice means an account CLI: such a CLI reaches a service
 * and touches no mount, so scoping it to one was never meaningful.
 *
 * A rule carrying paths is read by anchor depth, the deeper entry
 * winning, ties broken by verb. The depth is the matched entry's, not
 * the rule's deepest, so an entry that says nothing about this operand
 * cannot lend it specificity. The allow list is asked first, since a
 * line no list covers never reaches a rule.
 *
 * All of which is settled *per subject*, and only then across them,
 * because a line names more than one path and a carve-out
 * written for one of them must not answer for the rest: with `deny cp
 * /protected/*` and a deeper `ask cp /review/deep/*`, `cp
 * /protected/secret /review/deep/out` is the source's deny, and reading
 * one best match for the whole line answered it with the destination's
 * ask instead, so a nod meant for the destination carried the protected
 * file out.
 *
 * Ranking across subjects is the whole answer for a deny, which refuses
 * the line, and only half of it for an ask, which is a question the host
 * still has to answer. So every ask that won a subject of its own is
 * reported (`Ruling.asks`) and the entry point requires all of them: with
 * `ask cp /a/*` and a deeper `ask cp /deep/b/*`, `cp /a/x /deep/b/y` used
 * to present the deeper one alone, and a nod for the destination ran the
 * line without the source ever being asked about.
 *
 * `PermissionsPolicy` renders this into the outcome table and `explain`
 * reports it, so the two cannot disagree about what a line would do.
 */
export function decide(ctx: CommandContext, rules: AdmissionRules | null): Ruling {
  if (rules === null)
    return { outcome: Outcome.ALLOW, rule: null, matchedPath: null, source: '', asks: [] }
  const answer = admissionMatcher(rules).ask('decide', { facts: commandFacts(ctx) }) as RulingReply
  const listed = [...rules.deny, ...rules.ask]
  const ruleAt = (id: number): CommandRule => {
    const rule = listed[id]
    if (rule === undefined) throw new Error('Invalid policy rule reply')
    return rule
  }
  const rule = answer.rule === null ? null : ruleAt(answer.rule)
  return {
    outcome: answer.outcome,
    rule,
    matchedPath: answer.matched_path === null ? null : fromUnits(answer.matched_path),
    source: answer.allow_list ? 'commands.allow' : rule === null ? '' : sourceOf(rule),
    asks: answer.asks.map(ruleAt),
  }
}

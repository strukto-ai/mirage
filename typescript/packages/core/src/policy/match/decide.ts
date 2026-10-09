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

import type { Ruling } from '../types.ts'
import { VERB_ORDER } from '../constants.ts'
import {
  Outcome,
  type CommandContext,
  type CommandRule,
  type AdmissionRules,
  type LiveRules,
} from '../types.ts'
import { lineAllowed } from './allow.ts'
import {
  betterMatch,
  matchedOperand,
  ruleApplies,
  ruleReach,
  ruleScope,
  subjects,
  type Subject,
} from './rule.ts'

/**
 * Whether one subject's decision outranks the line's best so far: the
 * stronger verb first, then the deeper anchor.
 *
 * The mirror image of `betterMatch`, and deliberately so. Two rules
 * about *one* subject are a question of specificity, so depth leads
 * there. Two subjects of one line are a question of severity: every path
 * a line names has to survive it, so a deny anywhere refuses the line
 * however deeply another path was carved out.
 */
export function outranks(current: readonly [number, number], verb: number, depth: number): boolean {
  const [bestVerb, bestDepth] = current
  if (verb !== bestVerb) return verb < bestVerb
  return depth > bestDepth
}

/**
 * The rule that speaks about one subject of a line, null when none does:
 * the deepest anchor, deny before ask at equal depth, the earlier rule
 * on a full tie.
 */
export function ruleAt(
  live: LiveRules,
  subject: Subject,
): readonly [Outcome, CommandRule, number] | null {
  let best: [number, number] | null = null
  let chosen: readonly [Outcome, CommandRule, number] | null = null
  for (const [outcome, rule] of live) {
    const depth = ruleReach(rule, ruleScope(rule), subject)
    const verb = VERB_ORDER[outcome] ?? 0
    if (depth === null || !betterMatch(best, depth, verb)) continue
    best = [depth, verb]
    chosen = [outcome, rule, depth]
  }
  return chosen
}

/**
 * Where in the document a rule was written, as a host reads it: the
 * mount section it belongs to, or the top level.
 */
export function sourceOf(rule: CommandRule): string {
  return (rule.mount ?? '') !== '' ? `mounts.${rule.mount ?? ''}` : 'top'
}

/**
 * The profile's answer about one line: the whole law, in one place.
 *
 * Two rules, because a command name and a path are not the same kind of
 * thing. A rule naming no path is read by verb, deny before ask,
 * wherever it was written: it is off the path axis entirely, so one in a
 * mount section scores 0 exactly as a top-level one does. Writing it
 * under `mounts./repo` scopes it to lines working inside that mount
 * (`ruleApplies` reads `rule.mount`); it does not make it more specific
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
 * All of which is settled *per subject*, and only then across them
 * (`outranks`), because a line names more than one path and a carve-out
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
  if (rules === null) {
    return { outcome: Outcome.ALLOW, rule: null, matchedPath: null, source: '', asks: [] }
  }
  if (!lineAllowed(ctx, rules)) {
    return {
      outcome: Outcome.DENY,
      rule: null,
      matchedPath: null,
      source: 'commands.allow',
      asks: [],
    }
  }
  const live: (readonly [Outcome, CommandRule])[] = []
  for (const [outcome, written] of [
    [Outcome.DENY, rules.deny],
    [Outcome.ASK, rules.ask],
  ] as const) {
    for (const rule of written) {
      if (ruleApplies(rule, ctx)) live.push([outcome, rule])
    }
  }
  let best: [number, number] | null = null
  let chosen: Ruling = {
    outcome: Outcome.ALLOW,
    rule: null,
    matchedPath: null,
    source: '',
    asks: [],
  }
  const asked: CommandRule[] = []
  for (const subject of subjects(ctx)) {
    const spoke = ruleAt(live, subject)
    if (spoke === null) continue
    const [outcome, rule, depth] = spoke
    if (outcome === Outcome.ASK && !asked.includes(rule)) asked.push(rule)
    const verb = VERB_ORDER[outcome] ?? 0
    if (best !== null && !outranks(best, verb, depth)) continue
    best = [verb, depth]
    chosen = {
      outcome,
      rule,
      matchedPath: matchedOperand(rule, subject),
      source: sourceOf(rule),
      asks: [],
    }
  }
  if (chosen.outcome !== Outcome.ASK) return chosen
  return { ...chosen, asks: asked }
}

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

import type { HiddenPaths, PathSpec } from '../../types.ts'
import { anchorDepth, classifyPaths, pathCovers, pathHidden } from '../../utils/hidden.ts'
import {
  ASK_SECOND,
  DENY_FIRST,
  METADATA_OPS,
  SUBTREE_COMMANDS,
  SUBTREE_OPS,
} from '../constants.ts'
import type { CommandContext, CommandRule, AdmissionRules, OpsContext } from '../types.ts'
import { lineTokens } from './allow.ts'
import { patternMatches } from './pattern.ts'

/**
 * Whether a match beats the best one so far: deeper anchor first, then
 * the stronger verb, then the earlier rule (which is why this is
 * strict).
 *
 * Shared by `decide` and `ioRefusal` so a line and the entries it
 * reaches mid-walk are read by one law.
 */
export function betterMatch(
  current: readonly [number, number] | null,
  depth: number,
  verb: number,
): boolean {
  if (current === null) return true
  const [bestDepth, bestVerb] = current
  if (depth !== bestDepth) return depth > bestDepth
  return verb < bestVerb
}

/**
 * A rule that applies to a line, and how far it reaches. `matchRule`
 * returns null when the rule does not apply, `{operand: null}` when the
 * rule refuses (or asks about) the whole line, and the operand as typed
 * when the rule is path-scoped and one operand fell under its paths, so
 * the refusal is scoped to that operand (`rm: x: <reason>`, exit 1)
 * rather than to the command (`rm: Permission denied`, 126).
 */
export interface RuleMatch {
  operand: string | null
  /**
   * The anchor depth of the deepest entry that actually covered the
   * operand, which is what the path axis orders by. Scoring the rule's
   * deepest entry instead would lend an unrelated entry's depth to this
   * match: an ask on `/repo/*` and `/else/very/deep/*` would outrank a
   * deny anchored at `/repo/private/*` and reopen it. 0 when the rule
   * names no paths, which is off the path axis entirely.
   */
  depth: number
}

/**
 * One thing a line's rules are read against.
 *
 * A line is judged subject by subject, because the paths a command names
 * are not one question: `cp /sealed/x /wip/y` reads one file and writes
 * another, and a nod for the destination says nothing about the source.
 */
export interface Subject {
  /**
   * The path, null for the line itself, which is the only subject of a
   * line naming no path and is reached only by a rule naming no paths.
   */
  readonly path: PathSpec | null
  /**
   * Whether this subject would take a whole subtree along (`rm -r /x`,
   * `mv /x /y`), so a rule anchored below it speaks about it.
   */
  readonly holds: boolean
  /**
   * Whether an ancestor of the rule's scope counts as holding it; false
   * for `mv`'s destination, which lands in the scope only when it is
   * that directory itself.
   */
  readonly ancestors: boolean
}

/**
 * What a line's rules are read against, in the order they are read.
 *
 * Every path the line names first, each asked whether it lies inside a
 * rule's scope; then the operands of a subtree command, asked the second
 * question, whether they hold one. The two orders together are what a
 * single rule sees, so the first subject a rule reaches is the operand
 * its refusal names. A line naming no path is one subject, itself.
 */
export function subjects(ctx: CommandContext): readonly Subject[] {
  if (ctx.paths.length === 0) return [{ path: null, holds: false, ancestors: true }]
  const subs: Subject[] = ctx.paths.map((p) => ({ path: p, holds: false, ancestors: true }))
  if (SUBTREE_COMMANDS.has(ctx.command)) {
    const operands = [...(ctx.operands ?? [])]
    const dst = ctx.command === 'mv' && operands.length > 1 ? operands.pop() : undefined
    for (const p of operands) subs.push({ path: p, holds: true, ancestors: true })
    if (dst !== undefined) subs.push({ path: dst, holds: true, ancestors: false })
  }
  return subs
}

function under(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(root + '/')
}

// Whether a line works inside a mount: its cwd is under the root, one
// of its paths is, or the command walks a directory holding the root
// (`grep -r x /scratch` enters `/scratch/child`: the fan-out reruns the
// traversal inside each descendant mount and no admission fires again
// there, so the ancestor operand is the one place the mount's rule can
// speak).
function touches(mount: string, ctx: CommandContext): boolean {
  if (under(ctx.cwd, mount)) return true
  if (ctx.paths.some((p) => under(p.virtual, mount))) return true
  return (ctx.walks ?? false) && ctx.paths.some((p) => under(mount, p.virtual))
}

/**
 * Whether a rule speaks about a line at all, before any of the line's
 * subjects is read. Two questions: the rule's command patterns (a prefix
 * of the line's tokens; none means every command), and the rule's mount
 * (a rule written under a mount section applies only to a line working
 * inside it).
 */
export function ruleApplies(rule: CommandRule, ctx: CommandContext): boolean {
  const commands = rule.commands ?? []
  if (commands.length > 0) {
    const tokens = lineTokens(ctx)
    if (!commands.some((p) => patternMatches(p, tokens))) return false
  }
  return rule.mount === undefined || rule.mount === '' || touches(rule.mount, ctx)
}

/**
 * How deep a rule reaches at one subject of a line, null when it says
 * nothing about that subject.
 *
 * A rule naming no paths reaches every subject at depth 0: it is off the
 * path axis, so any entry naming a place outranks it. A rule carrying
 * paths reaches a subject lying inside them, or, for a subtree operand,
 * one holding them (`rm -r /x` takes `/x/locked/*` along, and `mv`'s
 * destination lands in the scope only when it is that directory itself).
 * The depth is the deepest entry that actually reached, never the rule's
 * deepest entry.
 */
export function ruleReach(
  rule: CommandRule,
  scope: HiddenPaths | null,
  subject: Subject,
): number | null {
  if (scope === null) return 0
  if (subject.path === null) return null
  const virtual = subject.path.virtual
  if (pathHidden(scope, virtual)) return hiddenDepth(rule, virtual)
  if (subject.holds && pathCovers(scope, virtual, subject.ancestors)) {
    return coversDepth(rule, virtual, subject.ancestors)
  }
  return null
}

/**
 * The operand a rule's refusal names, as typed: the subject it reached,
 * or null when the rule names no paths and so refuses the whole line.
 */
export function matchedOperand(rule: CommandRule, subject: Subject): string | null {
  if ((rule.paths ?? []).length === 0 || subject.path === null) return null
  return subject.path.rawPath || subject.path.virtual
}

/**
 * Whether one rule applies to a line, and to which operand: the first
 * subject it reaches, which is what a single rule read as a policy of
 * its own has to answer.
 *
 * `decide` does not use this, because a line is more than its first
 * match: it reads every rule at every subject (`subjects`, `ruleReach`)
 * so one operand's ask cannot speak for another operand's deny.
 */
export function matchRule(
  rule: CommandRule,
  scope: HiddenPaths | null,
  ctx: CommandContext,
): RuleMatch | null {
  if (!ruleApplies(rule, ctx)) return null
  for (const subject of subjects(ctx)) {
    const depth = ruleReach(rule, scope, subject)
    if (depth === null) continue
    return { operand: matchedOperand(rule, subject), depth }
  }
  return null
}

const entryScopes = new Map<string, HiddenPaths | null>()

/**
 * One document entry, classified alone so it can be scored on its own;
 * remembered, since a rule is re-read on every line.
 */
function entryScope(entry: string): HiddenPaths | null {
  const known = entryScopes.get(entry)
  if (known !== undefined) return known
  const scope = classifyPaths([entry])
  entryScopes.set(entry, scope)
  return scope
}

/**
 * The anchor depth of the deepest entry of a rule that holds this path,
 * 0 when none does.
 */
export function hiddenDepth(rule: CommandRule, virtual: string): number {
  let best = 0
  for (const entry of rule.paths ?? []) {
    if (pathHidden(entryScope(entry), virtual)) best = Math.max(best, anchorDepth(entry))
  }
  return best
}

/**
 * The anchor depth of the deepest entry of a rule that sits at or under
 * this path, 0 when none does. The subtree counterpart of
 * `hiddenDepth`, for an operand that would take the scope along rather
 * than lie inside it.
 */
export function coversDepth(rule: CommandRule, virtual: string, ancestors = true): number {
  let best = 0
  for (const entry of rule.paths ?? []) {
    if (pathCovers(entryScope(entry), virtual, ancestors)) best = Math.max(best, anchorDepth(entry))
  }
  return best
}

/**
 * The anchor depth at which a rule reaches an op, null when it does not
 * reach it at all.
 *
 * Only a pure path rule can, since an op does not know which command
 * issued it. The op's path is tested against the scope, and an op that
 * moves or removes a whole subtree (SUBTREE_OPS) is also reached on the
 * directory holding the scope or on any ancestor, since it would take
 * the scope along. A metadata op (METADATA_OPS) is reached by nothing:
 * deny is present and refused, so the entry stats and its content is
 * what the door withholds.
 *
 * The op-door twin of `ruleReach`, and the same shape: the depth is the
 * one the arm that matched measures, so a rule cannot lend an operand
 * specificity from an entry that said nothing about it.
 */
export function opReach(
  rule: CommandRule,
  scope: HiddenPaths | null,
  ctx: OpsContext,
): number | null {
  if ((rule.commands ?? []).length > 0 || scope === null || METADATA_OPS.has(ctx.op)) return null
  const virtual = ctx.path.virtual
  if (pathHidden(scope, virtual)) return hiddenDepth(rule, virtual)
  if (SUBTREE_OPS.has(ctx.op) && pathCovers(scope, virtual)) return coversDepth(rule, virtual)
  return null
}

/** Whether a rule refuses an op. The boolean case of `opReach`. */
export function matchOp(rule: CommandRule, scope: HiddenPaths | null, ctx: OpsContext): boolean {
  return opReach(rule, scope, ctx) !== null
}

/**
 * The reason an op may not run, null when it may.
 *
 * The op-door twin of `ioRefusal`, and the same law: anchor depth first,
 * deny before ask at equal depth, and an ask satisfied by a grant the
 * line already holds. Reading every deny before any ask instead let a
 * broad deny on `/repo/*` overrule an approved ask on `/repo/outbox/*`,
 * so the carve-out the command door had just admitted the line under
 * could not authorize the redirect it was written for: the write reached
 * this door and was refused there.
 *
 * An op reached with no admitted command behind it (FUSE, the cache, the
 * host's own facade) holds no grant, so an ask that wins here is a
 * refusal like a deny: there is no line to ask about and this door
 * cannot wait on a host.
 */
export function opRefusal(
  rules: AdmissionRules | null,
  ctx: OpsContext,
  granted: readonly CommandRule[],
): string | null {
  if (rules === null) return null
  let best: [number, number] | null = null
  let chosen: { rule: CommandRule; verb: number } | null = null
  for (const [verb, written] of [
    [DENY_FIRST, rules.deny],
    [ASK_SECOND, rules.ask],
  ] as const) {
    for (const rule of written) {
      const depth = opReach(rule, ruleScope(rule), ctx)
      if (depth === null || !betterMatch(best, depth, verb)) continue
      best = [depth, verb]
      chosen = { rule, verb }
    }
  }
  if (chosen === null) return null
  if (chosen.verb === ASK_SECOND && granted.includes(chosen.rule)) return null
  return chosen.rule.reason
}

const scopes = new WeakMap<CommandRule, HiddenPaths | null>()

/**
 * A rule's paths, classified once and remembered: null when the rule
 * names none, so a caller can tell a whole-line rule from a path-scoped
 * one without re-reading the document grammar.
 */
export function ruleScope(rule: CommandRule): HiddenPaths | null {
  const known = scopes.get(rule)
  if (known !== undefined) return known
  const scope = classifyPaths(rule.paths ?? [])
  scopes.set(rule, scope)
  return scope
}

/**
 * Whether a rule reaches an entry a command touches on its own, below
 * its operands: the rule names the line (its command patterns against
 * the line's tokens, none meaning every command) and its paths hold the
 * entry. A rule with no paths spoke about the whole line at admission
 * and has nothing to add at an entry; the directory holding a scope is
 * not in it, so a listing still shows a refused entry's name, which is
 * what deny means: present, and refused.
 */
export function matchIo(
  rule: CommandRule,
  scope: HiddenPaths | null,
  tokens: readonly string[],
  virtual: string,
): boolean {
  if (scope === null) return false
  const commands = rule.commands ?? []
  if (commands.length > 0 && !commands.some((p) => patternMatches(p, tokens))) return false
  return pathHidden(scope, virtual)
}

/**
 * The reason a command may not touch an entry it reached on its own,
 * null when it may.
 *
 * The same law the admission gate applies to a line, and literally the
 * same comparison (`betterMatch`): anchor depth first, deny before ask
 * at equal depth. Reading every deny before any ask instead would let a
 * broad deny on `/repo/*` overrule an approved ask on `/repo/sealed/*`
 * that the gate had just admitted the line under, so the carve-out
 * would survive admission and then refuse every entry it was written
 * for.
 *
 * The winning rule then answers: a deny refuses, an ask refuses unless
 * the line holds a grant under it (the nod the gate took for `rm -r /x`
 * covers the entries under `/x`; a walk that wanders into an asked
 * scope from outside gets no nod mid-command, so it is refused and the
 * agent names the path to be asked).
 */
export function ioRefusal(
  rules: AdmissionRules | null,
  tokens: readonly string[],
  virtual: string,
  granted: readonly CommandRule[],
): string | null {
  if (rules === null) return null
  let best: [number, number] | null = null
  let chosen: { rule: CommandRule; verb: number } | null = null
  for (const [verb, written] of [
    [DENY_FIRST, rules.deny],
    [ASK_SECOND, rules.ask],
  ] as const) {
    for (const rule of written) {
      if (!matchIo(rule, ruleScope(rule), tokens, virtual)) continue
      const depth = hiddenDepth(rule, virtual)
      if (!betterMatch(best, depth, verb)) continue
      best = [depth, verb]
      chosen = { rule, verb }
    }
  }
  if (chosen === null) return null
  if (chosen.verb === ASK_SECOND && granted.includes(chosen.rule)) return null
  return chosen.rule.reason
}

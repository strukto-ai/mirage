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

import type { util } from 'zod'
import { FlagView, SPECS, parseCommand } from '../../commands/spec/index.ts'
import { parseToKwargs } from '../../commands/spec/parser.ts'
import { WordKind } from '../../commands/spec/types.ts'
import { admissionMatcher, units } from '../../rs/policy.ts'
import type { PathSpec } from '../../types.ts'
import { METADATA_OPS, SUBTREE_COMMANDS, SUBTREE_OPS } from '../constants.ts'
import { sameRule } from '../decisions.ts'
import type { AdmissionRules, CommandContext, CommandRule, VfsContext } from '../types.ts'
import { lineTokens } from './allow.ts'

/**
 * The paths a command's operands name, in order: what `rm -r` removes or
 * `mv`, `tar` and `cp` take as sources, never an option's value. Mirrors
 * Python's `operand_paths`.
 */
export function operandPaths(ctx: CommandContext): PathSpec[] {
  return (ctx.words ?? []).flatMap((word) =>
    word.kind === WordKind.OPERAND && word.path !== null ? [word.path] : [],
  )
}
export function targetDirectory(ctx: CommandContext): string | null {
  const spec = SPECS.mv
  if (spec === undefined) return null
  return (
    new FlagView(parseToKwargs(parseCommand(spec, [...ctx.argv], ctx.cwd, 'mv')), spec).asStr(
      'target_directory',
    ) ?? null
  )
}
function pathFact(path: PathSpec): Record<string, util.JSONType> {
  return { virtual_path: units(path.virtual), display_path: units(path.rawPath || path.virtual) }
}
/**
 * What a line's rules are read against, in the stream's wire shape: its
 * tokens and paths, and the host's word on its command, a subtree command
 * (`SUBTREE_COMMANDS`) or a move whose last operand is the destination.
 * Mirrors Python's command_facts.
 */
export function commandFacts(ctx: CommandContext): Record<string, util.JSONType> {
  const moves = ctx.command === 'mv'
  const target = moves && ctx.paths.length > 0 ? targetDirectory(ctx) : null
  return {
    tokens: lineTokens(ctx).map(units),
    tool: ctx.tool ?? true,
    cwd: units(ctx.cwd),
    paths: ctx.paths.map(pathFact),
    operands: operandPaths(ctx).map(pathFact),
    walks: ctx.walks ?? false,
    subtree: SUBTREE_COMMANDS.has(ctx.command),
    moves,
    move_target: target === null ? null : units(target),
  }
}
/**
 * Whether a rule holds at a dispatcher too: a pure path rule, which names
 * no command and has paths to match, the one kind an op can meet. The
 * sort of a profile's rules: a POSIX-level rule holds at every entry point, a
 * command-level one (it names a command, or no path) only where a line
 * is judged.
 */
export function posixLevel(rule: CommandRule): boolean {
  return (
    admissionMatcher({ allow: null, deny: [rule], ask: [] }).ask('posix_level', {
      rule: 0,
    }) === true
  )
}
/**
 * The command-level parts of a profile's rules, which an entry point that sees
 * only ops (a kernel mount, SFTP, codex-exec's file calls) cannot apply,
 * each described for the operator's warning: the allow list and every
 * rule that is not POSIX level.
 */
export function skippedAtDispatch(rules: AdmissionRules | null): string[] {
  if (rules === null) return []
  const skipped = rules.allow === null ? [] : ['commands.allow']
  for (const [verb, listed] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
  ] as const)
    for (const rule of listed)
      if (!posixLevel(rule)) skipped.push(`commands.${verb}: ${rule.reason}`)
  return skipped
}
/**
 * Whether a rule in force could reach an entry at or under this path for
 * the running line: the rule names the line and its paths, or a mount
 * rule's mount, could cover something in the subtree. What a native walk asks before it trusts the
 * raw tree, per operand the way a hide is: a rule on `/repo/.env` leaves
 * `find /s3` its native op.
 */
export function ioReach(
  rules: AdmissionRules | null,
  tokens: readonly string[],
  virtual: string,
): boolean {
  return (
    rules !== null &&
    admissionMatcher(rules).ask('io_reach', {
      tokens: tokens.map(units),
      path: units(virtual),
    }) === true
  )
}
function grantIndices(rules: AdmissionRules, granted: readonly CommandRule[]): number[] {
  if (granted.length === 0) return []
  return [...rules.deny, ...rules.ask].flatMap((rule, id) =>
    granted.some((nod) => sameRule(nod, rule)) ? [id] : [],
  )
}
function ruleAt(rules: AdmissionRules, id: number): CommandRule {
  const rule = [...rules.deny, ...rules.ask][id]
  if (rule === undefined) throw new Error('Invalid policy rule reply')
  return rule
}
/**
 * The reason a command may not touch an entry it reached on its own,
 * null when it may.
 *
 * The same law the admission gate applies to a line, and literally the
 * same loop (`ruleAt`): anchor depth first, deny before ask
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
  const id = admissionMatcher(rules).ask('io_refusal', {
    tokens: tokens.map(units),
    path: units(virtual),
    granted: grantIndices(rules, granted),
  }) as number | null
  return id === null ? null : ruleAt(rules, id).reason
}
/**
 * The rule an op meets and whether it asks, null when the op may run.
 *
 * The dispatcher twin of `ioRefusal`, and the same law: anchor depth first,
 * deny before ask at equal depth, and an ask satisfied by a grant the
 * line already holds. Reading every deny before any ask instead let a
 * broad deny on `/repo/*` overrule an approved ask on `/repo/outbox/*`,
 * so the carve-out command admission had just admitted the line under
 * could not authorize the redirect it was written for: the write reached
 * the dispatcher and was refused there.
 *
 * What an ask means is the entry point's to say: inside a running line it
 * refuses like a deny, since the line was admitted without it, and
 * outside one (a file tool, the host's facade) it goes to the approval
 * ledger, keyed by rule and path. Mirrors Python's `op_ruling`.
 */
export function opRuling(
  rules: AdmissionRules | null,
  ctx: VfsContext,
  granted: readonly CommandRule[],
): [CommandRule, boolean] | null {
  if (rules === null || METADATA_OPS.has(ctx.call.name)) return null
  const answer = admissionMatcher(rules).ask('op_ruling', {
    subtree: SUBTREE_OPS.has(ctx.call.name),
    path: units(ctx.path.virtual),
    granted: grantIndices(rules, granted),
  }) as [number, boolean] | null
  return answer === null ? null : [ruleAt(rules, answer[0]), answer[1]]
}

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
import { WordKind } from '../../commands/spec/types.ts'
import { units } from '../../rs/document.ts'
import { admissionMatcher, Encoded, ruleTable } from '../../rs/policy.ts'
import type { Matched, PathSpec } from '../../types.ts'
import { DEFAULT_DENY_REASON } from '../constants.ts'
import { sameRule } from '../decisions.ts'
import {
  Outcome,
  type AdmissionRules,
  type CommandContext,
  type CommandRead,
  type CommandRule,
} from '../types.ts'
import { lineTokens } from './allow.ts'

/**
 * The reason a refusal gives when nothing wrote one: the words that
 * fired, `rm --recursive is not allowed`.
 */
export function notAllowed(words: readonly string[]): string {
  return `${words.join(' ')} is not allowed`
}

/**
 * Why a leaf refuses or asks: the reason written on it, else, for a deny,
 * the command path, options and keys that fired (`rm --recursive is not
 * allowed`, `echo secret* is not allowed`), else the default. `matched`
 * is null when what fired is unknown.
 */
export function reasonOf(rule: CommandRule, matched: Matched | null): string {
  if (rule.reason !== '') return rule.reason
  if (rule.decision === Outcome.DENY && matched !== null) {
    return notAllowed([...matched.command, ...matched.flags, ...matched.keys])
  }
  return DEFAULT_DENY_REASON
}

/**
 * The paths a command's operands name, in order: what `rm -r` removes or
 * `mv`, `tar` and `cp` take as sources, never an option's value.
 * Mirrors Python's `operand_paths`.
 */
export function operandPaths(ctx: CommandContext): PathSpec[] {
  return (ctx.words ?? []).flatMap((word) =>
    word.kind === WordKind.OPERAND && word.path !== null ? [word.path] : [],
  )
}

function pathFact(path: PathSpec): Record<string, util.JSONType> {
  return { virtual_path: units(path.virtual) }
}

/** A line's read in the stream's wire shape. Mirrors Python's read_wire. */
export function readWire(read: CommandRead): Record<string, util.JSONType> {
  return {
    path: read.path.map(units),
    flags: read.flags.map((flag) => ({ name: units(flag.name), values: flag.values.map(units) })),
    operands: read.operands.map(units),
  }
}

/**
 * What a tree walks, in the stream's wire shape: the line's read when
 * its grammar read it, else its tokens, and whether a tool runs it (a
 * shell function is no tool). A read already holds every word, so the
 * tokens are not sent beside it. Mirrors Python's line_words.
 */
export function lineWords(ctx: CommandContext): Record<string, util.JSONType> {
  const read = ctx.read ?? null
  return {
    tokens: read === null ? lineTokens(ctx).map(units) : [],
    line: read === null ? null : readWire(read),
    tool: ctx.tool ?? true,
  }
}

/**
 * What a line's trees are judged on, in the stream's wire shape: its
 * words (`lineWords`) and paths, and the host's word on its command:
 * the mounts a walk enters (`CommandContext.walksInto`), whether it moves
 * or removes whole subtrees (`CommandContext.subtree`) and whether it is a
 * move whose last operand is the destination.
 * Mirrors Python's command_facts.
 */
export function commandFacts(ctx: CommandContext): Record<string, util.JSONType> {
  const moves = ctx.command === 'mv'
  const target = moves && ctx.paths.length > 0 ? (ctx.moveTarget ?? null) : null
  return {
    ...lineWords(ctx),
    cwd: units(ctx.cwd),
    paths: ctx.paths.map(pathFact),
    operands: operandPaths(ctx).map(pathFact),
    walks: ctx.walks ?? false,
    walks_into: (ctx.walksInto ?? []).map(units),
    subtree: ctx.subtree ?? false,
    moves,
    move_target: target === null ? null : units(target),
  }
}

interface Walked {
  readonly branches: readonly unknown[]
}

/**
 * The running line's walk through every tree, which each entry its
 * command reaches is judged under; null when no leaf speaks for the
 * line. Asked once per line, since an entry changes the path and never
 * the line. Mirrors Python's naming_rules.
 */
export function namingRules(rules: AdmissionRules | null, ctx: CommandContext): Encoded | null {
  if (rules === null) return null
  const walked = admissionMatcher(rules).ask('naming_rules', lineWords(ctx)) as readonly Walked[]
  if (!walked.some((w) => w.branches.length > 0)) return null
  return new Encoded(JSON.stringify(walked))
}

function grantedIndices(rules: AdmissionRules, granted: readonly CommandRule[]): number[] {
  return ruleTable(rules).flatMap((rule, i) =>
    granted.some((nod) => sameRule(nod, rule)) ? [i] : [],
  )
}

/**
 * Whether a leaf the running line walked could refuse an entry at or
 * under this path: its folder entry lies in the subtree, or holds it.
 * What a native walk asks before it trusts the raw tree, per operand the
 * way a hide is: a folder entry for `/repo/private` leaves `find /s3` its
 * native op. An ask the line holds a grant for refuses no entry
 * (`ioRefusal`), so it reaches none: `rm -rf /x` approved under
 * `mounts: {/x: {commands: {rm: ask}}}` keeps the backend's one-call
 * removal. `named` is the line's walk (`namingRules`).
 */
export function ioReach(
  rules: AdmissionRules | null,
  named: Encoded | null,
  virtual: string,
  granted: readonly CommandRule[] = [],
): boolean {
  return (
    rules !== null &&
    named !== null &&
    admissionMatcher(rules).ask('io_reach', {
      walked: named,
      path: units(virtual),
      granted: grantedIndices(rules, granted),
    }) === true
  )
}

/**
 * The reason a command may not touch an entry it reached on its own,
 * null when it may.
 *
 * The entry is judged by the walk the gate judged the line on: the
 * strictest leaf over every folder entry's tree whose folder holds it. A deny refuses; an ask refuses unless the line holds a grant
 * under it (the nod the gate took for `rm -r /x` covers the entries
 * under `/x`; a walk that wanders into an asked scope from outside gets
 * no nod mid-command, so it is refused and the agent names the path to
 * be asked). `named` is the line's walk (`namingRules`).
 */
export function ioRefusal(
  rules: AdmissionRules | null,
  named: Encoded | null,
  virtual: string,
  granted: readonly CommandRule[],
): string | null {
  if (rules === null || named === null) return null
  const id = admissionMatcher(rules).ask('io_refusal', {
    walked: named,
    path: units(virtual),
    granted: grantedIndices(rules, granted),
  }) as number | null
  if (id === null) return null
  const rule = ruleTable(rules)[id]
  if (rule === undefined) throw new Error('Invalid policy rule reply')
  return reasonOf(rule, null)
}

/**
 * The command trees an entry point that sees only ops (a kernel mount,
 * SFTP, codex-exec's file calls) cannot apply, each named for the
 * operator's warning: every tree, since a tree judges lines.
 */
export function skippedAtDispatch(rules: AdmissionRules | null): string[] {
  if (rules === null) return []
  return rules.trees.map((scoped) =>
    scoped.mount ? `mounts.${scoped.mount}.commands` : 'commands',
  )
}

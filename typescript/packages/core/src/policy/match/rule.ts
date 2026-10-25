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

import { FlagView, SPECS, parseCommand } from '../../commands/spec/index.ts'
import { parseToKwargs } from '../../commands/spec/parser.ts'
import { WordKind } from '../../commands/spec/types.ts'
import {
  admissionMatcher,
  policySubjects,
  ruleMatcher,
  type PolicyFacts,
  type PolicyPath,
} from '../../rs/policy.ts'
import type { HiddenPaths, PathSpec } from '../../types.ts'
import { classifyPaths } from '../../utils/hidden.ts'
import type { AdmissionRules, CommandContext, CommandRule, VfsContext } from '../types.ts'
import { lineTokens } from './allow.ts'

export interface Subject {
  readonly path: PathSpec | null
  readonly holds: boolean
  readonly ancestors: boolean
}

export function operandPaths(ctx: CommandContext): PathSpec[] {
  return (ctx.words ?? []).flatMap((word) =>
    word.kind === WordKind.OPERAND && word.path !== null ? [word.path] : [],
  )
}
function targetDirectory(ctx: CommandContext): string | null {
  const spec = SPECS.mv
  if (ctx.command !== 'mv' || ctx.paths.length === 0 || spec === undefined) return null
  return (
    new FlagView(parseToKwargs(parseCommand(spec, [...ctx.argv], ctx.cwd, 'mv')), spec).asStr(
      'target_directory',
    ) ?? null
  )
}
function pathFact(path: PathSpec): PolicyPath {
  return { virtual: path.virtual, display: path.rawPath || path.virtual }
}
export function commandFacts(ctx: CommandContext): PolicyFacts {
  return {
    command: ctx.command,
    tokens: lineTokens(ctx),
    tool: ctx.tool ?? true,
    cwd: ctx.cwd,
    paths: ctx.paths.map(pathFact),
    operands: operandPaths(ctx).map(pathFact),
    walks: ctx.walks ?? false,
    moveTarget: targetDirectory(ctx),
  }
}
export function subjects(ctx: CommandContext): readonly Subject[] {
  const paths = [...ctx.paths, ...operandPaths(ctx)]
  return policySubjects(commandFacts(ctx)).map((subject): Subject => {
    if (subject.path === null) return { ...subject, path: null }
    const fact = subject.path
    const path = paths.find(
      (path) => path.virtual === fact.virtual && (path.rawPath || path.virtual) === fact.display,
    )
    if (path === undefined) throw new Error('Invalid policy subject reply')
    return { path, holds: subject.holds, ancestors: subject.ancestors }
  })
}
export function ruleApplies(rule: CommandRule, ctx: CommandContext): boolean {
  return ruleMatcher(rule).ruleApplies(0, commandFacts(ctx))
}
export function ruleReach(
  rule: CommandRule,
  _scope: HiddenPaths | null,
  subject: Subject,
): number | null {
  return ruleMatcher(rule).ruleReach(0, {
    ...subject,
    path: subject.path === null ? null : pathFact(subject.path),
  })
}
export function hiddenDepth(rule: CommandRule, virtual: string): number {
  return ruleMatcher(rule).hiddenDepth(0, virtual)
}
export function coversDepth(rule: CommandRule, virtual: string, ancestors = true): number {
  return ruleMatcher(rule).coversDepth(0, virtual, ancestors)
}
const scopes = new WeakMap<CommandRule, HiddenPaths | null>()
export function ruleScope(rule: CommandRule): HiddenPaths | null {
  if (scopes.has(rule)) return scopes.get(rule) ?? null
  const scope = classifyPaths(rule.paths ?? [])
  scopes.set(rule, scope)
  return scope
}
export function matchIo(
  rule: CommandRule,
  _scope: HiddenPaths | null,
  tokens: readonly string[],
  virtual: string,
  subtree = false,
): boolean {
  return ruleMatcher(rule).matchIo(0, tokens, virtual, subtree)
}
export function posixLevel(rule: CommandRule): boolean {
  return ruleMatcher(rule).posixLevel(0)
}
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
export function ioReach(
  rules: AdmissionRules | null,
  tokens: readonly string[],
  virtual: string,
): boolean {
  return rules !== null && admissionMatcher(rules).ioReach(tokens, virtual)
}
function grantIndices(rules: AdmissionRules, granted: readonly CommandRule[]): number[] {
  return [...rules.deny, ...rules.ask].flatMap((rule, id) => (granted.includes(rule) ? [id] : []))
}
export function ioRefusal(
  rules: AdmissionRules | null,
  tokens: readonly string[],
  virtual: string,
  granted: readonly CommandRule[],
): string | null {
  if (rules === null) return null
  const id = admissionMatcher(rules).ioRefusal(tokens, virtual, grantIndices(rules, granted))
  if (id === null) return null
  const rule = [...rules.deny, ...rules.ask][id]
  if (rule === undefined) throw new Error('Invalid policy rule reply')
  return rule.reason
}
export function opReach(
  rule: CommandRule,
  _scope: HiddenPaths | null,
  ctx: VfsContext,
): number | null {
  return ruleMatcher(rule).opReach(0, ctx.call.name, ctx.path.virtual)
}
export function opRuling(
  rules: AdmissionRules | null,
  ctx: VfsContext,
  granted: readonly CommandRule[],
): [CommandRule, boolean] | null {
  if (rules === null) return null
  const answer = admissionMatcher(rules).opRuling(
    ctx.call.name,
    ctx.path.virtual,
    grantIndices(rules, granted),
  )
  if (answer === null) return null
  const rule = [...rules.deny, ...rules.ask][answer[0]]
  if (rule === undefined) throw new Error('Invalid policy rule reply')
  return [rule, answer[1]]
}

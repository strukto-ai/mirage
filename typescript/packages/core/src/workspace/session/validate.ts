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

import { SPECS } from '../../commands/spec/index.ts'
import { PolicyError } from '../../policy/errors.ts'
import { headAllowed } from '../../policy/match/allow.ts'
import { allowPatterns, patternProblem, STAR } from '../../policy/match/grammar.ts'
import { expandPattern, splitPattern } from '../../policy/match/pattern.ts'
import type { AdmissionRules, CommandRule, Grammar } from '../../policy/types.ts'

/** Opt in by assigning a warning sink, as Python's module logger warns. */
export const logger: { warn?: (message: string) => void } = {}

export const BUILTIN_GRAMMARS: ReadonlyMap<string, Grammar> = new Map(
  Object.entries(SPECS).map(([name, spec]) => [name, { spec, tree: false, passthrough: false }]),
)

/** Written patterns with each `{a,b}` group expanded, in order. */
export function expanded(patterns: readonly string[]): string[] {
  return patterns.flatMap((written) => expandPattern(written))
}

/** The command name a pattern starts with, empty for a bare wildcard. */
function head(pattern: string): string {
  const token = splitPattern(pattern)[0] ?? ''
  return token === '*' ? '' : token
}

/**
 * Whether a deny pattern matches every line an ask pattern does.
 *
 * A pattern is a token prefix, so a shorter deny covers a longer ask
 * (`git` covers `git push`) and a `*` token in the deny covers whatever
 * the ask names there. The reverse never holds.
 */
function coversPattern(deny: string, ask: string): boolean {
  const want = splitPattern(deny)
  const have = splitPattern(ask)
  if (want.length > have.length) return false
  return want.every((w, i) => w === '*' || w === have[i])
}

/**
 * Whether a deny rule refuses every line an ask rule asks about.
 *
 * Three things have to hold, and each is the reason for one arm. The
 * deny must name no paths, or the ask still fires on the operands the
 * deny leaves alone. It must be written at the same anchor, which is
 * where deny beats ask unconditionally; across anchors the deeper rule
 * leads and which one that is depends on the line, so this reports
 * nothing rather than guess (a top-level deny does shadow a mount-scoped
 * ask on the same command, and is deliberately left to the run). And
 * every command the ask names must be covered by one of its patterns,
 * since an ask naming a command the deny misses still has work to do.
 */
function shadowed(ask: CommandRule, deny: CommandRule): boolean {
  if ((deny.paths ?? []).length > 0) return false
  if ((deny.mount ?? '') !== (ask.mount ?? '')) return false
  const denyCommands = deny.commands ?? []
  const askCommands = ask.commands ?? []
  if (denyCommands.length === 0) return true
  if (askCommands.length === 0) return false
  return expanded(askCommands).every((a) => expanded(denyCommands).some((d) => coversPattern(d, a)))
}

/**
 * The first rule naming a builtin the allow list never allows.
 *
 * A rule on a command the allow list leaves out reads as a guard and is
 * not one: the allow list refuses the command first, so nothing reaches
 * the rule and the operator is protected only in the document. Only a name this repo
 * ships a spec for is judged, because any other word may be a CLI the
 * host registers after the workspace is built, which `checkCliPatterns`
 * checks at `createSession` instead.
 */
function uninstalled(rules: AdmissionRules): string | null {
  if (rules.allow === null) return null
  for (const [verb, entries] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
  ] as const) {
    for (const rule of entries) {
      for (const pattern of expanded(rule.commands ?? [])) {
        const name = head(pattern)
        if (name === '' || !(name in SPECS)) continue
        if (!headAllowed(name, rules)) {
          return `${verb} rule names ${name}, which the allow list never allows, so the rule can never fire`
        }
      }
    }
  }
  return null
}

/**
 * The first ask an outranking deny already refuses.
 *
 * Deny is read before ask at the same anchor, so an ask a deny covers
 * can never be reached: the line is refused before anyone is asked, and
 * the sign-off the operator wrote is never requested.
 */
function deadAsk(rules: AdmissionRules): string | null {
  for (const ask of rules.ask) {
    for (const deny of rules.deny) {
      if (shadowed(ask, deny)) {
        const a = (ask.commands ?? []).join(', ') || '*'
        const d = (deny.commands ?? []).join(', ') || '*'
        return `ask rule ${a} can never fire: the deny rule ${d} refuses the same commands and outranks it`
      }
    }
  }
  return null
}

/**
 * Every pattern a rule set writes, with the list it is in and each of its
 * groups expanded: (list, pattern as written, expanded).
 */
function written(rules: AdmissionRules): [string, string, string][] {
  const out: [string, string, string][] = []
  for (const entry of rules.allow ?? []) {
    if (typeof entry === 'string') {
      for (const p of expandPattern(entry)) out.push(['allow', entry, p])
    }
  }
  for (const entry of rules.allow ?? []) {
    if (typeof entry !== 'string') out.push(['allow', entry.pattern, entry.pattern])
  }
  for (const [verb, entries] of [
    ['deny', rules.deny],
    ['ask', rules.ask],
  ] as const) {
    for (const rule of entries) {
      for (const pattern of rule.commands ?? []) {
        for (const p of expandPattern(pattern)) out.push([verb, pattern, p])
      }
    }
  }
  return out
}

/**
 * Refuse a pattern its command cannot read as written: a subcommand or
 * option it does not have, a long option written by a prefix, a short
 * option past a subcommand `*`, or an option no subcommand under the `*`
 * declares. A command with no grammar in `grammars` is left alone, and
 * matches word by word.
 */
export function checkPatterns(
  rules: AdmissionRules | null,
  grammars: ReadonlyMap<string, Grammar>,
): void {
  if (rules === null) return
  for (const [where, writtenAs, pattern] of written(rules)) {
    const words = splitPattern(pattern)
    const grammar = words[0] === undefined ? undefined : grammars.get(words[0])
    if (grammar === undefined) continue
    const problem = patternProblem(grammar, words)
    if (problem !== null) throw new PolicyError(`commands.${where}: ${writtenAs}: ${problem}`)
  }
}

/**
 * What a document writes that loads but may not mean what it says: a group
 * in the command name (`{rm,mv} -f` reads as two rules on two commands), a
 * subcommand `*` in the allow list, which admits a subcommand the command
 * gains later, and each command an allow entry closes beside `*`
 * (`commands.allow closes gh to: gh pr view`).
 */
export function patternWarnings(rules: AdmissionRules | null): string[] {
  if (rules === null) return []
  const out = new Set<string>()
  for (const [where, writtenAs] of written(rules)) {
    const words = splitPattern(writtenAs)
    const first = words[0]
    if (first !== undefined && expandPattern(first).length > 1)
      out.add(
        `commands.${where}: ${writtenAs}: a group in the command name writes one rule per command`,
      )
    if (where === 'allow' && words.slice(1).includes('*'))
      out.add(
        `commands.allow: ${writtenAs}: a * admits every subcommand there, including any added later`,
      )
  }
  const allowed = allowPatterns(rules)
  if (allowed.includes(STAR)) {
    const closed = new Map<string, string[]>()
    for (const pattern of allowed) {
      const head = splitPattern(pattern)[0]
      if (head === undefined || head === STAR) continue
      closed.set(head, [...(closed.get(head) ?? []), pattern])
    }
    for (const [head, entries] of closed)
      out.add(`commands.allow closes ${head} to: ${entries.join(', ')}`)
  }
  return [...out]
}

/**
 * Refuse a document whose rules cannot behave as written.
 *
 * The checks name a rule that is dead on arrival, which is worse than a
 * missing rule because it reads as a guard, or a pattern a builtin's
 * grammar cannot read (`checkPatterns`). Raised where the document is
 * compiled, so a deployment learns at startup rather than the first time
 * an agent types the line the operator thought was covered. What loads but
 * may surprise is logged as a warning (`patternWarnings`).
 */
export function checkRules(rules: AdmissionRules | null): void {
  if (rules === null) return
  for (const problem of [uninstalled(rules), deadAsk(rules)]) {
    if (problem !== null) throw new PolicyError(problem)
  }
  checkPatterns(rules, BUILTIN_GRAMMARS)
  for (const warning of patternWarnings(rules)) logger.warn?.(warning)
}

/**
 * Refuse a pattern an installed CLI cannot read: a verb it does not have
 * at any level, a long option written by a prefix, or a subcommand `*`
 * whose option no verb there declares.
 *
 * Deferred to `createSession` rather than done beside the other checks,
 * because a CLI is registered on the workspace after it is built: at
 * compile time `git push` is just two words, and only once `git` is
 * installed is there a program tree to check it against. A head word no
 * installed CLI claims is left alone, since it may be a command, a
 * function, or a CLI registered later. `trees` holds each installed CLI's
 * grammar, keyed by head word.
 */
export function checkCliPatterns(
  rules: AdmissionRules | null,
  trees: ReadonlyMap<string, Grammar>,
): void {
  checkPatterns(rules, trees)
}

/**
 * The patterns that carry an option on a command with no grammar, neither
 * an installed CLI nor a builtin, so their options match as written, in
 * order. Asked once a session is created, when every CLI it will run is
 * installed.
 */
export function unreadPatterns(
  rules: AdmissionRules | null,
  trees: ReadonlyMap<string, Grammar>,
): string[] {
  if (rules === null) return []
  const out = new Set<string>()
  for (const [where, writtenAs, pattern] of written(rules)) {
    const words = splitPattern(pattern)
    const first = words[0]
    if (
      first !== undefined &&
      !trees.has(first) &&
      !BUILTIN_GRAMMARS.has(first) &&
      words.slice(1).some((word) => word.startsWith('-') && word !== '-')
    )
      out.add(
        `commands.${where}: ${writtenAs}: ${first} has no grammar here, so its options match as written, in order`,
      )
  }
  return [...out]
}

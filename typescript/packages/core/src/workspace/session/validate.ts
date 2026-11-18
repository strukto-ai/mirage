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

import { findChild } from '../../commands/cli/walk.ts'
import { argumentDest, compileSpec } from '../../commands/spec/compile.ts'
import { SPECS } from '../../commands/spec/index.ts'
import type { CommandSpec } from '../../commands/spec/types.ts'
import { PolicyError } from '../../policy/errors.ts'
import { headAllowed } from '../../policy/match/allow.ts'
import {
  allowPatterns,
  envOptions,
  patternProblem,
  readPattern,
  STAR,
  undeclaredOptions,
} from '../../policy/match/grammar.ts'
import { expandPattern, splitPattern } from '../../policy/match/pattern.ts'
import type {
  AdmissionRules,
  CommandNode,
  CommandRule,
  Grammar,
  OptionRule,
} from '../../policy/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'

/** Opt in by assigning a sink per level, as Python's module logger logs. */
export const logger: { warn?: (message: string) => void; info?: (message: string) => void } = {}

export const BUILTIN_GRAMMARS: ReadonlyMap<string, Grammar> = new Map(
  Object.entries(SPECS).map(([name, spec]) => [name, { spec, tree: false, passthrough: false }]),
)

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'decision',
  'reason',
  'paths',
  'operands',
  'values',
])
const VALUELESS_ACTIONS: ReadonlySet<string> = new Set(['store_true', 'count'])
const GLOB_CHARS = /[*?[]/

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
 * in the command name (`{rm,mv} -f` reads as two rules on two commands), or
 * a subcommand `*` in the allow list, which admits a subcommand the command
 * gains later.
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
  return [...out]
}

/**
 * Each command an allow entry closes to its own entries beside `*`
 * (`commands.allow closes gh to: gh pr view`), which the document means
 * and its reader may not see.
 */
export function closedCommands(rules: AdmissionRules | null): string[] {
  const allowed = rules === null ? [] : allowPatterns(rules)
  if (!allowed.includes(STAR)) return []
  const closed = new Map<string, string[]>()
  for (const pattern of allowed) {
    const head = splitPattern(pattern)[0]
    if (head === undefined || head === STAR) continue
    closed.set(head, [...(closed.get(head) ?? []), pattern])
  }
  return [...closed].map(
    ([head, entries]) => `commands.allow closes ${head} to: ${entries.join(', ')}`,
  )
}

/**
 * Refuse a document whose rules cannot behave as written.
 *
 * The checks name a rule that is dead on arrival, which is worse than a
 * missing rule because it reads as a guard, or a pattern a builtin's
 * grammar cannot read (`checkPatterns`). Raised where the document is
 * compiled, so a deployment learns at startup rather than the first time
 * an agent types the line the operator thought was covered. What loads but
 * may surprise is logged as a warning (`patternWarnings`), and each command
 * the allow list closes as a note (`closedCommands`).
 */
export function checkRules(rules: AdmissionRules | null): void {
  if (rules === null) return
  for (const problem of [uninstalled(rules), deadAsk(rules)]) {
    if (problem !== null) throw new PolicyError(problem)
  }
  checkPatterns(rules, BUILTIN_GRAMMARS)
  for (const warning of patternWarnings(rules)) logger.warn?.(warning)
  for (const note of closedCommands(rules)) logger.info?.(note)
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
 * The patterns whose options are not read as options: one on a command
 * with no grammar, neither an installed CLI nor a builtin, whose options
 * match as written, in order, and one naming an option its command tree's
 * leaf does not declare, which reads as an operand (`undeclaredOptions`).
 * Asked once a session is created, when every CLI it will run is installed.
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
    if (first === undefined) continue
    const grammar = trees.get(first)
    for (const word of grammar === undefined ? [] : undeclaredOptions(grammar, words))
      out.add(
        `commands.${where}: ${writtenAs}: ${first} declares no ${word} there, so it matches only a line with ${word} as an operand`,
      )
    if (
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

/**
 * Each `{command, flags}` entry the profile's own `env` closes: a variable
 * it sets fills an option of that command, a filled option is carried as a
 * typed one is (an agent could set the same variable), and the entry's
 * flags leave it out, so the entry refuses the command until its flags
 * list the option. `env` holds the variable names the profile seeds.
 */
export function envFilled(
  rules: AdmissionRules | null,
  env: ReadonlySet<string>,
  trees: ReadonlyMap<string, Grammar>,
): string[] {
  const out: string[] = []
  for (const entry of rules?.allow ?? []) {
    if (typeof entry === 'string') continue
    const words = splitPattern(entry.command)
    const grammar = words[0] === undefined ? undefined : trees.get(words[0])
    if (grammar === undefined) continue
    const read = readPattern(grammar, splitPattern(entry.pattern))
    const listed = new Set(read === null ? [] : read.flags.map((flag) => flag.name))
    for (const [variable, option] of envOptions(grammar, words)) {
      if (env.has(variable) && !listed.has(option))
        out.push(
          `commands.allow: ${entry.pattern}: env sets ${variable}, which fills ${option}, so this refuses ${entry.command} until its flags list ${option}`,
        )
    }
  }
  return out
}

function* atOrBelow(spec: CommandSpec): Generator<CommandSpec> {
  yield spec
  for (const child of spec.subcommands) yield* atOrBelow(child)
}

function cluster(key: string, spec: CommandSpec): boolean {
  if (key.startsWith('--') || key.length < 3) return false
  const shorts = new Set<string>()
  for (const below of atOrBelow(spec))
    for (const spelling of compileSpec(below).dest.keys()) shorts.add(spelling)
  for (const letter of key.slice(1)) if (!shorts.has(`-${letter}`)) return false
  return true
}

function optionName(key: string, spec: CommandSpec, at: string): string {
  const own = compileSpec(spec).dest.get(key)
  if (own !== undefined) return own
  const found = new Set<string>()
  for (const below of atOrBelow(spec)) {
    const dest = compileSpec(below).dest.get(key)
    if (dest !== undefined) found.add(dest)
  }
  const meanings = [...found].sort(compareCodePoints)
  const [only] = meanings
  if (meanings.length === 1 && only !== undefined) return only
  if (meanings.length > 1)
    throw new PolicyError(
      `${at}: ${key} names different options below (${meanings.join(', ')}); ` +
        'write the long name you mean, or put the entry under its subcommand',
    )
  if (cluster(key, spec)) {
    const letters: string[] = []
    for (const letter of key.slice(1)) letters.push(`-${letter}`)
    const keys = letters.join(' and ')
    throw new PolicyError(`${at}: ${key} is a cluster of options; write ${keys} as separate keys`)
  }
  throw new PolicyError(`${at}: no option ${key} at or below this command`)
}

function checkValues(name: string, words: Iterable<string>, spec: CommandSpec, at: string): void {
  const declared = [...atOrBelow(spec)].flatMap((below) =>
    below.arguments.filter(
      (argument) => argument.names[0]?.startsWith('-') === true && argumentDest(argument) === name,
    ),
  )
  if (declared.every((argument) => VALUELESS_ACTIONS.has(argument.action) || argument.nargs === 0))
    throw new PolicyError(`${at}: ${name} takes no value`)
  const choices = new Set(declared.flatMap((argument) => argument.choices))
  if (choices.size === 0 || declared.some((argument) => argument.choices.length === 0)) return
  for (const word of words) {
    if (!GLOB_CHARS.test(word) && !choices.has(word))
      throw new PolicyError(
        `${at}: ${name} takes none of '${word}'; its values are ${[...choices].sort(compareCodePoints).join(', ')}`,
      )
  }
}

function options(
  entries: ReadonlyMap<string, OptionRule>,
  spec: CommandSpec,
  at: string,
  passthrough: boolean,
): Map<string, OptionRule> {
  const out = new Map<string, OptionRule>()
  const written = new Map<string, string>()
  for (const [key, rule] of entries) {
    const here = `${at}.${key}`
    if (passthrough)
      throw new PolicyError(
        `${here}: this command's script reads its own words, so it has no option to name`,
      )
    const name = optionName(key, spec, here)
    const first = written.get(name)
    if (first !== undefined) throw new PolicyError(`${at}: ${first} and ${key} are the same option`)
    written.set(name, key)
    if (rule.values.size > 0) checkValues(name, rule.values.keys(), spec, here)
    out.set(name, {
      decision: rule.decision,
      values: new Map(
        [...rule.values].map(([word, value]) => [
          word,
          {
            decision: value.decision,
            options: options(value.options, spec, `${here}.values.${word}`, false),
          },
        ]),
      ),
      options: options(rule.options, spec, here, false),
    })
  }
  return out
}

function noGrammar(tree: CommandNode, at: string): CommandNode {
  if (tree.options.size > 0 || tree.otherOptions.length > 0)
    throw new PolicyError(`${at}: this command has no grammar here to read an option by`)
  const [first] = tree.subcommands.keys()
  if (first !== undefined)
    throw new PolicyError(`${at}: ${first} is no subcommand here; an operand goes under operands`)
  return {
    ...tree,
    operands: new Map(
      [...tree.operands].map(([word, child]) => [word, noGrammar(child, `${at}.operands.${word}`)]),
    ),
  }
}

function reserved(spec: CommandSpec): string | null {
  for (const child of spec.subcommands)
    for (const word of [child.name, ...child.aliases]) if (RESERVED_WORDS.has(word)) return word
  return null
}

function plain(tree: CommandNode): boolean {
  const bare =
    tree.subcommands.size === 0 &&
    tree.options.size === 0 &&
    tree.otherOptions.length === 0 &&
    tree.operands.size === 0
  return bare && tree.decision.every((leaf) => leaf.reason === '' && leaf.paths.length === 0)
}

function node(tree: CommandNode, spec: CommandSpec, at: string, passthrough: boolean): CommandNode {
  const word = reserved(spec)
  if (word !== null && !plain(tree))
    throw new PolicyError(
      `${at}: this command has a subcommand named ${word}, which a commands block reserves; ` +
        'write it a plain allow, ask or deny',
    )
  const subcommands = new Map<string, CommandNode>()
  const written = new Map<string, string>()
  for (const [key, child] of tree.subcommands) {
    const found = findChild(spec, key)
    if (found === null && spec.subcommands.length === 0)
      throw new PolicyError(`${at}: ${key} is no subcommand here; an operand goes under operands`)
    if (found === null) throw new PolicyError(`${at}: no subcommand ${key}`)
    const first = written.get(found.name)
    if (first !== undefined)
      throw new PolicyError(`${at}: ${first} and ${key} are the same subcommand`)
    written.set(found.name, key)
    subcommands.set(found.name, node(child, found, `${at}.${found.name}`, passthrough))
  }
  if (tree.operands.size > 0 && spec.subcommands.length > 0)
    throw new PolicyError(`${at}: this command takes a subcommand, so its operands go under one`)
  if (tree.otherOptions.length > 0 && passthrough)
    throw new PolicyError(
      `${at}.-*: this command's script reads its own words, so it has no option to name`,
    )
  return {
    decision: tree.decision,
    subcommands,
    options: options(tree.options, spec, at, passthrough),
    otherOptions: tree.otherOptions,
    operands: new Map(
      [...tree.operands].map(([word, child]) => [
        word,
        node(child, spec, `${at}.operands.${word}`, passthrough),
      ]),
    ),
  }
}

/**
 * A command tree with every name checked against its command's grammar
 * and held by its canonical name, the one the line reader reports: a
 * subcommand by its spec name, an option by its first long name or its
 * short name when it has none. Refused: a name the grammar lacks; two
 * keys for one option or one subcommand; a cluster of short options; a
 * short option meaning different options in the subcommands below;
 * operands on a command that takes a subcommand; a value under an option
 * that takes none, or outside its choices; and options or subcommands on
 * a command with no grammar, since the line reader gives it only
 * operands. `defer` keeps a command with no grammar as written, for a
 * check made before every CLI is registered.
 */
export function normalizeTree(
  tree: CommandNode,
  grammars: ReadonlyMap<string, Grammar>,
  where = 'commands',
  defer = false,
): CommandNode {
  const commands = new Map<string, CommandNode>()
  for (const [name, child] of tree.subcommands) {
    const grammar = grammars.get(name)
    const at = `${where}.${name}`
    if (grammar === undefined) commands.set(name, defer ? child : noGrammar(child, at))
    else commands.set(name, node(child, grammar.spec, at, grammar.passthrough))
  }
  return { ...tree, subcommands: commands }
}

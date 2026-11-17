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

import { findChild, leafParse } from '../../commands/cli/walk.ts'
import { argumentDest, compileSpec, type CompiledSpec } from '../../commands/spec/compile.ts'
import { type ParsedArgs, parseCommand } from '../../commands/spec/parser.ts'
import type { Argument, CommandSpec, FlagValue } from '../../commands/spec/types.ts'
import { PathSpec } from '../../types.ts'
import type { AdmissionRules, CommandRead, FlagFact, Grammar } from '../types.ts'
import { expandPattern, splitPattern } from './pattern.ts'

export const STAR = '*'
export const HELP_WORDS: ReadonlySet<string> = new Set(['--help', '--version'])
export const CACHE_SIZE = 4096

const PATTERNS = new WeakMap<CommandSpec, Map<string, CommandRead | null>>()
const READS = new WeakMap<Grammar, Map<string, readonly [string, CommandRead | null][]>>()

function values(value: FlagValue | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap((part) => values(part))
  if (value instanceof PathSpec) return [value.virtual]
  if (typeof value === 'string') return [value]
  return []
}

/**
 * Each named option with the values it holds. `flags` are option values by
 * canonical spelling, as a parse or a walk left them; `dests` the options
 * the words carry, in order.
 */
export function flagFacts(
  flags: Readonly<Record<string, FlagValue>>,
  dests: Iterable<string>,
): FlagFact[] {
  return [...dests].map((dest) => ({ name: dest, values: values(flags[dest]) }))
}

/**
 * Whether the grammar refuses the words' options. A missing operand or
 * required option does not count, and in a pattern neither does an option
 * written without its value, which matches any value.
 */
export function refused(parsed: ParsedArgs, pattern = false): boolean {
  return (
    parsed.optionErrorKinds.some((kind) => !(pattern && kind === 'needs_value')) ||
    parsed.oldOptionNeedsValue !== null
  )
}

/**
 * A leaf's parse as a read: the options the words carry, typed or filled
 * from the environment, never a declared default, and the operands as
 * written. null when the grammar refuses the words. `pattern` is the spec
 * that read a rule pattern's words, where an option written without its
 * value matches any value; null for a line's.
 */
export function leafRead(
  path: readonly string[],
  parsed: ParsedArgs,
  pattern: CommandSpec | null = null,
): CommandRead | null {
  if (refused(parsed, pattern !== null)) return null
  const dests = [...parsed.typedDests, ...parsed.envDests]
  const flags = flagFacts(parsed.flags, dests)
  if (pattern !== null) {
    const cs = compileSpec(pattern)
    for (const option of parsed.needsValueOptions) {
      const dest = cs.destOf(option.startsWith('-') ? option : `-${option}`)
      if (!dests.includes(dest)) flags.push({ name: dest, values: [] })
    }
  }
  return { path: [...path], flags, operands: parsed.rawOperands.map(([word]) => word) }
}

/**
 * Whether a pattern writes a long option by a prefix of its name. A line
 * may, a pattern may not: `--rec` reads as a rule on whatever the prefix
 * names today, and a new option can change that.
 */
export function abbreviated(cs: CompiledSpec, words: readonly string[]): boolean {
  for (const word of words) {
    if (word === '--') return false
    if (!word.startsWith('--')) continue
    const name = word.split('=', 1)[0] ?? word
    if (
      !cs.dest.has(name) &&
      [...cs.dest.keys()].some((spelling) => spelling.startsWith('--') && spelling.startsWith(name))
    )
      return true
  }
  return false
}

function descend(
  grammar: Grammar,
  words: readonly string[],
): [CommandSpec, readonly string[], readonly string[]] {
  let node = grammar.spec
  const path = [words[0] ?? '']
  let at = 1
  while (grammar.tree && node.subcommands.length > 0 && at < words.length) {
    const word = words[at] ?? ''
    const child = word.startsWith('-') ? null : findChild(node, word)
    if (child === null) break
    node = child
    path.push(child.name)
    at += 1
  }
  return [node, path, words.slice(at)]
}

function readOnce(grammar: Grammar, words: readonly string[]): CommandRead | null {
  const [node, path, rest] = descend(grammar, words)
  if (grammar.passthrough && node.subcommands.length === 0)
    return { path, flags: [], operands: rest }
  if (abbreviated(compileSpec(node), rest)) return null
  const prog = path.join(' ')
  if (node.subcommands.length > 0) {
    const parsed = parseCommand(node, [...rest], '/', prog)
    if (parsed.rawOperands.length > 0) return null
    return leafRead(path, parsed, node)
  }
  if (!grammar.tree) return leafRead(path, parseCommand(node, [...rest], '/', prog), node)
  const rules = leafParse(grammar.spec, node, path.slice(1), grammar.passthrough)
  const parsed = parseCommand(
    rules.spec,
    [...rest],
    '/',
    prog,
    undefined,
    rules.unknownIsOperand,
    rules.abbreviations,
  )
  return leafRead(path, parsed, rules.spec)
}

/**
 * A rule pattern read with the grammar of the line it is compared to, as
 * the line itself was read: subcommands by their canonical names, options
 * by their canonical spellings with the values the pattern gives them.
 * null when the grammar refuses it, or it names a long option by a
 * prefix. Kept per grammar and pattern.
 */
export function readPattern(grammar: Grammar, words: readonly string[]): CommandRead | null {
  const kept = PATTERNS.get(grammar.spec) ?? new Map<string, CommandRead | null>()
  PATTERNS.set(grammar.spec, kept)
  const key = JSON.stringify([grammar.tree, grammar.passthrough, words])
  const hit = kept.get(key)
  if (hit !== undefined) return hit
  const read = readOnce(grammar, words)
  if (kept.size >= CACHE_SIZE) kept.clear()
  kept.set(key, read)
  return read
}

/**
 * A pattern with each subcommand `*` replaced by the line's subcommand at
 * that place, and whether it held one. A `*` stands for a subcommand while
 * the node it sits under has subcommands, and for an operand once the
 * pattern reaches a leaf. null when the line has no subcommand there.
 * `path` is the line's command name and canonical subcommands.
 */
export function bind(
  grammar: Grammar,
  words: readonly string[],
  path: readonly string[],
): [readonly string[], boolean] | null {
  if (!grammar.tree || !words.slice(1).includes(STAR)) return [words, false]
  let node = grammar.spec
  const out = [words[0] ?? '']
  let starred = false
  for (let at = 1; at < words.length; at++) {
    let word = words[at] ?? ''
    if (node.subcommands.length === 0) return [[...out, ...words.slice(at)], starred]
    if (word === STAR) {
      const bound = path[at]
      if (bound === undefined) return null
      word = bound
      starred = true
    }
    const child = word.startsWith('-') ? null : findChild(node, word)
    if (child === null) return [[...out, ...words.slice(at)], starred]
    out.push(child.name)
    node = child
  }
  return [out, starred]
}

/**
 * The allow list's patterns, each group expanded. A `{command, flags}`
 * entry stands as its command and options in one pattern
 * (`AllowFlags.pattern`).
 */
export function allowPatterns(rules: AdmissionRules): string[] {
  return (rules.allow ?? []).flatMap((entry) =>
    typeof entry === 'string' ? expandPattern(entry) : [entry.pattern],
  )
}

/** Every command pattern a rule set holds, each group expanded, its allow list first. */
export function expandedPatterns(rules: AdmissionRules): string[] {
  return [
    ...allowPatterns(rules),
    ...[...rules.deny, ...rules.ask].flatMap((rule) =>
      (rule.commands ?? []).flatMap((written) => expandPattern(written)),
    ),
  ]
}

/**
 * Each pattern on the line's command, read with the line's grammar, keyed
 * by the pattern as its group expanded. A pattern the grammar refuses is
 * left out and matched word by word; one whose subcommand `*` cannot read
 * on this line reads as null, which never matches. `path` is the line's
 * command name and canonical subcommands.
 */
export function patternReads(
  rules: AdmissionRules,
  path: readonly string[],
  grammar: Grammar,
): readonly [string, CommandRead | null][] {
  const kept = READS.get(grammar) ?? new Map<string, readonly [string, CommandRead | null][]>()
  READS.set(grammar, kept)
  const key = JSON.stringify([rules, path])
  const hit = kept.get(key)
  if (hit !== undefined) return hit
  const out = new Map<string, CommandRead | null>()
  for (const pattern of expandedPatterns(rules)) {
    if (out.has(pattern)) continue
    const words = splitPattern(pattern)
    if (words.length === 0 || words[0] !== path[0]) continue
    const bound = bind(grammar, words, path)
    if (bound === null) {
      out.set(pattern, null)
      continue
    }
    const read = readPattern(grammar, bound[0])
    if (read !== null || bound[1]) out.set(pattern, read)
  }
  const reads = [...out.entries()]
  if (kept.size >= CACHE_SIZE) kept.clear()
  kept.set(key, reads)
  return reads
}

function options(words: readonly string[]): string[] {
  const out: string[] = []
  for (const word of words) {
    if (word === '--') break
    if (word.startsWith('-') && word !== '-') out.push(word)
  }
  return out
}

/** Each pattern a subcommand `*` can bind to, one per node. */
function bindings(grammar: Grammar, words: readonly string[]): string[][] {
  const out: string[][] = []
  const fill = (node: CommandSpec, done: readonly string[], at: number): void => {
    if (at >= words.length || node.subcommands.length === 0) {
      out.push([...done, ...words.slice(at)])
      return
    }
    const word = words[at] ?? ''
    if (word === STAR) {
      for (const child of node.subcommands) fill(child, [...done, child.name], at + 1)
      return
    }
    const child = word.startsWith('-') ? null : findChild(node, word)
    if (child === null) {
      out.push([...done, ...words.slice(at)])
      return
    }
    fill(child, [...done, child.name], at + 1)
  }
  fill(grammar.spec, [words[0] ?? ''], 1)
  return out
}

/**
 * The options a line under a command may have filled from the environment,
 * by variable: those of the node `words` name, of its ancestors and of
 * every subcommand below it, by canonical spelling. `words` is the command
 * name and its subcommands.
 */
export function envOptions(grammar: Grammar, words: readonly string[]): Map<string, string> {
  let node = grammar.spec
  const found: Argument[] = [...node.arguments]
  for (const word of words.slice(1)) {
    const child = grammar.tree ? findChild(node, word) : null
    if (child === null) break
    node = child
    found.push(...child.arguments)
  }
  const below = [...node.subcommands]
  for (let sub = below.pop(); sub !== undefined; sub = below.pop()) {
    found.push(...sub.arguments)
    below.push(...sub.subcommands)
  }
  const out = new Map<string, string>()
  for (const argument of found)
    if (argument.env !== null) out.set(argument.env, argumentDest(argument))
  return out
}

/**
 * The dashed words a command tree's leaf reads as operands in a pattern,
 * because it declares no such option: the line reads them so too, and the
 * pattern matches only a line that carries the same word.
 */
export function undeclaredOptions(grammar: Grammar, words: readonly string[]): string[] {
  if (!grammar.tree || words.slice(1).includes(STAR)) return []
  const read = readPattern(grammar, words)
  if (read === null) return []
  const dashed = new Set(options(words.slice(read.path.length)))
  return read.operands.filter((word) => dashed.has(word))
}

/**
 * Why a pattern cannot be read the way it is written on its command, null
 * when it can: a subcommand the command lacks, a long option written by a
 * prefix of its name, an option the command does not have (a command
 * tree's leaf takes an undeclared dashed word as an operand only where it
 * has a slot for one), or, past a subcommand `*`, an option written short
 * or one no subcommand there declares. A help or version request matches word by word, as its line
 * does, and the pattern's other words are checked without it.
 */
export function patternProblem(grammar: Grammar, words: readonly string[]): string | null {
  const head = words[0] ?? ''
  const asked = words.filter((word) => !HELP_WORDS.has(word))
  if (asked.length < words.length) return patternProblem(grammar, asked)
  if (grammar.tree && words.slice(1).includes(STAR)) {
    const written = options(words)
    const short = written.find((option) => !option.startsWith('--'))
    if (short !== undefined)
      return `${short} follows a subcommand *, where a short option can name a different option per subcommand; write its long name`
    if (written.length === 0) return null
    if (bindings(grammar, words).some((bound) => readPattern(grammar, bound) !== null)) return null
    return `no ${head} subcommand the * stands for has ${written.join(' ')}`
  }
  const [node, path, rest] = descend(grammar, words)
  const prog = path.join(' ')
  const next = rest[0]
  if (
    grammar.tree &&
    node.subcommands.length > 0 &&
    next !== undefined &&
    !next.startsWith('-') &&
    next !== STAR
  )
    return `the ${head} CLI has no verb ${prog} ${next}`
  const cs = compileSpec(node)
  for (const option of options(rest)) {
    const name = option.split('=', 1)[0] ?? option
    if (name.startsWith('--') && abbreviated(cs, [name]))
      return `${name} is a prefix of an option; write the option in full`
  }
  if (readPattern(grammar, words) !== null) return null
  if (grammar.tree && node.subcommands.length === 0)
    return `${prog} does not read ${rest.join(' ')}`
  const parsed = parseCommand(node, [...rest], '/', prog)
  const bad = parsed.invalidOptions[0]
  if (bad !== undefined) return `${prog} has no option ${bad.startsWith('-') ? bad : `-${bad}`}`
  return `${prog} does not read ${rest.join(' ')}`
}

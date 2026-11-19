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
import type { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { PolicyError } from '../../policy/errors.ts'
import { noGrammar, unreadNames } from '../../policy/match/grammar.ts'
import {
  AdmissionRules,
  type CommandNode,
  type Grammar,
  type OptionRule,
} from '../../policy/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { NOT_INSTALLABLE } from '../lookup/constants.ts'

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

function optionName(
  key: string,
  spec: CommandSpec,
  above: readonly CommandSpec[],
  at: string,
): string {
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
  for (const parent of [...above].reverse()) {
    const inherited = compileSpec(parent).dest.get(key)
    if (inherited !== undefined) return inherited
  }
  if (cluster(key, spec)) {
    const letters: string[] = []
    for (const letter of key.slice(1)) letters.push(`-${letter}`)
    const keys = letters.join(' and ')
    throw new PolicyError(`${at}: ${key} is a cluster of options; write ${keys} as separate keys`)
  }
  throw new PolicyError(`${at}: no option ${key} at or below this command`)
}

function declaring(name: string, specs: Iterable<CommandSpec>): Argument[] {
  return [...specs].flatMap((spec) =>
    spec.arguments.filter(
      (argument) => argument.names[0]?.startsWith('-') === true && argumentDest(argument) === name,
    ),
  )
}

function checkValues(
  name: string,
  words: Iterable<string>,
  spec: CommandSpec,
  above: readonly CommandSpec[],
  at: string,
): void {
  const own = declaring(name, atOrBelow(spec))
  const declared = own.length > 0 ? own : declaring(name, [...above].reverse())
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
  above: readonly CommandSpec[],
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
    const name = optionName(key, spec, above, here)
    const first = written.get(name)
    if (first !== undefined) throw new PolicyError(`${at}: ${first} and ${key} are the same option`)
    written.set(name, key)
    if (rule.values.size > 0) checkValues(name, rule.values.keys(), spec, above, here)
    out.set(name, {
      decision: rule.decision,
      values: new Map(
        [...rule.values].map(([word, value]) => [
          word,
          {
            decision: value.decision,
            options: options(value.options, spec, above, `${here}.values.${word}`, false),
          },
        ]),
      ),
      options: options(rule.options, spec, above, here, false),
    })
  }
  return out
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

function node(
  tree: CommandNode,
  spec: CommandSpec,
  at: string,
  passthrough: boolean,
  above: readonly CommandSpec[] = [],
): CommandNode {
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
    subcommands.set(
      found.name,
      node(child, found, `${at}.${found.name}`, passthrough, [...above, spec]),
    )
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
    options: options(tree.options, spec, above, at, passthrough),
    otherOptions: tree.otherOptions,
    operands: new Map(
      [...tree.operands].map(([word, child]) => [
        word,
        node(child, spec, `${at}.operands.${word}`, passthrough, above),
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
 * that takes none, or outside its choices; options or subcommands on a
 * command with no grammar, since the line reader gives it only operands;
 * and a tree that the trees two mounts serve under one name read
 * differently, since either may read a line. `defer` keeps a command with no grammar as written, for a
 * check made before every CLI is registered; a name no CLI can be
 * installed under (a shell builtin, a keyword) is checked all the same.
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
    const later = defer && !NOT_INSTALLABLE.has(name)
    if (grammar === undefined) {
      commands.set(name, later ? child : noGrammar(child, at))
      continue
    }
    const held = node(child, grammar.spec, at, grammar.passthrough)
    for (const other of grammar.others ?? []) {
      if (nodeKey(node(child, other.spec, at, other.passthrough)) !== nodeKey(held)) {
        throw new PolicyError(
          `${at}: two mounts serve ${name} with trees that read these names differently; name only what both read alike`,
        )
      }
    }
    commands.set(name, held)
  }
  return { ...tree, subcommands: commands }
}

function nodeKey(tree: CommandNode): string {
  return JSON.stringify(tree, (_key, value: unknown) => (value instanceof Map ? [...value] : value))
}

/**
 * A session's command trees held again by the canonical names of the
 * grammars the workspace has now, for a command that had none when the
 * trees were compiled and has since been registered. Throws `PolicyError`
 * when a name does not fit the grammar its command has now.
 */
export function renormalized(
  rules: AdmissionRules | null,
  grammars: ReadonlyMap<string, Grammar>,
): AdmissionRules | null {
  if (rules === null) return null
  const trees = rules.trees.map((scoped) => ({
    ...scoped,
    tree: normalizeTree(scoped.tree, grammars, 'commands', true),
  }))
  return new AdmissionRules(trees, unreadNames(trees, grammars))
}

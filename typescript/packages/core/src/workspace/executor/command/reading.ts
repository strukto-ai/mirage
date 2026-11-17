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

import { walk } from '../../../commands/cli/walk.ts'
import { SPECS } from '../../../commands/spec/index.ts'
import { type ParsedArgs, parseCommand, wordPaths } from '../../../commands/spec/parser.ts'
import { WordKind } from '../../../commands/spec/types.ts'
import { CommandWord } from '../../../policy/types.ts'
import { PathSpec } from '../../../types.ts'
import { resolvePath } from '../../../utils/path.ts'
import type { NamespaceLinks, SessionAccess } from '../../../view/types.ts'
import { followPaths } from '../builtins/links/links.ts'
import { toScope } from '../builtins/scope.ts'
import { SLASH_KEEPS_LAST } from '../../lookup/index.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { leafParse } from './cli.ts'
import { commandTree } from './routing.ts'
import type { LineReading } from './types.ts'

type Grammar = [WordKind, string | null, PathSpec | null]

/**
 * Each word as a flat grammar reads it: its kind, the option it carries
 * attached and the path the grammar gives it. `operands` says whether a path
 * operand takes the grammar's path, as a tree's does; a builtin's comes from
 * the classifier. Mirrors Python's `_leaf_grammar`.
 */
function leafGrammar(
  parsed: ParsedArgs,
  argv: readonly string[],
  cwd: string,
  operands: boolean,
): Grammar[] {
  const paths = wordPaths(parsed, argv, cwd, operands)
  const attached = new Map(parsed.attached.map((a) => [a.slot, a.option]))
  return parsed.wordRoles.map((role, slot): Grammar => [
    role ?? WordKind.OPERAND,
    attached.get(slot) ?? null,
    paths[slot] ?? null,
  ])
}

/**
 * Read a command once, its words and the paths they name. A command tree (an
 * installed CLI's, or a mount's) is walked as its run walks it: the walk names
 * its verbs, group options and their values, and the leaf's grammar its own
 * words, parsed with the run's own settings (`leafParse`). Any other command's words are read off its own spec, and a command
 * no spec describes reads a dashed word as an option and anything else as an
 * operand. A word's path is the classifier's, which carries the mount and the
 * glob, else the grammar's: an option's value the classifier left as text,
 * attached (`--file=x`) or not, and a tree's operand. A `-` given to an
 * option is standard input or output, never a file. Mirrors Python's
 * `read_line`.
 */
export function readLine(
  registry: MountRegistry,
  name: string,
  argv: readonly string[],
  classified: readonly (string | PathSpec)[],
  cwd: string,
  env?: Record<string, string>,
  access?: SessionAccess,
): LineReading {
  const tree = commandTree(registry, name, cwd, argv, access)
  const result = tree !== null ? walk(name, tree.spec, [...argv], cwd, env ?? null) : null
  const supplied: PathSpec[] = []
  let grammar: Grammar[]
  let program: string[]
  let tokens: string[]
  if (tree !== null && result !== null && result.leaf !== null) {
    const rules = leafParse(tree, result.leaf, result.path)
    const leaf = parseCommand(
      rules.spec,
      [...result.argv],
      cwd,
      name,
      env,
      rules.unknownIsOperand,
      rules.abbreviations,
    )
    grammar = [
      ...result.words.map((w): Grammar => [w.kind, w.option, w.path]),
      ...leafGrammar(leaf, result.argv, cwd, true),
    ]
    const typed = new Set(result.words.flatMap((w) => (w.path !== null ? [w.path.virtual] : [])))
    for (const value of Object.values(result.groupFlags)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item instanceof PathSpec && !typed.has(item.virtual)) supplied.push(item)
      }
    }
    supplied.push(...leaf.suppliedPathValues.map((v) => toScope(v)))
    program = [name, ...result.path]
    tokens = [...program, ...result.argv]
  } else {
    const spec = SPECS[name]
    if (spec === undefined) {
      grammar = argv.map((w): Grammar => [
        w.startsWith('-') && w !== '-' ? WordKind.OPTION : WordKind.OPERAND,
        null,
        null,
      ])
    } else {
      const parsed = parseCommand(spec, [...argv], cwd, name)
      grammar = leafGrammar(parsed, argv, cwd, false)
      supplied.push(...parsed.suppliedPathValues.map((v) => toScope(v)))
    }
    program = [name]
    tokens = [name, ...argv]
  }
  const words: CommandWord[] = []
  let option: string | null = null
  argv.forEach((text, slot) => {
    const [kind, carried, specPath] = grammar[slot] ?? [WordKind.OPERAND, null, null]
    const word = classified[slot] ?? text
    let path = word instanceof PathSpec ? word : specPath
    if (kind === WordKind.VALUE && text === '-') path = null
    words.push(new CommandWord(text, kind, kind === WordKind.VALUE ? option : carried, path))
    if (kind === WordKind.OPTION) option = text
  })
  return { words, supplied, tokens, program }
}

/**
 * The words a policy reads: the name first, then each word of the reading,
 * then the statement's redirect targets. Mirrors Python's `context_words`.
 */
export function contextWords(
  name: string,
  reading: LineReading,
  redirects: readonly PathSpec[],
): CommandWord[] {
  return [
    new CommandWord(name, WordKind.NAME),
    ...reading.words,
    ...redirects.map(
      (p) => new CommandWord(p.rawPath !== '' ? p.rawPath : p.virtual, WordKind.REDIRECT, null, p),
    ),
  ]
}

/**
 * Every path a line reaches, the one list a path guard reads. The paths the
 * words name, in the order they stand, an operand typed twice twice (`cat a
 * a`); then those carried attached to an option (`--file=x`) and the values no
 * word typed (a default, the environment). A slash-carrying name is a file the
 * line executes, so it comes first. Then the link targets the command will
 * reach: an operand's by the command's own follow policy (`rm`, `mv`, `tar`
 * act on a link itself), an option's always, since the command opens the file
 * (`--attach link.csv` sends the file the link names). Then the working
 * directory a bare `ls` reads, which the executor injects after the gate. Last
 * the redirect targets and theirs, which the shell opens on its own fds outside
 * the command's gate window, so this is the one place a rule can see them.
 * Mirrors Python's `line_paths`.
 */
export function linePaths(
  name: string,
  reading: LineReading,
  follows: boolean,
  links: NamespaceLinks | null,
  cwd: string,
  implied: PathSpec | null = null,
  redirects: readonly PathSpec[] = [],
): PathSpec[] {
  const named = reading.words.filter((w): w is CommandWord & { path: PathSpec } => w.path !== null)
  const scopes = named.filter((w) => w.kind !== WordKind.OPTION).map((w) => w.path)
  const seen = new Set(scopes.map((p) => p.virtual))
  const add = (items: readonly (string | PathSpec | null)[]): void => {
    for (const item of items) {
      if (item instanceof PathSpec && !seen.has(item.virtual)) {
        seen.add(item.virtual)
        scopes.push(item)
      }
    }
  }
  add(named.filter((w) => w.kind === WordKind.OPTION).map((w) => w.path))
  add(reading.supplied)
  if (name.includes('/')) scopes.unshift(toScope(resolvePath(name, cwd)))
  if (links !== null) {
    const operands = named.filter((w) => w.kind === WordKind.OPERAND).map((w) => w.path)
    const options = named.filter((w) => w.kind !== WordKind.OPERAND).map((w) => w.path)
    add(followPaths(links, operands, follows, !SLASH_KEEPS_LAST.has(name)))
    add(followPaths(links, [...options, ...reading.supplied], true, true))
  }
  add([implied])
  add(redirects)
  if (links !== null) add(followPaths(links, [...redirects], true, true))
  return scopes
}

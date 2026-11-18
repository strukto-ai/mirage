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

import type { ParsedArgs } from '../../commands/spec/parser.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { PathSpec } from '../../types.ts'
import { PolicyError } from '../errors.ts'
import type { CommandNode, CommandRead, FlagFact, Grammar, ScopedTree } from '../types.ts'

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

function unread(word: string): string {
  const name = word.split('=', 1)[0] ?? word
  return name.startsWith('-') ? name : `-${name}`
}

/**
 * A leaf's parse as a read: the options the words carry, typed or filled
 * from the environment, never a declared default, and the operands as
 * written. A line the grammar refuses keeps all it did read, so a command
 * that runs past the refusal (`find`'s `-exec`, which its expression
 * reads) is judged by its path, options and operands still. Each option
 * word it could not read is one more option the tree does not name,
 * which `-*` answers; a value handed to an option that takes none counts
 * as that option. Mirrors Python's leaf_read.
 */
export function leafRead(path: readonly string[], parsed: ParsedArgs): CommandRead {
  const dests = [...parsed.typedDests, ...parsed.envDests]
  const words = [...parsed.invalidOptions, ...parsed.ambiguousOptions.map(([word]) => word)]
  return {
    path: [...path],
    flags: [
      ...flagFacts(parsed.flags, dests),
      ...words.map((word) => ({ name: unread(word), values: [] })),
    ],
    operands: parsed.rawOperands.map(([word]) => word),
  }
}

/**
 * A command's subtree for a command no grammar reads, which the line
 * reader gives operands only. Throws `PolicyError` when the subtree names
 * an option or a subcommand. Mirrors Python's `no_grammar`.
 */
export function noGrammar(tree: CommandNode, at: string): CommandNode {
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

/**
 * The commands the trees name options or subcommands of while no grammar
 * reads them, which `noGrammar` would refuse. Mirrors Python's
 * `unread_names`.
 */
export function unreadNames(
  trees: readonly ScopedTree[],
  grammars: ReadonlyMap<string, Grammar>,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const scoped of trees) {
    for (const [name, node] of scoped.tree.subcommands) {
      if (!grammars.has(name) && namesWords(node)) out.add(name)
    }
  }
  return out
}

function namesWords(node: CommandNode): boolean {
  if (node.options.size > 0 || node.otherOptions.length > 0 || node.subcommands.size > 0)
    return true
  return [...node.operands.values()].some(namesWords)
}

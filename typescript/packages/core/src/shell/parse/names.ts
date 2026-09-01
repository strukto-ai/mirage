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

import type { TSNodeLike } from '../types.ts'
import {
  ARITH_OPEN_TOKEN,
  ARITH_TEST_OPERATORS,
  DECLARING_NODES,
  TARGET_NAME_FIELDS,
} from './constants.ts'

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g

/**
 * Whether two facade nodes name the same tree node. Web-tree-sitter
 * hands out a fresh wrapper per lookup, so `===` alone cannot tell a
 * node from a re-read of it; identity rides `id` when the facade has
 * one.
 */
export function sameNode(a: TSNodeLike, b: TSNodeLike): boolean {
  return a === b || (a.id !== undefined && a.id === b.id)
}

function collectNames(node: TSNodeLike, out: Set<string>): void {
  if (node.type === 'function_definition') return
  if (node.type === 'variable_name') {
    if (node.text !== '') out.add(node.text)
    return
  }
  if (DECLARING_NODES.has(node.type)) {
    for (const child of node.children) {
      if (child.type !== 'variable_name') collectNames(child, out)
    }
    return
  }
  const field = TARGET_NAME_FIELDS[node.type]
  let target = field !== undefined ? (node.childForFieldName?.(field) ?? null) : null
  // `+=` reads the target before writing it (`TOKEN+=x` starts from
  // the existing value), so an append's name is a read here too.
  if (target !== null && node.children.some((c) => c.type === '+=')) target = null
  for (const child of node.children) {
    if (target !== null && sameNode(child, target)) continue
    collectNames(child, out)
  }
}

/**
 * Named nodes, skipping function_definition subtrees.
 *
 * A definition's body runs at invocation, not where it is defined, so
 * a read walk that descended into one would charge the defining line
 * for reads it never performs. The fill layer joins invoked bodies
 * back in through its own node set (`lineNodes`).
 */
export function* walkNamedOutsideDefs(node: TSNodeLike): Generator<TSNodeLike> {
  if (node.type === 'function_definition') return
  yield node
  for (const child of node.namedChildren) {
    yield* walkNamedOutsideDefs(child)
  }
}

/**
 * Every variable name a parsed program may read when it runs.
 *
 * A textual over-approximation over the whole tree, which is safe by
 * construction: the worst a spurious name costs is one fetch. Walked
 * everywhere -- command substitution bodies, redirect targets, heredoc
 * bodies, arithmetic -- with two exceptions that are writes, not reads
 * (an assignment's own name, unless it appends, since `+=` starts from
 * the value it extends; a for loop's variable), one that runs later
 * rather than now (a function definition's body, which the fill layer
 * joins back in at invocation), and one the grammar gives for free: a
 * single-quoted string tokenizes as `raw_string` with no children, so
 * `'$X'` never reads X.
 */
export function referencedNames(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  collectNames(node, out)
  return out
}

/**
 * The first word of every command a parsed program runs.
 *
 * What the whole-env scan and the CLI env-name lookup key on.
 * `command_name` covers ordinary commands wherever they sit; the
 * declaring builtins (`export`, `declare`, `local`, `readonly`,
 * `unset`) parse as their own node types whose head word is the first
 * anonymous token, so those are read directly. A function definition's
 * body is skipped: those commands run at invocation, where the fill
 * layer walks the stored body instead.
 */
export function commandWords(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'command_name') {
      if (current.text !== '') out.add(current.text)
    } else if (DECLARING_NODES.has(current.type)) {
      const head = current.children[0]
      if (head !== undefined && head.text !== '') out.add(head.text)
    }
  }
  return out
}

/**
 * The argument's text when the parser fixed it, else null.
 *
 * A plain word, a number, a raw string and a double-quoted string of
 * plain content each spell one literal; anything carrying an expansion
 * or a substitution is dynamic and reads as null.
 */
export function literalText(node: TSNodeLike): string | null {
  if (node.type === 'word' || node.type === 'number') {
    return node.text !== '' ? node.text : null
  }
  if (node.type === 'raw_string') {
    return node.text.slice(1, -1)
  }
  if (node.type === 'string') {
    const named = node.namedChildren
    if (named.length === 0) return ''
    const only = named[0]
    if (named.length === 1 && only?.type === 'string_content') {
      return only.text
    }
  }
  return null
}

export function commandArgs(node: TSNodeLike): TSNodeLike[] {
  const nameNode = node.childForFieldName?.('name') ?? null
  return node.namedChildren.filter(
    (child) =>
      (nameNode === null || !sameNode(child, nameNode)) &&
      child.type !== 'variable_assignment' &&
      !child.type.endsWith('_redirect'),
  )
}

/**
 * Every plain command's head word with its argument words.
 *
 * Head and arguments are reported as their literal text, or null for a
 * word no static read can spell (an expansion, a substitution), so a
 * caller matching names (the CLI env-name pruning) can tell "this word
 * is not there" from "this word is unknowable". A null head is the
 * stronger fact: the command that runs is not decidable before
 * expansion, so the fill pass treats the line as an opaque read.
 * Assignment prefixes and redirects are not arguments.
 */
export function commandInvocations(node: TSNodeLike): [string | null, (string | null)[]][] {
  const out: [string | null, (string | null)[]][] = []
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type !== 'command') continue
    const nameNode = current.childForFieldName?.('name') ?? null
    if (nameNode === null) continue
    const only = nameNode.namedChildren.length === 1 ? nameNode.namedChildren[0] : undefined
    const head = only !== undefined ? literalText(only) : null
    out.push([head, commandArgs(current).map(literalText)])
  }
  return out
}

/**
 * Identifier-shaped tokens in an arithmetic expression string.
 *
 * Bash evaluates a variable's value as an expression of its own
 * (`x="TOKEN + 1"; $((x))` reads TOKEN), so a caller chasing that
 * recursion needs the names a value may resolve. Over-approximates on
 * purpose: `0x1f` yields `x1f`, which reads nothing real and costs
 * nothing.
 */
export function identifierNames(text: string): ReadonlySet<string> {
  return new Set(text.match(IDENTIFIER_RE) ?? [])
}

/**
 * Names read inside one arithmetic region.
 *
 * The grammar is inconsistent about identifiers here: `$((name))`
 * holds a `variable_name` while a c-style for's `i<n` holds bare
 * `word` nodes, and a subscript's index is one `word` whose text is a
 * whole expression -- so words tokenize through `identifierNames`
 * rather than reading as one name.
 */
function arithRegionNames(region: TSNodeLike, out: Set<string>): void {
  for (const current of walkNamedOutsideDefs(region)) {
    if (current.type === 'variable_name') {
      if (current.text !== '') out.add(current.text)
    } else if (current.type === 'word') {
      if (current.text !== '') for (const name of identifierNames(current.text)) out.add(name)
    }
  }
}

/**
 * Names in a `${v:offset:length}` expansion's arithmetic part.
 *
 * The substring form is told apart from `${v:-d}` and friends by its
 * bare `:` token; everything after the first one is offset or length,
 * both evaluated as arithmetic.
 */
function substringArithNames(expansion: TSNodeLike, out: Set<string>): void {
  let seenColon = false
  for (const child of expansion.children) {
    if (!seenColon) {
      seenColon = child.type === ':'
      continue
    }
    if (child.isNamed === true || expansion.namedChildren.some((n) => sameNode(n, child))) {
      arithRegionNames(child, out)
    }
  }
}

/** Names the numeric comparators of one `[[` read as arithmetic. */
function testArithNames(test: TSNodeLike, out: Set<string>): void {
  for (const current of walkNamedOutsideDefs(test)) {
    if (current.type !== 'binary_expression') continue
    const operator = current.namedChildren.find((child) => child.type === 'test_operator')
    if (operator === undefined || !ARITH_TEST_OPERATORS.has(operator.text)) continue
    for (const child of current.namedChildren) {
      if (!sameNode(child, operator)) arithRegionNames(child, out)
    }
  }
}

/**
 * Names the program reads in an arithmetic context.
 *
 * Arithmetic resolution recurses through values (`name=TOKEN;
 * $((name))` reads TOKEN), so these names are the ones whose stored
 * values a fill plan must chase. The contexts mirror where the
 * executor calls `evaluateArith`: `$((...))` and `$[...]` expansions,
 * the `((...))` command, a c-style for's header, a subscript's index,
 * a `${v:offset:length}` offset, the `[[` numeric comparators, and
 * `let`'s operands. `test`/`[` are absent on purpose: the flat builtin
 * parses integers strictly, so a bare word there never resolves as a
 * variable.
 */
export function arithReads(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'arithmetic_expansion' || current.type === 'subscript') {
      arithRegionNames(current, out)
    } else if (
      current.type === 'compound_statement' &&
      current.children[0]?.type === ARITH_OPEN_TOKEN
    ) {
      arithRegionNames(current, out)
    } else if (current.type === 'c_style_for_statement') {
      for (const child of current.namedChildren) {
        if (child.type !== 'do_group') arithRegionNames(child, out)
      }
    } else if (current.type === 'expansion') {
      substringArithNames(current, out)
    } else if (current.type === 'test_command') {
      testArithNames(current, out)
    } else if (current.type === 'command') {
      const nameNode = current.childForFieldName?.('name') ?? null
      if (nameNode?.text !== 'let') continue
      for (const arg of commandArgs(current)) {
        arithRegionNames(arg, out)
        const literal = literalText(arg)
        if (literal !== null) for (const name of identifierNames(literal)) out.add(name)
      }
    }
  }
  return out
}

/**
 * Every plain assignment's target with what its value may hold.
 *
 * Per assignment: the target name, the value's literal text (null when
 * no static read can spell it, empty for a bare `X=`), and, for a
 * dynamic value, the names it reads -- an arithmetic read of the
 * target may recurse into whichever of those values lands
 * (`n=$other; $((n))` reads what `other` holds). Subscripted targets
 * are skipped: an element write never replaces the whole value.
 */
export function assignmentValues(node: TSNodeLike): [string, string | null, ReadonlySet<string>][] {
  const out: [string, string | null, ReadonlySet<string>][] = []
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type !== 'variable_assignment') continue
    const nameNode = current.childForFieldName?.('name') ?? null
    if (nameNode?.type !== 'variable_name' || nameNode.text === '') continue
    const valueNode = current.childForFieldName?.('value') ?? null
    const literal = valueNode === null ? '' : literalText(valueNode)
    const reads = literal === null ? referencedNames(current) : new Set<string>()
    out.push([nameNode.text, literal, reads])
  }
  return out
}

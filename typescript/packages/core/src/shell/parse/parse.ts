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

import { Language, type Node, Parser } from 'web-tree-sitter'

import { ARITH_OPEN_TOKEN, DIGIT, NAME_CONT, QUOTES } from './constants.ts'

export interface ShellParserConfig {
  engineWasm: Uint8Array | ArrayBuffer
  grammarWasm: Uint8Array | ArrayBuffer
}

export interface ShellParser {
  parse(command: string): Node
}

/**
 * Index just past the `)` closing the `(` at `start`.
 *
 * Parens inside quotes and backslash escapes do not count, so a command
 * substitution or a literal `")"` cannot throw off the depth. Returns
 * null when the parens never balance.
 */
function balancedEnd(text: string, start: number): number | null {
  let depth = 0
  let index = start
  let quote: string | null = null
  while (index < text.length) {
    const char = text[index] ?? ''
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
    } else if (char === '\\') {
      index += 2
      continue
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return null
}

/**
 * Whether the construct at `start` is a real arithmetic command.
 *
 * Decided by parsing the balanced span on its own: `((i++))` stands
 * alone cleanly, while `((echo x); echo $i)` does not. Judging each
 * opener separately is what keeps a valid `((i++))` safe when it shares
 * a line with a broken one, since tree-sitter's error region covers
 * both. An unbalanced span is assumed arithmetic and left alone.
 */
function isArithmetic(parser: Parser, command: string, start: number): boolean {
  const end = balancedEnd(command, start)
  if (end === null) return true
  const span = parser.parse(command.slice(start, end))
  return !span?.rootNode.hasError
}

/**
 * Offsets of `((` tokens the parser could not make sense of.
 *
 * Only openers inside an ERROR subtree are reported.
 */
function failedArithOpeners(root: Node): number[] {
  const offsets: number[] = []
  const stack: [Node, boolean][] = [[root, false]]
  for (;;) {
    const entry = stack.pop()
    if (entry === undefined) break
    const [node, inError] = entry
    const errored = inError || node.type === 'ERROR'
    if (errored && node.type === ARITH_OPEN_TOKEN) offsets.push(node.startIndex)
    for (const child of node.children) {
      stack.push([child, errored])
    }
  }
  return offsets
}

// Drop a trailing backslash that continues the line, as bash does. The
// reader removes `\<newline>` before the parser ever sees it, and a
// backslash ending the input is the same thing with nothing left to
// continue onto: `echo a\` runs `echo a`. Only an odd-length run of
// trailing backslashes ends in a live one, since each earlier pair is an
// escaped backslash (`echo a\\` keeps its literal backslash).
export function stripLineContinuation(command: string): string {
  let trailing = 0
  for (let i = command.length - 1; i >= 0 && command[i] === '\\'; i -= 1) trailing += 1
  return trailing % 2 === 1 ? command.slice(0, -1) : command
}

/**
 * Offsets of literal `$` tokens cut off from their variable name.
 *
 * tree-sitter-bash 0.25.1 stops lexing a later unbraced expansion in a
 * word when a name-terminating character follows it, so
 * `> /api/$c/$id.json` parses as `/api/$c/$` plus a sibling word
 * `id.json`: the `$` lands in the tree as a literal token and the
 * expansion is gone. A literal `$` directly followed by a name
 * character is a shape no correct bash lex produces (bash would have
 * read an expansion), so each one marks a mis-parse. The `$` opening a
 * simple_expansion is that expansion's own token and is skipped.
 */
function orphanedDollarOffsets(root: Node, text: string): number[] {
  const offsets: number[] = []
  const stack: Node[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    for (const child of node.children) {
      if (
        !child.isNamed &&
        child.type === '$' &&
        node.type !== 'simple_expansion' &&
        NAME_CONT.test(text[child.endIndex] ?? '')
      ) {
        offsets.push(child.startIndex)
      }
      stack.push(child)
    }
  }
  return offsets
}

/**
 * Rewrite the expansion at `offset` into its braced spelling.
 *
 * `$id.json` becomes `${id}.json`, which says the same thing and is the
 * spelling the grammar reads correctly. Bash reads a single digit after
 * `$` as one positional parameter, so `$12` rebraces as `${1}2`.
 */
function rebraceDollar(text: string, offset: number): string {
  let end = offset + 1
  if (DIGIT.test(text[end] ?? '')) {
    end += 1
  } else {
    while (end < text.length && NAME_CONT.test(text[end] ?? '')) end += 1
  }
  return `${text.slice(0, offset)}\${${text.slice(offset + 1, end)}}${text.slice(end)}`
}

/**
 * Rebrace mis-lexed expansions and reparse until none remain.
 *
 * Every rebrace consumes one bare `$` and never writes a new one, so
 * the loop is bounded by the count of `$` characters. A retry that
 * parses worse than what it replaces is discarded.
 */
function repairOrphanedDollars(parser: Parser, root: Node, text: string): Node {
  const bound = text.split('$').length - 1
  for (let i = 0; i < bound; i += 1) {
    const offsets = orphanedDollarOffsets(root, text)
    if (offsets.length === 0) break
    for (const offset of offsets.sort((a, b) => b - a)) {
      text = rebraceDollar(text, offset)
    }
    const retried = parser.parse(text)
    if (retried === null || retried.rootNode.hasError) break
    root = retried.rootNode
  }
  return root
}

// `Parser.init` boots one wasm module for the whole process, so two callers
// that start at the same time used to race it: the second read the language
// out of a half-built module and threw "Incompatible language version 0".
// Every caller now awaits the same boot. A failed boot is not kept, or one bad
// start would poison every later parser.
let engineBoot: Promise<void> | null = null

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  engineBoot ??= Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) }).catch(
    (err: unknown) => {
      engineBoot = null
      throw err
    },
  )
  await engineBoot
  const language = await Language.load(toUint8(config.grammarWasm))
  const parser = new Parser()
  parser.setLanguage(language)
  return {
    /**
     * Parse a shell command into a tree-sitter AST.
     *
     * A leading `((` is lexed as the arithmetic opener and the lexer
     * cannot back out, so a subshell that immediately opens another
     * subshell (`((echo a); echo b)`) fails to parse. Bash resolves the
     * same ambiguity by trying the arithmetic command and reparsing as
     * nested subshells when that fails; this does the same, splitting
     * only openers that already sit inside an error and keeping the
     * retry only if it parses cleanly. Commands that parse today are
     * untouched, so no working command's offsets move.
     *
     * A later unbraced `$var` followed by a name-terminating character
     * is mis-lexed by the grammar, leaving a literal `$` token behind
     * (see orphanedDollarOffsets); those expansions are rebraced and
     * the line reparsed, so the returned tree can spell `$id` as
     * `${id}`.
     */
    parse(command: string): Node {
      const source = stripLineContinuation(command)
      const tree = parser.parse(source)
      if (tree === null) {
        throw new Error('shell parse returned null')
      }
      let root = tree.rootNode
      let text = source
      if (root.hasError) {
        // Sitting inside an ERROR is not evidence that an opener is
        // broken: tree-sitter's error region swallows neighbouring tokens,
        // so a valid `((i++))` next to a bad opener reports as errored
        // too. Splitting it would silently turn arithmetic into a subshell
        // running `i++`, which is a wrong parse rather than a rejected
        // one. Each opener is judged on its own span instead.
        const offsets = [...new Set(failedArithOpeners(root))].filter(
          (o) => !isArithmetic(parser, source, o),
        )
        if (offsets.length > 0) {
          let split = source
          for (const offset of offsets.sort((a, b) => b - a)) {
            split = `${split.slice(0, offset + 1)} ${split.slice(offset + 1)}`
          }
          const retried = parser.parse(split)
          if (retried !== null && !retried.rootNode.hasError) {
            root = retried.rootNode
            text = split
          }
        }
      }
      if (text.includes('$')) {
        root = repairOrphanedDollars(parser, root, text)
      }
      return root
    },
  }
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

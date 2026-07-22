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

export interface ShellParserConfig {
  engineWasm: Uint8Array | ArrayBuffer
  grammarWasm: Uint8Array | ArrayBuffer
}

export interface ShellParser {
  parse(command: string): Node
}

export type { Node as ShellNode } from 'web-tree-sitter'

const ARITH_OPEN_TOKEN = '(('
const QUOTES = new Set(["'", '"'])

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

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  await Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) })
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
     */
    parse(command: string): Node {
      const tree = parser.parse(command)
      if (tree === null) {
        throw new Error('shell parse returned null')
      }
      const root = tree.rootNode
      if (!root.hasError) return root
      // Sitting inside an ERROR is not evidence that an opener is
      // broken: tree-sitter's error region swallows neighbouring tokens,
      // so a valid `((i++))` next to a bad opener reports as errored
      // too. Splitting it would silently turn arithmetic into a subshell
      // running `i++`, which is a wrong parse rather than a rejected
      // one. Each opener is judged on its own span instead: `((i++))`
      // stands alone cleanly, `((echo x); echo $i)` does not. An
      // unbalanced span is assumed arithmetic and left alone.
      const isArithmetic = (start: number): boolean => {
        const end = balancedEnd(command, start)
        if (end === null) return true
        const span = parser.parse(command.slice(start, end))
        return !span?.rootNode.hasError
      }
      const offsets = [...new Set(failedArithOpeners(root))].filter((o) => !isArithmetic(o))
      if (offsets.length === 0) return root
      let text = command
      for (const offset of offsets.sort((a, b) => b - a)) {
        text = `${text.slice(0, offset + 1)} ${text.slice(offset + 1)}`
      }
      const retried = parser.parse(text)
      if (retried === null) return root
      return retried.rootNode.hasError ? root : retried.rootNode
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

const BASH_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
])

const STRUCTURAL_TOKENS: ReadonlySet<string> = new Set([
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '`',
])

function isStructuralError(node: Node): boolean {
  for (const child of node.children) {
    if (child.isNamed) return true
    if (BASH_KEYWORDS.has(child.type)) return true
    if (STRUCTURAL_TOKENS.has(child.type)) return true
  }
  return false
}

function walkNamed(node: Node): Node[] {
  const out: Node[] = [node]
  for (const child of node.namedChildren) out.push(...walkNamed(child))
  return out
}

function isRecoveredQuotedHeredocEnd(previous: Node | null, error: Node): boolean {
  if (previous === null) return false
  const errorText = error.text.trim()
  if (errorText.length === 0) return false
  for (const candidate of walkNamed(previous)) {
    if (candidate.type !== 'heredoc_redirect') continue
    let start: string | null = null
    let end: string | null = null
    for (const child of candidate.namedChildren) {
      if (child.type === 'heredoc_start') start = child.text
      else if (child.type === 'heredoc_end') end = child.text
    }
    if (
      start !== null &&
      (start.includes("'") || start.includes('"')) &&
      (end === null || end.length === 0) &&
      start.replaceAll("'", '').replaceAll('"', '') === errorText
    ) {
      return true
    }
  }
  return false
}

/**
 * Locate a top-level structural syntax error in a parsed AST.
 *
 * Tree-sitter often recovers from minor anomalies (e.g. `for x in;`) by
 * producing a valid statement with an internal ERROR token. Bash accepts
 * those, so we only flag errors that surface as direct children of
 * `program` AND contain a bash keyword, a bracket / quote, or a recovered
 * named subtree. Stand-alone statement separators (`;`, `&`, `|`) inside an
 * ERROR are deliberately not flagged because bash itself accepts e.g. `& ;`.
 *
 * Returns the offending region's text, or `null` if the AST is clean.
 */
export function findSyntaxError(node: Node): string | null {
  if (!node.hasError) return null
  let previous: Node | null = null
  for (const child of node.children) {
    if (child.isMissing) return child.text
    if (child.type === 'ERROR' && isStructuralError(child)) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return child.text
    }
    if (child.isNamed) previous = child
  }
  return null
}

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

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  await Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) })
  const language = await Language.load(toUint8(config.grammarWasm))
  const parser = new Parser()
  parser.setLanguage(language)
  return {
    parse(command: string): Node {
      const tree = parser.parse(command)
      if (tree === null) {
        throw new Error('shell parse returned null')
      }
      return tree.rootNode
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

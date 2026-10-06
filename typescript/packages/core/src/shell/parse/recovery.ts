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

import { type NativeParser } from './engine.ts'
import { scanParameter } from '../parameter.ts'
import { ARITH_OPEN_TOKEN, QUOTES } from './constants.ts'
import { expansionSource } from './expansion.ts'
import { protectedSource } from './heredoc/index.ts'
import { delimiterEnd } from './heredoc/reader.ts'
import { SourceNode } from './source.ts'
import type { ShellNode } from '../types.ts'

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

export function isArithmetic(parser: NativeParser, command: string, start: number): boolean {
  const end = balancedEnd(command, start)
  if (end === null) return true
  const span = parser.parse(command.slice(start, end))
  return !span?.rootNode.hasError
}

const UNLEXED = new Set([
  'test_command',
  'arithmetic_expansion',
  'string_content',
  'raw_string',
  'ansi_c_string',
  'expansion',
  'heredoc_content',
  'comment',
  'binary_expression',
  'unary_expression',
  'postfix_expression',
])

const WORD_START = ' \t\n;&|(){}'

const DIGITS = /\d+/y

const LAST_ARM = /^\s*esac(?![^\s;&|()<>])/

const BARE_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['command', new Set(['==', '=~'])],
  ['ERROR', new Set(['==', '=~', '$'])],
])

const WORD_BREAK = ' \t\n;&|()<>'

const LIST_TOKENS = new Set(['&&', '||', '|', '|&', ';', '&', ';;'])

const TEST_PARTS = new Set([
  'binary_expression',
  'unary_expression',
  'negation_expression',
  'parenthesized_expression',
  'ERROR',
])

function breaksWord(text: string, at: number): boolean {
  return at < 0 || at >= text.length || WORD_BREAK.includes(text[at] ?? '')
}

function bracketIsACommand(text: string, node: ShellNode): boolean {
  const children = node.children
  if (children[0]?.type !== '[') return false
  const close = children[children.length - 1]
  if (close?.type !== ']' || close.isMissing) return true
  if (!breaksWord(text, close.endIndex)) return true
  const stack = children.slice(1, -1)
  for (let part = stack.pop(); part !== undefined; part = stack.pop()) {
    if (!part.isNamed && LIST_TOKENS.has(part.type)) return true
    if (TEST_PARTS.has(part.type)) stack.push(...part.children)
  }
  return false
}

export function operatorSource(parser: NativeParser, text: string, root: ShellNode): string {
  let current = text
  let lexed = respelled(current, root)
  while (lexed !== current) {
    current = lexed
    const tree = parser.parse(current)
    if (tree === null) return current
    lexed = respelled(current, tree.rootNode)
  }
  return current
}

function respelled(text: string, root: ShellNode): string {
  const out = text.split('')
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'test_command' && bracketIsACommand(text, node)) out[node.startIndex] = '_'
    if (UNLEXED.has(node.type)) continue
    stack.push(...node.children)
    const bare = BARE_WORDS.get(node.type)
    for (const child of node.children) {
      if (child.isNamed) continue
      if (bare?.has(child.type) === true) {
        if (child.type === '$' && text[child.endIndex] === '"') continue
        for (let i = child.startIndex; i < child.endIndex; i++) out[i] = '_'
      } else if (
        node.type === 'ERROR' &&
        child.type === '[' &&
        breaksWord(text, child.startIndex - 1) &&
        breaksWord(text, child.endIndex)
      ) {
        out[child.startIndex] = '_'
      }
    }
    const start = node.startIndex
    if (node.type === '<' && text.startsWith('<>', start)) out[start] = '>'
    else if ((node.type === '<<<' || node.type === '<<') && text.startsWith('<<<', start)) {
      out[start + 1] = ' '
      out[start + 2] = ' '
    } else if (
      (node.type === ';&' || node.type === ';;&') &&
      LAST_ARM.test(text.slice(node.endIndex))
    ) {
      out[start] = ';'
      out[start + 1] = ';'
      if (node.type === ';;&') out[start + 2] = ' '
    }
    if (node.childCount > 0 || text[start] !== '0') continue
    if (start > 0 && !WORD_START.includes(text[start - 1] ?? '')) continue
    DIGITS.lastIndex = start
    const end = start + (DIGITS.exec(text)?.[0].length ?? 0)
    if (text[end] === '<' || text[end] === '>') out[start] = '1'
  }
  return out.join('')
}

export function parseProtected(parser: NativeParser, text: string): ShellNode {
  const tree = parser.parse(text)
  if (tree === null) throw new Error('shell parse returned null')
  let shieldedText = expansionSource(
    (text.includes('<<') ? protectedSource(text, tree.rootNode) : null) ?? text,
    tree.rootNode,
  )
  shieldedText = operatorSource(parser, shieldedText, tree.rootNode)
  if (shieldedText === text) return tree.rootNode
  const shielded = parser.parse(shieldedText)
  if (shielded === null) return tree.rootNode
  const original = errors(tree.rootNode)
  if (![...errors(shielded.rootNode)].every((span) => original.has(span))) return tree.rootNode
  return new SourceNode(shielded.rootNode, text)
}

export function failedArithOpeners(root: ShellNode): number[] {
  const offsets: number[] = []
  const stack: [ShellNode, boolean][] = [[root, false]]
  for (;;) {
    const entry = stack.pop()
    if (entry === undefined) break
    const [node, inError] = entry
    const errored = inError || node.type === 'ERROR'
    for (const child of node.children) {
      if (child.type === ARITH_OPEN_TOKEN && (errored || node.hasError)) {
        offsets.push(child.startIndex)
      }
      stack.push([child, errored])
    }
  }
  return offsets
}

function orphanedDollarOffsets(root: ShellNode, text: string): number[] {
  const offsets: number[] = []
  const stack: ShellNode[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    for (const child of node.children) {
      if (
        !child.isNamed &&
        child.type === '$' &&
        node.type !== 'simple_expansion' &&
        text[child.endIndex] !== '{' &&
        scanParameter(text, child.startIndex) !== null
      ) {
        offsets.push(child.startIndex)
      }
      stack.push(child)
    }
  }
  return offsets
}

function rebraceDollar(text: string, offset: number): string {
  const ref = scanParameter(text, offset)
  if (ref === null) return text
  const [name, end] = ref
  return `${text.slice(0, offset)}\${${name}}${text.slice(end)}`
}

export function repairOrphanedDollars(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): ShellNode {
  const bound = text.split('$').length - 1
  for (let i = 0; i < bound; i += 1) {
    const offsets = orphanedDollarOffsets(root, text)
    if (offsets.length === 0) break
    for (const offset of offsets.sort((a, b) => b - a)) {
      text = rebraceDollar(text, offset)
    }
    const retried = parseProtected(parser, text)
    if (retried.hasError) break
    root = retried
  }
  return root
}

export function repairRedirectDashes(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
  // Quote only an uncovered dash before a redirect, never word or heredoc text.
  const offsets: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    let end = node.startIndex
    for (const child of node.children) {
      const gap = text.slice(end, child.startIndex)
      if (child.type === 'file_redirect' && gap.trim() === '-') {
        offsets.push(end + gap.indexOf('-'))
      }
      end = child.endIndex
      stack.push(child)
    }
  }
  if (offsets.length === 0) return [root, text]
  let repaired = text
  for (const offset of [...new Set(offsets)].sort((a, b) => b - a)) {
    repaired = `${repaired.slice(0, offset)}'-'${repaired.slice(offset + 1)}`
  }
  const retried = parseProtected(parser, repaired)
  return retried.hasError ? [root, text] : [retried, repaired]
}

const NAME = /^\w+$/

const FOLLOWER = /^\s*(in|do)(?![^\s;&|()<>])/

function headerInserts(root: ShellNode, text: string): [number, string][] {
  const heads: number[] = []
  const stack = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    stack.push(...node.children)
    if (node.type !== 'for_statement' && node.type !== 'ERROR') continue
    for (const kid of node.children) {
      if (kid.type === 'for' || kid.type === 'select') heads.push(kid.endIndex)
    }
  }
  const inserts: [number, string][] = []
  for (const head of heads) {
    const start = text.length - text.slice(head).replace(/^[ \t]+/, '').length
    const end = delimiterEnd(text, start) ?? start
    const word = FOLLOWER.exec(text.slice(end))?.[1]
    const named = NAME.test(text.slice(start, end))
    if (end === start || (named && word === 'in')) continue
    const tail = word === 'do' ? ';' : ''
    if (named) inserts.push([end, ` in "$@"${tail}`])
    else inserts.push([start, '0 in '], [end, tail])
  }
  return inserts
}

export function repairForHeaders(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
  // Encode invalid names for runtime validation and supply omitted "$@".
  // Repeat to expose nested headers; accept only repairs adding no errors.
  let [repaired, retried] = [text, root]
  for (let inserts = headerInserts(root, text); inserts.length > 0;) {
    for (const [offset, insert] of inserts.sort((a, b) => b[0] - a[0])) {
      repaired = repaired.slice(0, offset) + insert + repaired.slice(offset)
    }
    retried = parseProtected(parser, repaired)
    inserts = headerInserts(retried, repaired)
  }
  return retried === root || errors(retried).size > errors(root).size
    ? [root, text]
    : [retried, repaired]
}

function errors(root: ShellNode): Set<string> {
  const spans = new Set<string>()
  const stack = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    stack.push(...node.children)
    if (node.type === 'ERROR' || node.isMissing)
      spans.add(`${String(node.startIndex)}:${String(node.endIndex)}`)
  }
  return spans
}

export function statementBoundaries(parser: NativeParser, text: string): string {
  if (!text.includes('\n')) return text
  const root = parser.parse(text)?.rootNode
  if (root === undefined) return text
  const offsets = new Set<number>()
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    if (!['command', 'file_redirect', 'redirected_statement'].includes(node.type)) continue
    const children = node.children
    for (let i = 1; i < children.length; i += 1) {
      const left = children[i - 1]
      const right = children[i]
      if (left === undefined || right === undefined) continue
      const gap = text.slice(left.endIndex, right.startIndex)
      if (gap.includes('\n') && gap.trim() === '') offsets.add(left.endIndex + gap.indexOf('\n'))
    }
  }
  for (const offset of [...offsets].sort((a, b) => b - a))
    text = text.slice(0, offset) + ';' + text.slice(offset)
  return text
}

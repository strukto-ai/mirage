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

import type { TSNodeLike } from '../../types.ts'
import { heredocBodies, nextLine } from './body.ts'
import {
  CASE,
  COMMENT_PRECEDERS,
  ESAC,
  HEREDOC_START,
  KEPT_TERMINATORS,
  QUOTE_OPENERS,
  WORD_BREAKERS,
} from './constants.ts'
import { ansiCEnd } from './delimiter.ts'
import { constructCloser, constructEnd, operatorLineEnd, quoteEnd, reservedWord } from './line.ts'
import { heredocOperators } from './shield.ts'
import type { HeredocOperator, Terminator } from './types.ts'

/**
 * Index of the first unquoted metacharacter inside a delimiter token.
 *
 * tree-sitter-bash reads an unquoted delimiter up to the next blank, so
 * `cat <<EOF; echo x` gets the token `EOF;` and then waits for a line
 * reading `EOF;`, while bash ends the word at the `;`. Quotes and
 * backslashes count the way the word is read: `'EOF;'` really does name
 * `EOF;` and `E'O;'F;` breaks at its last character. Returns null when the
 * token is one word (a token opening with a metacharacter is left to the
 * parser's own refusal).
 */
export function delimiterBreak(token: string): number | null {
  let quote: string | null = null
  let index = 0
  while (index < token.length) {
    const char = token[index] ?? ''
    if (quote === "'") {
      if (char === "'") quote = null
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\') index += 1
    } else if (char === '$' && token[index + 1] === "'") {
      index = ansiCEnd(token, index + 2)
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '\\') {
      index += 1
    } else if (WORD_BREAKERS.has(char)) {
      return index === 0 ? null : index
    }
    index += 1
  }
  return null
}

/**
 * Offsets where a heredoc_start token runs past its word.
 *
 * Each is where a blank goes so the parser ends the delimiter where bash
 * does. ERROR subtrees are walked too, since the mis-read token usually
 * leaves the rest of the line unparseable.
 */
export function wordBreaks(root: TSNodeLike): number[] {
  const offsets: number[] = []
  const stack: TSNodeLike[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    if (node.type !== HEREDOC_START || node.startIndex === undefined) continue
    const index = delimiterBreak(node.text)
    if (index !== null) offsets.push(node.startIndex + index)
  }
  return offsets
}

/**
 * The statement terminators between `start` and `end` of a line.
 *
 * Read the way operatorLineEnd reads the line: a backslash escapes the
 * next character, quotes hide their contents, `$(`, `<(`, `>(` and `${`
 * run to their close, and a `#` opening a word ends the search. A bare
 * `(` opens a subshell or arithmetic command that moves whole, so it runs
 * to its balancing paren too. A `)` that ends a case pattern terminates
 * nothing, so an open `case` is counted and its patterns' parens passed
 * over; the `;;` closing an item is a terminator, since bash reads one at
 * the start of a line.
 */
export function lineTerminators(text: string, start: number, end: number): Terminator[] {
  const found: Terminator[] = []
  let index = start
  let cases = 0
  while (index < end) {
    const char = text[index] ?? ''
    const closer = constructCloser(text, index, false)
    if (char === '\\') {
      index += 2
      continue
    }
    let closed: number | null = null
    if (QUOTE_OPENERS.has(char)) {
      closed = quoteEnd(text, index)
    } else if (closer !== null) {
      closed = constructEnd(text, index, closer)
    } else if (char === '(') {
      closed = constructEnd(text, index, ')')
    } else {
      if (char === '#' && COMMENT_PRECEDERS.has(text[index - 1] ?? '')) break
      if (reservedWord(text, index, CASE)) {
        cases += 1
        index += CASE.length
        continue
      }
      if (cases > 0 && reservedWord(text, index, ESAC)) {
        cases -= 1
        index += ESAC.length
        continue
      }
      if (char === ')' && cases > 0) {
        index += 1
        continue
      }
      const kept = KEPT_TERMINATORS.find((token) => text.startsWith(token, index))
      if (kept !== undefined) {
        found.push({ start: index, resume: index })
        index += kept.length
        continue
      }
      if (char === ';') found.push({ start: index, resume: index + 1 })
      index += 1
      continue
    }
    if (closed === null) break
    index = closed
  }
  return found
}

/** Offset just past the terminator line of the body at `span`. */
export function blockEnd(text: string, span: readonly [number, number]): number {
  return nextLine(text, span[1]) ?? text.length
}

/** The body at `span` with its terminator line, newline-ended. */
function block(text: string, span: readonly [number, number]): string {
  const piece = text.slice(span[0], blockEnd(text, span))
  return piece.endsWith('\n') ? piece : `${piece}\n`
}

/**
 * `text` with one operator line laid out as the grammar needs it.
 *
 * The line is cut at the first terminator after each operator, so a
 * statement typed after the operator moves to the line after its body
 * (`cat <<EOF; echo x` becomes `cat <<EOF`, the body, `echo x`), and each
 * segment's bodies follow that segment innermost-first, the reverse of
 * the order bash gathers them, because the grammar nests every later
 * statement of a line inside the earlier redirect and closes the
 * innermost body first. `bodies` holds the bash body span of every
 * operator that has one, by index into `operators`; `members` are the
 * indices of the operators on this line, in source order, every one in
 * `bodies`; `lineEnd` is the offset of the newline ending the line.
 */
export function relaidLine(
  text: string,
  operators: readonly HeredocOperator[],
  bodies: ReadonlyMap<number, readonly [number, number]>,
  members: readonly number[],
  lineEnd: number,
): string {
  const first = members[0] === undefined ? undefined : operators[members[0]]
  if (first === undefined) return text
  const terminators = lineTerminators(text, first.wordEnd, lineEnd)
  const cuts: Terminator[] = []
  for (const index of members) {
    const wordEnd = operators[index]?.wordEnd ?? 0
    const cut = terminators.find((t) => t.start >= wordEnd)
    if (cut !== undefined && !cuts.includes(cut)) cuts.push(cut)
  }
  const segments: number[][] = cuts.map(() => [])
  segments.push([])
  for (const index of members) {
    const wordEnd = operators[index]?.wordEnd ?? 0
    const found = cuts.findIndex((cut) => cut.start >= wordEnd)
    segments[found < 0 ? cuts.length : found]?.push(index)
  }
  const headEnd = cuts[0]?.start ?? lineEnd
  const pieces = [text.slice(0, headEnd)]
  segments.forEach((segment, position) => {
    pieces.push('\n')
    for (const index of [...segment].reverse()) {
      const span = bodies.get(index)
      if (span !== undefined) pieces.push(block(text, span))
    }
    const cut = cuts[position]
    if (cut !== undefined) {
      const tailEnd = cuts[position + 1]?.start ?? lineEnd
      pieces.push(text.slice(cut.resume, tailEnd))
    }
  })
  let last = 0
  for (const index of members) {
    const span = bodies.get(index)
    if (span !== undefined) last = Math.max(last, blockEnd(text, span))
  }
  pieces.push(text.slice(last))
  return pieces.join('')
}

/**
 * `text` rewritten so tree-sitter-bash reads its heredocs as bash does.
 *
 * The grammar keeps everything after a heredoc operator, up to its body,
 * inside the redirect, so two shapes bash accepts do not parse: a
 * statement terminator on the operator line (`cat <<EOF; echo x`,
 * `(cat <<EOF)`, a `;;` closing a case item), and two heredocs on one
 * line whose bodies follow in source order (`cat <<A && cat <<B` with
 * `A`'s body first, which is what bash gathers). Both are a matter of
 * where the text sits, so the source is laid out the way the grammar
 * needs it and the same text reaches the same commands: a tail moves to
 * the line after the bodies it was typed before, and a line's bodies
 * stand innermost-first. Bash reads `;` and a newline alike, so the
 * rewritten source says what the typed one did; the one thing that moves
 * is the row a moved statement runs on. Bodies are read from the typed
 * source as bash gathers them; a body no line closes runs to the end of
 * the source and nothing can be moved past it, so such a tree is left
 * alone. Returns null when the layout already is the grammar's.
 */
export function relayout(root: TSNodeLike, text: string): string | null {
  const operators = heredocOperators(root)
  const bodies = new Map<number, readonly [number, number]>()
  const lines = new Map<number, number[]>()
  const spans = heredocBodies(text, operators, false)
  for (const [index, span] of spans.entries()) {
    if (span === null) continue
    if (span[1] >= text.length) return null
    const operator = operators[index]
    if (operator === undefined) continue
    const lineEnd = operatorLineEnd(text, operator.wordEnd)
    if (lineEnd === null) continue
    bodies.set(index, span)
    const members = lines.get(lineEnd) ?? []
    members.push(index)
    lines.set(lineEnd, members)
  }
  let out = text
  for (const lineEnd of [...lines.keys()].sort((a, b) => b - a)) {
    out = relaidLine(out, operators, bodies, lines.get(lineEnd) ?? [], lineEnd)
  }
  return out === text ? null : out
}

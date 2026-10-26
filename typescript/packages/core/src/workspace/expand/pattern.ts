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

import type { ExecuteFn } from './types.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { SessionView } from '../../view/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { posixEscape } from '../../rs/regex.ts'
import { decodeAnsiC } from '../../shell/escapes.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { escapeGlob } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'

import { homeDir } from '../session/shell_dirs.ts'
import { expandNode } from './node.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/** A piece of a pattern word: its text, and whether it matches only itself. */
type Piece = readonly [string, boolean]

/** An unquoted word's text: live, each character a backslash escapes literal. */
function unquotedPieces(text: string): Piece[] {
  const out: Piece[] = []
  let run = 0
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const escaped = String.fromCodePoint(text.codePointAt(i + 1) ?? 0)
      if (i > run) out.push([text.slice(run, i), false])
      out.push([escaped, true])
      i += 1 + escaped.length
      run = i
      continue
    }
    i += 1
  }
  if (text.length > run) out.push([text.slice(run), false])
  return out
}

/**
 * One pattern word as bash 5.2 reads it: text under any quote is literal,
 * unquoted text keeps its special characters live with a backslash escaping
 * the next one, an expansion's value is live when unquoted and literal inside
 * double quotes, and a leading tilde names the home directory as literal
 * text. Patterns are never word-split, so `$p` holding `a b` matches the word
 * `a b`. `leading` says whether a tilde prefix may start the node: it starts
 * the word, and the prefix, which runs to the first unquoted slash, ends
 * inside it (`~""` stays literal).
 */
async function patternPieces(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view: SessionView | undefined,
  leading: boolean,
): Promise<Piece[]> {
  const ntype = tsNode.type
  if (ntype === NT.WORD || ntype === NT.EXTGLOB_PATTERN || ntype === NT.REGEX) {
    const raw = tsNode.text
    if (leading && raw.startsWith('~')) {
      const expanded = expandTilde(raw, homeDir(context.session))
      if (expanded !== raw) {
        const rest = raw.slice(1)
        const home = expanded.slice(0, expanded.length - rest.length)
        return [[home, true], ...unquotedPieces(rest)]
      }
    }
    return unquotedPieces(raw)
  }
  if (ntype === NT.RAW_STRING) return [[tsNode.text.slice(1, -1), true]]
  if (ntype === NT.ANSI_C_STRING) return [[decodeAnsiC(tsNode.text.slice(2, -1)), true]]
  if (ntype === NT.STRING)
    return [[await expandNode(tsNode, context, executeFn, callStack, view), true]]
  if (ntype === NT.TRANSLATED_STRING) {
    for (const child of tsNode.namedChildren) {
      if (child.type === NT.STRING) {
        return [[await expandNode(child, context, executeFn, callStack, view), true]]
      }
    }
    return []
  }
  if (ntype === NT.CONCATENATION) {
    const pieces: Piece[] = []
    const children = tsNode.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      // A $"..." inside a concatenation arrives as an anonymous `$` token
      // followed by the string node; the `$` is the translation marker,
      // not text (same rule as expandNode).
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) continue
      const prefix =
        leading &&
        pieces.length === 0 &&
        (position + 1 === children.length || child.text.includes('/'))
      for (const piece of await patternPieces(child, context, executeFn, callStack, view, prefix))
        pieces.push(piece)
    }
    return pieces
  }
  return [[await expandNode(tsNode, context, executeFn, callStack, view), false]]
}

/**
 * Expand one pattern word into the matcher's glob dialect, as case patterns,
 * the right side of `[[ == ]]` and quoted parameter-expansion operands read
 * it (`patternPieces`).
 */
export async function expandPattern(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  const pieces = await patternPieces(tsNode, context, executeFn, callStack, view, true)
  return pieces.map(([text, literal]) => (literal ? escapeGlob(text) : text)).join('')
}

/**
 * Expand the right side of `[[ =~ ]]` into a POSIX extended regex, read as a
 * pattern word (`patternPieces`).
 */
export async function expandRegex(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  return regexText(await patternPieces(tsNode, context, executeFn, callStack, view, true))
}

/**
 * Pattern pieces as a POSIX extended regex. A literal character is escaped,
 * except inside a bracket expression, where a backslash is a member of its
 * own and every character stands for itself: bash reads `['^'a]` as `[^a]`
 * and `[a'-'c]` as a range. The pieces are joined as they are, so a live
 * backslash escapes only a live character after it.
 */
function regexText(pieces: Piece[]): string {
  const chars: Piece[] = pieces.flatMap(([text, literal]) =>
    Array.from(text, (ch): Piece => [ch, literal]),
  )
  const at = (index: number): string => chars[index]?.[0] ?? ''
  const out: string[] = []
  let members = -1
  const unclosed = new Set<string>()
  let i = 0
  while (i < chars.length) {
    const ch = at(i)
    const literal = chars[i]?.[1] === true
    if (members < 0) {
      if (literal) {
        out.push(posixEscape(ch))
      } else if (ch === '\\' && i + 1 < chars.length && chars[i + 1]?.[1] === false) {
        out.push(ch + at(i + 1))
        i += 1
      } else {
        out.push(ch)
        if (ch === '[') {
          if (at(i + 1) === '^') {
            out.push('^')
            i += 1
          }
          members = i + 1
        }
      }
      i += 1
      continue
    }
    const next = at(i + 1)
    // A delimiter whose closing pair is missing is missing after any later
    // opening too, so the search runs once for it.
    if (ch === '[' && (next === ':' || next === '.' || next === '=') && !unclosed.has(next)) {
      let close = -1
      for (let j = i + 2; j < chars.length - 1; j += 1) {
        if (at(j) === next && at(j + 1) === ']') {
          close = j
          break
        }
      }
      if (close >= 0) {
        for (let j = i; j < close + 2; j += 1) out.push(at(j))
        i = close + 2
        continue
      }
      unclosed.add(next)
    }
    out.push(ch)
    if (ch === ']' && i > members) members = -1
    i += 1
  }
  return out.join('')
}

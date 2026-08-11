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

import type { CallStack } from '../../shell/call_stack.ts'
import { decodeAnsiC } from '../../shell/escapes.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { escapeGlob } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { expandNode, type ExecuteFn } from './node.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/** An unquoted word as a pattern: globs live, backslash escapes. */
function unquotedPattern(text: string): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === '\\' && i + 1 < text.length) {
      out.push(escapeGlob(text[i + 1] ?? ''))
      i += 2
      continue
    }
    out.push(c)
    i += 1
  }
  return out.join('')
}

/**
 * A double-quoted pattern segment: everything in it is literal.
 *
 * Mirrors expandNode's string walk (dquote skipping), but the value of each
 * piece - string content and quoted expansions alike - is escaped so its
 * glob characters match themselves.
 */
async function quotedStringPattern(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string> {
  const parts: string[] = []
  let prevEndRow: number | null = null
  for (const child of tsNode.children) {
    if (prevEndRow !== null) {
      parts.push('\n'.repeat(Math.max(0, (child.startPosition?.row ?? 0) - prevEndRow)))
    }
    prevEndRow = child.endPosition?.row ?? 0
    if (child.type === NT.DQUOTE) continue
    parts.push(escapeGlob(await expandNode(child, session, executeFn, callStack)))
  }
  return parts.join('')
}

/**
 * Expand one pattern word into the matcher's glob dialect.
 *
 * bash 5.2 semantics, shared by case patterns, the `[[ == ]]` right side
 * and quoted parameter-expansion operands: text under any quote matches
 * literally, unquoted text keeps its glob characters live with backslash
 * escaping the next character, and an expansion's value is a live pattern
 * when unquoted but literal inside double quotes. Patterns are never
 * word-split, so `$p` holding `a b` matches the word `a b`.
 */
export async function expandPattern(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string> {
  const ntype = tsNode.type
  if (ntype === NT.WORD || ntype === NT.EXTGLOB_PATTERN) {
    let raw = tsNode.text
    if (raw.startsWith('~')) raw = expandTilde(raw, homeDir(session))
    return unquotedPattern(raw)
  }
  if (ntype === NT.RAW_STRING) return escapeGlob(tsNode.text.slice(1, -1))
  if (ntype === NT.ANSI_C_STRING) return escapeGlob(decodeAnsiC(tsNode.text.slice(2, -1)))
  if (ntype === NT.STRING) return quotedStringPattern(tsNode, session, executeFn, callStack)
  if (ntype === NT.TRANSLATED_STRING) {
    for (const child of tsNode.namedChildren) {
      if (child.type === NT.STRING) {
        return quotedStringPattern(child, session, executeFn, callStack)
      }
    }
    return ''
  }
  if (ntype === NT.CONCATENATION) {
    const parts: string[] = []
    const children = tsNode.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      // A $"..." inside a concatenation arrives as an anonymous `$` token
      // followed by the string node; the `$` is the translation marker,
      // not text (same rule as expandNode).
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) continue
      parts.push(await expandPattern(child, session, executeFn, callStack))
    }
    return parts.join('')
  }
  return expandNode(tsNode, session, executeFn, callStack)
}

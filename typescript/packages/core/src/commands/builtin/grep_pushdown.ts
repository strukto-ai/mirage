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

import type { PathSpec } from '../../types.ts'
import { PatternType } from './constants.ts'
import { hasUnresolvedGlob } from './utils/paths.ts'
import { isStdin } from './utils/stream.ts'
import { UNICODE_FOLDED, foldsByUnicode, requiredNeedles } from './grep_prefilter.ts'

// Classify a grep pattern for API push-down decisions.
export function classifyPattern(pattern: string, fixedString: boolean): PatternType {
  if (pattern.includes('\n')) return PatternType.REGEX
  if (fixedString) return PatternType.EXACT
  if (/^[\p{L}\p{N}_\s\-.]+$/u.test(pattern)) return PatternType.SIMPLE
  return PatternType.REGEX
}

const MIN_SEARCH_LITERAL = 3

// Whether the pattern is searched verbatim, with no regex extraction.
// Push-down against a whole-word search index is only complete when the term
// handed to the provider is the entire match. A regex narrowed on an extracted
// literal fails that: `foo[0-9]` under -w matches `foo1`, but a whole-word
// search for `foo` never returns a file whose only token is `foo1`.
export function isLiteralPattern(pattern: string, fixedString: boolean): boolean {
  if (fixedString) return true
  const pt = classifyPattern(pattern, fixedString)
  return pt === PatternType.EXACT || (pt === PatternType.SIMPLE && !pattern.includes('.'))
}

/**
 * The terms a whole-word search index may narrow a scan on, or null.
 *
 * A newline-joined pattern list (several -e, or the lines of -f) matches a
 * line when any one alternative does, so one search per alternative, unioned,
 * is complete when every alternative is itself a whole-word literal. -x narrows as -w does: a line that is the
 * literal entire is a word match of it. An empty alternative matches every
 * line, which no search can stand in for. Mirrors Python's
 * `whole_word_literals`.
 */
export function wholeWordLiterals(
  pattern: string | null,
  fixedString: boolean,
  wholeWord: boolean,
  lineRegexp = false,
): string[] | null {
  if (pattern === null || !(wholeWord || lineRegexp)) return null
  const terms = pattern.split('\n')
  if (terms.some((t) => t === '' || !isLiteralPattern(t, fixedString))) return null
  return [...new Set(terms)]
}

/**
 * The texts a mount's search is asked for, and whether as whole words.
 * Literals under -w or -x are asked as whole words, which a word index can
 * answer; any other pattern is narrowed on the needles one of which every
 * match contains, asked anywhere. Under -i a literal with a non-ASCII letter,
 * or with k or s when case folds by Unicode (`ſ` matches `s`), is left to
 * the scan, since a mount's case folding need not be grep's. Mirrors Python's
 * `search_terms`.
 */
export function searchTerms(
  pattern: string | null,
  matcher: RegExp,
  fixedString: boolean,
  wholeWord: boolean,
  lineRegexp: boolean,
  ignoreCase: boolean,
): [string[], boolean] | null {
  const words = wholeWordLiterals(pattern, fixedString, wholeWord, lineRegexp)
  const untrusted = (w: string): boolean =>
    /[\u0080-\uffff]/.test(w) || (foldsByUnicode(matcher) && UNICODE_FOLDED.test(w.toLowerCase()))
  if (words !== null && !(ignoreCase && words.some(untrusted))) {
    return [words, true]
  }
  const needles = requiredNeedles(matcher)
  if (needles === null || needles.some((n) => n.length < MIN_SEARCH_LITERAL)) return null
  return [needles, false]
}

// The one operand a search push-down may answer for, or null. A push-down
// asks the backend a single whole-container question and prints its entire
// answer, so it can only stand in for a line naming exactly one operand; given
// two it answers for the first and drops the rest in silence. A glob operand
// defers since an unexpanded pattern segment would be read as a literal name,
// and a `-` operand since it is the line's stdin, which no backend holds.
export function loneOperand(paths: PathSpec[]): PathSpec | null {
  if (paths.length !== 1 || hasUnresolvedGlob(paths) || paths.some((p) => isStdin(p))) return null
  return paths[0] ?? null
}

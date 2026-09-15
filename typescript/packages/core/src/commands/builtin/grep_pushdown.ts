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
import { hasUnresolvedGlob } from './utils/operands.ts'
import { breToRegExp } from '../../utils/bre.ts'
import { type FlagValue } from '../spec/types.ts'

// Classify a grep pattern for API push-down decisions.
export function classifyPattern(pattern: string, fixedString: boolean): PatternType {
  if (pattern.includes('\n')) return PatternType.REGEX
  if (fixedString) return PatternType.EXACT
  if (/^[\w\s\-_.]+$/.test(pattern)) return PatternType.SIMPLE
  return PatternType.REGEX
}

const REGEX_BREAKERS: ReadonlySet<string> = new Set('.^$*+?()|{}')
const MIN_SEARCH_LITERAL = 3

// Fewest repeats the quantifier starting at `pattern[i]` allows: 0 for `?`,
// `*` and an interval whose lower bound is 0 or missing, 1 for `+`, the lower
// bound of any other interval, or null when no quantifier starts there.
function quantifierMin(pattern: string, i: number): number | null {
  if (i >= pattern.length) return null
  const ch = pattern.charAt(i)
  if (ch === '?' || ch === '*') return 0
  if (ch === '+') return 1
  if (ch === '{') {
    const end = pattern.indexOf('}', i)
    const low = (end === -1 ? '' : pattern.slice(i + 1, end)).split(',', 1)[0] ?? ''
    return /^\d+$/.test(low) ? Number(low) : 0
  }
  return null
}

// Longest substring every match of a regex must contain. Returns a literal
// any matching line is guaranteed to contain, suitable for narrowing via a
// literal search API before the real regex is scanned locally. Conservative:
// returns null whenever a required literal cannot be proven (top-level
// alternation, character classes, escapes, a `(?` group, runs shorter than
// MIN_SEARCH_LITERAL), so the caller falls back to a full scan. A run inside
// a group that `?`, `*` or a zero-floored interval makes optional is not
// required either: `(foo)?bar` matches `bar` alone, so only `bar` may be
// searched for.
export function extractRequiredLiteral(pattern: string): string | null {
  if (pattern.includes('|')) return null
  const runs: string[] = []
  let current: string[] = []
  const groups: number[] = []
  let i = 0
  const n = pattern.length
  while (i < n) {
    const ch = pattern.charAt(i)
    if (ch === '\\') {
      runs.push(current.join(''))
      current = []
      i += 2
      continue
    }
    if (ch === '[') {
      runs.push(current.join(''))
      current = []
      i += 1
      while (i < n && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (ch === '(') {
      if (pattern.startsWith('(?', i)) return null
      runs.push(current.join(''))
      current = []
      groups.push(runs.length)
      i += 1
      continue
    }
    if (ch === ')') {
      runs.push(current.join(''))
      current = []
      const opened = groups.pop()
      if (opened !== undefined && quantifierMin(pattern, i + 1) === 0) runs.length = opened
      i += 1
      continue
    }
    if (REGEX_BREAKERS.has(ch)) {
      if ((ch === '*' || ch === '?' || ch === '{') && current.length > 0) current.pop()
      runs.push(current.join(''))
      current = []
      if (ch === '{') {
        while (i < n && pattern[i] !== '}') i += 1
      }
      i += 1
      continue
    }
    current.push(ch)
    i += 1
  }
  runs.push(current.join(''))
  let best = ''
  for (const r of runs) if (r.length > best.length) best = r
  return best.length >= MIN_SEARCH_LITERAL ? best : null
}

// Literal to push down to a substring or code-search API for a grep/rg
// pattern: the pattern itself when literal, the longest literal every match
// of a regex must contain, or null when no literal can be searched (a
// newline-joined pattern list is a set of alternatives no one literal is
// required by). A SIMPLE pattern holding a dot is a regex here, not a
// literal: `worker.3` matches `worker-3`, which a substring search for
// `worker.3` never returns, so only the run before the dot is required.
// `isLiteralPattern` already draws that line for the whole-word case. A
// basic expression is translated before a literal is extracted, since its
// operators are the escaped spellings: `\(bar\)\?` is an optional group
// there and `(bar)?` three literal characters plus a literal question mark.
export function searchQuery(pattern: string, fixedString: boolean, basic = false): string | null {
  if (pattern.includes('\n')) return null
  if (isLiteralPattern(pattern, fixedString)) return pattern
  return extractRequiredLiteral(basic ? breToRegExp(pattern) : pattern)
}

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

const PUSHDOWN_SHAPING_BOOL = [
  'v',
  'n',
  'c',
  'args_l',
  'w',
  'o',
  'q',
  'H',
  'h',
  'args_I',
  'text',
] as const
const PUSHDOWN_SHAPING_INT = ['m', 'A', 'B', 'C'] as const
const PUSHDOWN_FILTER = [
  'type',
  'glob',
  'include',
  'exclude',
  'exclude_dir',
  'binary_files',
] as const

// True when a flag alters the match set or output shape of grep/rg. A search
// push-down prints each matching record as one whole line, so it cannot honor
// -v/-n/-c/-l/-w/-o/-m/-A/-B/-C/-q/-H/-h, rg's -I (no filename), nor rg's
// file-filtering --glob/--type; the wrapper must defer to the generic scan
// when any is present.
//
// `honored` names the flags this particular push-down implements itself, so
// their presence is not a reason to defer. Two shapes need it. A provider
// whose search is word-based (gmail, slack, discord) is faithful only *with*
// -w, so for those the flag in this list is the one that turns the push-down
// on rather than off. A push-down that uses the search only to pick
// candidates and then runs the real compiled matcher over each one (email)
// honors whatever that local scan implements. Everything left out of the list
// still defers, which is what keeps the exemption honest.
export function hasSearchShapingFlags(
  flags: Record<string, FlagValue>,
  honored: readonly string[] = [],
): boolean {
  const gated = (name: string): boolean => !honored.includes(name)
  if (PUSHDOWN_SHAPING_BOOL.some((name) => gated(name) && flags[name] === true)) return true
  if (PUSHDOWN_SHAPING_INT.some((name) => gated(name) && typeof flags[name] === 'string'))
    return true
  return PUSHDOWN_FILTER.some((name) => gated(name) && flags[name] !== undefined)
}

// True when a literal-substring push-down (LIKE/ILIKE) faithfully reproduces
// grep/rg: a literal pattern with no shaping flags. A newline-joined pattern
// list (-F with multiple -e) is a set of independent alternatives LIKE cannot
// express, so it stays on the generic path. Backends that push a real regex
// down (mongodb) gate on hasSearchShapingFlags alone instead.
export function searchPushdownOk(flags: Record<string, FlagValue>, pattern: string): boolean {
  if (pattern.includes('\n')) return false
  return isLiteralPattern(pattern, flags.F === true) && !hasSearchShapingFlags(flags)
}

// The one operand a search push-down may answer for, or null. A push-down
// asks the backend a single whole-container question and prints its entire
// answer, so it can only stand in for a line naming exactly one operand.
// Given two it answered for the first and dropped the rest in silence
// (rg pat /lf/traces /lf/sessions reported only traces). Running it once per
// operand is not the fix: several scopes map to the same container search
// (langfuse routes both `sessions` and one `session` to "search every
// session"), so two operands in one family would print that container twice.
// A multi-operand line therefore takes the generic scan, which searches each
// operand in turn the way GNU does. A glob operand defers for the older
// reason: an unexpanded pattern segment would be read as a literal entity
// name.
export function loneOperand(paths: PathSpec[]): PathSpec | null {
  if (paths.length !== 1 || hasUnresolvedGlob(paths)) return null
  return paths[0] ?? null
}

// The operand a regex push-down may answer for, or null. For a backend that
// pushes the real regex down (mongodb, langfuse), which is faithful for any
// single pattern with no shaping flags. A newline-joined pattern list (-F
// with several -e) is a set of independent alternatives it cannot express.
export function pushdownOperand(
  paths: PathSpec[],
  flags: Record<string, FlagValue>,
  pattern: string | null,
  honored: readonly string[] = [],
): PathSpec | null {
  if (pattern === null || pattern.includes('\n')) return null
  if (hasSearchShapingFlags(flags, honored)) return null
  return loneOperand(paths)
}

// The operand a literal-substring push-down may answer for, or null.
// loneOperand's rule plus searchPushdownOk's, which is the stricter flag gate
// LIKE/ILIKE needs (postgres): a real regex is treated literally by LIKE, so
// only a verbatim pattern may push down.
export function literalPushdownOperand(
  paths: PathSpec[],
  flags: Record<string, FlagValue>,
  pattern: string | null,
): PathSpec | null {
  if (pattern === null || !searchPushdownOk(flags, pattern)) return null
  return loneOperand(paths)
}

export function textSearchResults(lines: readonly string[]): boolean {
  return lines.every(
    (line) =>
      !line.includes('\0') &&
      !Array.from(line).some((char) => {
        const cp = char.codePointAt(0) ?? 0
        return cp >= 0xd800 && cp <= 0xdfff
      }),
  )
}

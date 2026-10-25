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

import { decodeText } from '../../shell/bytes.ts'
import { RegexSyntax } from './types.ts'
import { RegexError } from '../../rs/errors.ts'
import { LineRegex, type LineSyntax } from '../../rs/regex.ts'
import { UsageError } from '../errors.ts'
import { materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import type { FlagView } from '../spec/flag_view.ts'

export const NEVER_MATCH = '(?!)'

// The matcher options, as GNU grep names them: each one picks the dialect,
// and two different ones on a line are refused.
const MATCHERS: Readonly<Record<string, RegexSyntax>> = {
  E: RegexSyntax.EXTENDED,
  P: RegexSyntax.PERL,
}
const CONFLICTING_MATCHERS = 'conflicting matchers specified'

// Resolve the pattern-list argument from -e values (list[str] when
// multiple) or the positional. Returns the POSIX newline-joined pattern
// list, or null when neither was supplied.
export function patternArg(texts: readonly string[], flags: FlagView): string | null {
  const e = flags.asList('regexp')
  if (e.length > 0) return e.join('\n')
  if (texts.length > 0 && texts[0] !== undefined) return texts[0]
  return null
}

export interface PatternResolution {
  pattern: string | null
  neverMatch: boolean
  error: string | null
}

// Resolve the full pattern list from -e values, the positional, and -f
// pattern files (read via the backend stream). Shared by the grep, rg, and
// zgrep generics. When -f supplies zero patterns the NEVER_MATCH sentinel is
// returned with neverMatch=true (callers must skip -F escaping for it).
export async function resolvePattern(
  name: string,
  texts: readonly string[],
  flags: FlagView,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<PatternResolution> {
  let pattern = patternArg(texts, flags)
  let neverMatch = false
  // `raw` rather than `asList`, mirroring Python's `flags.raw(file_key)`: an
  // empty -f list still means "-f was supplied", which is what turns on the
  // NEVER_MATCH sentinel below.
  const patternFiles = flags.raw('file')
  if (Array.isArray(patternFiles)) {
    for (const file of patternFiles) {
      const patternSpec = PathSpec.fromStrPath(file instanceof PathSpec ? file.virtual : file)
      let fileData: Uint8Array
      try {
        fileData = await materialize(stream(patternSpec))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const shown = file instanceof PathSpec ? file.rawPath : file
        return { pattern: null, neverMatch: false, error: `${name}: ${shown}: ${msg}\n` }
      }
      pattern = mergePatternList(pattern, fileData)
    }
    if (pattern === null) {
      pattern = NEVER_MATCH
      neverMatch = true
    }
  }
  return { pattern, neverMatch, error: null }
}

export function mergePatternList(
  pattern: string | null,
  fileData: Uint8Array | null,
): string | null {
  const parts: string[] = pattern === null ? [] : pattern.split('\n')
  if (fileData !== null && fileData.length > 0) {
    let text = decodeText(fileData)
    if (text.endsWith('\n')) text = text.slice(0, -1)
    parts.push(...text.split('\n'))
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/**
 * The dialect grep's matcher options pick, refusing a mixture. GNU grep 3.11
 * keeps one matcher: -G, -E, -F and -P each name one, repeating the same is
 * harmless, and any two different ones are `conflicting matchers specified`
 * (exit 2) in either order. -F is carried as `fixedString`, so it only takes
 * part in the check.
 */
export function matcherSyntax(fl: FlagView, prog = 'grep'): RegexSyntax {
  const dests: Record<string, string> = {
    basic_regexp: 'G',
    extended_regexp: 'E',
    fixed_strings: 'F',
    perl_regexp: 'P',
  }
  const chosen = new Set<string>()
  for (const [dest, matcher] of Object.entries(dests)) if (fl.asBool(dest)) chosen.add(matcher)
  if (chosen.size > 1) throw new UsageError(`${prog}: ${CONFLICTING_MATCHERS}`)
  for (const matcher of chosen) {
    const syntax = MATCHERS[matcher]
    if (syntax !== undefined) return syntax
  }
  return RegexSyntax.BASIC
}

/**
 * GNU grep's compile-time warnings for a pattern list, as stderr. Only an
 * extended expression has any: GNU warns about a repetition operator at the
 * start of an expression (`grep: warning: * at start of expression`), once per
 * occurrence, which is also how GNU reads `(?<=...)`.
 */
export function patternWarnings(matcher: LineRegex, prog = 'grep'): string {
  return matcher.warnings.map((w) => `${prog}: warning: ${w}\n`).join('')
}

/** Whether a pattern list selects one line, given without its terminator. */
export function lineSelected(matcher: LineRegex, line: string): boolean {
  return matcher.matches(line)
}

/** What -o prints from one line: each match's start and text. */
export function linePieces(matcher: LineRegex, line: string): [number, string][] {
  return matcher.extents(line).map(([start, end]) => [start, line.slice(start, end)])
}

/**
 * Compile a pattern list into one matcher; `utf8` means the lines are text
 * under a UTF-8 locale. A refusal is GNU grep's wording, and exits 2 as grep
 * does.
 */
export function compilePattern(
  pattern: string,
  ignoreCase = false,
  fixedString = false,
  wholeWord = false,
  syntax = RegexSyntax.EXTENDED,
  utf8 = false,
  lineRegexp = false,
): LineRegex {
  // GNU grep 3.11: -x overrides -w in either order.
  wholeWord = wholeWord && !lineRegexp
  const kind: LineSyntax = fixedString
    ? 'fixed'
    : syntax === RegexSyntax.PERL
      ? 'perl'
      : syntax === RegexSyntax.BASIC
        ? 'basic'
        : 'extended'
  try {
    return new LineRegex(pattern.split('\n'), kind, ignoreCase, utf8, wholeWord, lineRegexp)
  } catch (err) {
    if (err instanceof RegexError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}

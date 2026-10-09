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
import { compilePosixRegex } from '../../utils/posix.ts'
import { RegexSyntax } from './types.ts'
import { BreError, translateBre, translateEre } from './utils/bre.ts'
import { PcreError, hostFlags, translatePcre } from './utils/pcre.ts'
import {
  RustRegexError,
  translateRust,
  wholeLine,
  wholeWord as rustWholeWord,
} from './utils/rust_regex.ts'
import type { HostRegex } from './utils/types.ts'
import { UsageError } from '../errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import { FlagView } from '../spec/flag_view.ts'
import { type FlagValue } from '../spec/types.ts'

export const NEVER_MATCH = '(?!)'
// The matcher options, as GNU grep names them: each one picks the dialect,
// and two different ones on a line are refused.
const MATCHERS: Readonly<Record<string, RegexSyntax>> = {
  E: RegexSyntax.EXTENDED,
  P: RegexSyntax.PERL,
}
const CONFLICTING_MATCHERS = 'conflicting matchers specified'
const PERL_SINGLE = 'the -P option only supports a single pattern'
// GNU grep 3.11's -P wrapping for -w (pcresearch.c).
const PERL_WORD: readonly [string, string] = ['(?<!\\w)(?:', ')(?!\\w)']
// The dest -e fills in each search command's spec: rg spells its options by
// their long names.
export const PATTERN_KEYS: Readonly<Record<string, string>> = {
  grep: 'e',
  zgrep: 'e',
  rg: 'regexp',
}
// The dest -f fills: grep's and rg's name the long spelling, zgrep has none.
const FILE_KEYS: Readonly<Record<string, string>> = { grep: 'file', zgrep: 'f', rg: 'file' }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Resolve the pattern-list argument from -e values (list[str] when
// multiple) or the positional. Returns the POSIX newline-joined pattern
// list, or null when neither was supplied.
export function patternArg(
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  patternKey = 'e',
): string | null {
  // Spec-less, as the shared push-down helpers are: `-e` and `-f` are
  // declared by the grep, rg and zgrep specs alike, and this helper is
  // reached from all three; `patternKey` is the dest -e fills (rg's is
  // `regexp`).
  const e = new FlagView(bag).asList(patternKey)
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
  bag: Record<string, FlagValue>,
  paths: readonly PathSpec[],
  mountPrefix: string | null | undefined,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<PatternResolution> {
  let pattern = patternArg(texts, bag, PATTERN_KEYS[name] ?? 'e')
  let neverMatch = false
  // `raw` rather than `asList`, mirroring Python's `flags.raw(file_key)`: an
  // empty -f list still means "-f was supplied", which is what turns on the
  // NEVER_MATCH sentinel below.
  const patternFiles = new FlagView(bag).raw(FILE_KEYS[name] ?? 'f')
  if (Array.isArray(patternFiles)) {
    const first = paths[0]
    const prefix =
      (first === undefined ? undefined : mountPrefixOf(first.virtual, first.vfsPath)) ??
      mountPrefix ??
      ''
    for (const file of patternFiles) {
      const filePath = file instanceof PathSpec ? file.virtual : file
      const patternSpec = PathSpec.fromStrPath(filePath, mountKey(filePath, prefix))
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

// One basic expression as grep reads it, or grep's refusal. The shared
// translator that `expr` and `nl` compile their patterns with, asked for
// grep's dialect: the two GNU dialects agree on every construct measured
// except an inverted range, which grep refuses (`grep '[z-a]'` is `Invalid
// range end`) where the other two read it as an empty set.
//
// A refusal is glibc's `regerror` string verbatim, which is what GNU prints,
// and exits 2 as grep does rather than letting the host engine's own wording
// out (`Invalid regular expression: /(/: Unterminated group` was what
// `grep '\('` used to say).
export function breSource(part: string): string {
  try {
    return translateBre(part, true)[0]
  } catch (err) {
    if (err instanceof BreError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}

// One extended expression as grep -E reads it, or grep's refusal.
export function ereSource(part: string): string {
  try {
    return translateEre(part)[0]
  } catch (err) {
    if (err instanceof BreError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}

/**
 * The dialect grep's matcher options pick, refusing a mixture. GNU grep 3.11
 * keeps one matcher: -G, -E, -F and -P each name one, repeating the same is
 * harmless, and any two different ones are `conflicting matchers specified`
 * (exit 2) in either order. -F is carried as `fixedString`, so it only takes
 * part in the check. `perl` is the dest -P fills in this spec (grep's has a
 * long spelling, zgrep's does not).
 */
export function matcherSyntax(fl: FlagView, prog = 'grep', perl = 'perl_regexp'): RegexSyntax {
  const dests: Record<string, string> = { G: 'G', E: 'E', F: 'F', [perl]: 'P' }
  if (perl === 'perl_regexp') Object.assign(dests, { basic_regexp: 'G', extended_regexp: 'E' })
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
 * extended expression has any: dfa.c warns about a repetition operator at the
 * start of an expression (`grep: warning: * at start of expression`), once per
 * occurrence, which is also how GNU reads `(?<=...)`.
 */
export function patternWarnings(pattern: string, syntax: RegexSyntax, prog = 'grep'): string {
  if (syntax !== RegexSyntax.EXTENDED) return ''
  const lines: string[] = []
  for (const part of pattern.split('\n')) {
    try {
      lines.push(...translateEre(part)[2])
    } catch (err) {
      if (err instanceof BreError) return ''
      throw err
    }
  }
  return lines.map((w) => `${prog}: warning: ${w}\n`).join('')
}

// One pattern's regex source in BASIC or EXTENDED syntax.
function sourceOf(part: string, fixedString: boolean, syntax: RegexSyntax): string {
  if (fixedString) return escapeRegex(part)
  if (syntax === RegexSyntax.BASIC) return breSource(part)
  return ereSource(part)
}

/**
 * grep -P's one pattern as host source (`u`-flag syntax), or grep's refusal:
 * more than one pattern, or one PCRE2 refuses. -w wraps it the way GNU grep
 * does; `unicode` is UCP classes (a pushed-down rg -P).
 */
export function perlRegex(
  pattern: string,
  ignoreCase: boolean,
  whole: boolean,
  unicode = false,
): HostRegex {
  if (pattern.includes('\n')) throw new UsageError(`grep: ${PERL_SINGLE}`)
  const source = whole ? PERL_WORD[0] + pattern + PERL_WORD[1] : pattern
  try {
    return translatePcre(source, unicode, ignoreCase)
  } catch (err) {
    if (err instanceof PcreError) throw new UsageError(`grep: ${err.message}`)
    throw err
  }
}

// ripgrep's default-engine pattern list as host source, or its refusal.
export function rustSource(
  pattern: string,
  fixedString: boolean,
  whole: boolean,
  ignoreCase: boolean,
): HostRegex {
  let parts = pattern.split('\n')
  if (fixedString) parts = parts.map(rustEscape)
  let translated: HostRegex
  try {
    translated = translateRust(parts, ignoreCase)
  } catch (err) {
    if (err instanceof RustRegexError) throw new UsageError(`rg: ${err.message}`)
    throw err
  }
  if (!whole) return translated
  return { source: rustWholeWord(translated.source), ignoreCase: translated.ignoreCase }
}

// A literal as a Rust regex, the way `regex::escape` spells it.
export function rustEscape(text: string): string {
  return text.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&')
}

// Build a regex source string from a POSIX pattern list in BASIC or
// EXTENDED syntax; the other two dialects compile through `compilePattern`.
export function buildPatternStr(
  pattern: string,
  fixedString = false,
  wholeWord = false,
  syntax = RegexSyntax.EXTENDED,
): string {
  const parts = pattern.split('\n')
  if (parts.length === 1) {
    let patStr = sourceOf(pattern, fixedString, syntax)
    if (wholeWord) patStr = `\\b${patStr}\\b`
    return patStr
  }
  const subs: string[] = []
  for (const part of parts) {
    const source = sourceOf(part, fixedString, syntax)
    let sub = fixedString ? source : `(?:${source})`
    if (wholeWord) sub = `\\b${sub}\\b`
    subs.push(sub)
  }
  return subs.join('|')
}

/** Compile a pattern list into one matcher; `utf8` means the lines are text under a UTF-8 locale. */
export function compilePattern(
  pattern: string,
  ignoreCase = false,
  fixedString = false,
  wholeWord = false,
  syntax = RegexSyntax.EXTENDED,
  utf8 = false,
  lineRegexp = false,
): RegExp {
  // GNU grep 3.11: -x overrides -w in either order.
  wholeWord = wholeWord && !lineRegexp
  if (syntax === RegexSyntax.RUST) {
    const translated = rustSource(pattern, fixedString, wholeWord, ignoreCase)
    const source = lineRegexp ? wholeLine(translated.source, false) : translated.source
    return new RegExp(source, translated.ignoreCase ? 'iu' : 'u')
  }
  if (syntax === RegexSyntax.PERL && !fixedString) {
    const translated = perlRegex(pattern, ignoreCase, wholeWord)
    const source = lineRegexp ? wholeLine(translated.source, false) : translated.source
    return compilePosixRegex(source, hostFlags(translated.source, translated.ignoreCase), utf8)
  }
  let source = buildPatternStr(pattern, fixedString, wholeWord, syntax)
  if (lineRegexp) source = wholeLine(source, false)
  try {
    return compilePosixRegex(source, ignoreCase ? 'i' : '', utf8)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    throw new UsageError('grep: Invalid regular expression')
  }
}

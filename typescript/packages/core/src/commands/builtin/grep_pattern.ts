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

import { breToRegExp } from '../../utils/bre.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import { FlagView, type FlagValue } from '../spec/types.ts'

export const NEVER_MATCH = '(?!)'

const DEC = new TextDecoder()

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Resolve the pattern-list argument from -e values (list[str] when
// multiple) or the positional. Returns the POSIX newline-joined pattern
// list, or null when neither was supplied.
export function patternArg(
  texts: readonly string[],
  flags: Record<string, FlagValue>,
): string | null {
  // Spec-less, as the shared push-down helpers are: `-e` and `-f` are
  // declared by the grep, rg and zgrep specs alike, and this helper is
  // reached from all three.
  const e = new FlagView(flags).asList('e')
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
  flags: Record<string, FlagValue>,
  paths: readonly PathSpec[],
  mountPrefix: string | null | undefined,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<PatternResolution> {
  let pattern = patternArg(texts, flags)
  let neverMatch = false
  // `raw` rather than `asList`, mirroring Python's `flags.raw("f")`: an
  // empty -f list still means "-f was supplied", which is what turns on the
  // NEVER_MATCH sentinel below.
  const patternFiles = new FlagView(flags).raw('f')
  if (Array.isArray(patternFiles)) {
    const first = paths[0]
    const prefix =
      (first === undefined ? undefined : mountPrefixOf(first.virtual, first.resourcePath)) ??
      mountPrefix ??
      ''
    for (const filePath of patternFiles) {
      const patternSpec = PathSpec.fromStrPath(filePath, mountKey(filePath, prefix))
      let fileData: Uint8Array
      try {
        fileData = await materialize(stream(patternSpec))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { pattern: null, neverMatch: false, error: `${name}: ${filePath}: ${msg}\n` }
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
    let text = DEC.decode(fileData)
    if (text.endsWith('\n')) text = text.slice(0, -1)
    parts.push(...text.split('\n'))
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

// One pattern's regex source, in the syntax it was written in.
function sourceOf(part: string, fixedString: boolean, basic: boolean): string {
  if (fixedString) return escapeRegex(part)
  return basic ? breToRegExp(part) : part
}

// Build a regex source string from a POSIX pattern list. `basic` says the
// patterns are basic regular expressions, which grep reads by default and which
// invert most of the RegExp operators; false leaves them alone, which is right
// for -E and for rg's own dialect.
function buildPatternStr(
  pattern: string,
  fixedString = false,
  wholeWord = false,
  basic = false,
): string {
  const parts = pattern.split('\n')
  if (parts.length === 1) {
    let patStr = sourceOf(pattern, fixedString, basic)
    if (wholeWord) patStr = `\\b${patStr}\\b`
    return patStr
  }
  const subs: string[] = []
  for (const part of parts) {
    const source = sourceOf(part, fixedString, basic)
    let sub = fixedString ? source : `(?:${source})`
    if (wholeWord) sub = `\\b${sub}\\b`
    subs.push(sub)
  }
  return subs.join('|')
}

export function compilePattern(
  pattern: string,
  ignoreCase = false,
  fixedString = false,
  wholeWord = false,
  basic = false,
): RegExp {
  return new RegExp(buildPatternStr(pattern, fixedString, wholeWord, basic), ignoreCase ? 'i' : '')
}

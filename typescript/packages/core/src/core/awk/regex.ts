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

import { AwkSyntaxError } from './errors.ts'
import { translateBracket } from '../../utils/posix.ts'

const WORD_BOUNDARY_ESCAPES: Readonly<Record<string, string>> = {
  y: '\\b',
  '<': '\\b',
  '>': '\\b',
  B: '\\B',
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const REGEX_ERROR = 'awk: syntax error in regular expression {pattern} at source line 1'

const SINGLE_CHAR_META = /[.*+?^${}()|[\]\\/-]/

const CACHE = new Map<string, RegExp>()

export interface EreMatch {
  readonly start: number
  readonly end: number
  readonly text: string
}

function regexError(pattern: string): AwkSyntaxError {
  return new AwkSyntaxError(REGEX_ERROR.replace('{pattern}', () => pattern))
}

/**
 * Translate a POSIX ERE into a host regex source. Expands the POSIX
 * character classes, which neither Python nor JavaScript understands
 * and which would otherwise silently match nothing.
 */
export function translate(pattern: string): string {
  const out: string[] = []
  let idx = 0
  while (idx < pattern.length) {
    const ch = pattern.charAt(idx)
    if (ch === '[') {
      idx = translateBracket(pattern, idx, out)
      continue
    }
    if (ch === '\\' && idx + 1 < pattern.length) {
      const nxt = pattern.charAt(idx + 1)
      const boundary = WORD_BOUNDARY_ESCAPES[nxt]
      if (boundary !== undefined) out.push(boundary)
      else if (ALNUM.includes(nxt)) out.push('\\' + nxt)
      else out.push(SINGLE_CHAR_META.test(nxt) ? '\\' + nxt : nxt)
      idx += 2
      continue
    }
    out.push(ch)
    idx += 1
  }
  return out.join('')
}

export function compileEre(pattern: string): RegExp {
  const cached = CACHE.get(pattern)
  if (cached !== undefined) return cached
  let compiled: RegExp
  try {
    compiled = new RegExp(translate(pattern), 'gs')
  } catch (err) {
    if (err instanceof SyntaxError) throw regexError(pattern)
    throw err
  }
  CACHE.set(pattern, compiled)
  return compiled
}

/** Leftmost match at or after `pos`, or null. */
export function searchFrom(compiled: RegExp, subject: string, pos: number): EreMatch | null {
  compiled.lastIndex = pos
  const found = compiled.exec(subject)
  if (found === null) return null
  return { start: found.index, end: found.index + found[0].length, text: found[0] }
}

export function matches(pattern: string, subject: string): boolean {
  return searchFrom(compileEre(pattern), subject, 0) !== null
}

/**
 * The field-splitting pattern for an FS value. A single character FS is
 * literal per POSIX, so it is escaped rather than read as an ERE. The
 * default blank FS returns null: split on runs of blanks instead.
 */
export function splitPattern(separator: string): RegExp | null {
  if (separator === ' ') return null
  if (Array.from(separator).length === 1) {
    return compileEre(SINGLE_CHAR_META.test(separator) ? '\\' + separator : separator)
  }
  return compileEre(separator)
}

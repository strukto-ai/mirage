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

// CPython fnmatch matching semantics, matched directly rather than through a
// translated regular expression: a pattern comes from the caller (a glob, a
// find -name, a grep --include), and a regex built from it backtracks
// polynomially on a pattern like *a*a*a*b. Every token but * consumes one
// character, a code point as in a Python str (so `?` takes a whole surrogate
// pair), so returning to the last * on a mismatch is enough, and a match
// costs at most name length times pattern length. Deliberate divergences
// from CPython: always case-sensitive (no normcase, so this equals Python
// fnmatchcase), an invalid class range like [z-a] never matches instead of
// raising, and a leading ^ negates a class like ! does (bash/glibc
// semantics; CPython keeps ^ literal, as `fnmatchcase` below does). Mirrors
// the Python mirage.utils.fnmatch wrapper.
import { translateBracket } from './posix.ts'

export const QUOTED_CHARS: Readonly<Record<string, string>> = Object.fromEntries(
  ['*', '?', '[', '@', '+', '!', '(', ')', '|'].map((ch, i) => [
    String.fromCharCode(0xfdd0 + i),
    ch,
  ]),
)
const QUOTED_RE = /[\uFDD0-\uFDD8]/

export function fnmatch(name: string, pattern: string, extglob = false, period = false): boolean {
  if (
    QUOTED_RE.test(pattern) ||
    (extglob && (pattern.includes('[:') || /[@?*+!]\(/.test(pattern)))
  ) {
    return new Matcher(name, pattern, period, extglob).matches()
  }
  if (period && name.startsWith('.') && !pattern.startsWith('.')) return false
  return match(characters(name), characters(pattern), true)
}

/** Immutable reachable positions as merged half-open intervals. */
class Positions implements Iterable<number> {
  readonly spans: readonly (readonly [number, number])[]

  constructor(spans: Iterable<readonly [number, number]> = []) {
    const merged: [number, number][] = []
    for (const [lo, hi] of [...spans].sort((a, b) => a[0] - b[0])) {
      if (lo >= hi) continue
      const last = merged.at(-1)
      if (last && lo <= last[1]) last[1] = Math.max(hi, last[1])
      else merged.push([lo, hi])
    }
    this.spans = merged
  }

  *[Symbol.iterator](): Iterator<number> {
    for (const [lo, hi] of this.spans) {
      for (let position = lo; position < hi; position += 1) yield position
    }
  }

  contains(position: number): boolean {
    return this.spans.some(([lo, hi]) => lo <= position && position < hi)
  }

  union(other: Positions): Positions {
    return new Positions([...this.spans, ...other.spans])
  }

  subtract(other: Positions): Positions {
    const out: [number, number][] = []
    let j = 0
    for (const [lo, hi] of this.spans) {
      while (j < other.spans.length && (other.spans[j]?.[1] ?? 0) <= lo) j += 1
      let k = j
      let cursor = lo
      while (k < other.spans.length && (other.spans[k]?.[0] ?? hi) < hi) {
        const span = other.spans[k]
        if (!span) break
        const [start, stop] = span
        if (cursor < start) out.push([cursor, Math.min(start, hi)])
        cursor = Math.max(cursor, stop)
        k += 1
      }
      if (cursor < hi) out.push([cursor, hi])
    }
    return new Positions(out)
  }
}

/**
 * Match extended groups by memoized reachable character positions.
 * Deliberate GNU 5.2 divergence: empty subjects obey group composition.
 * GNU's star fast path accepts `*!(a)x` but rejects `*+([!a]|!([!a]))`
 * against empty text; here the suffix is required and the group is nullable.
 */
class Matcher {
  private readonly name: readonly string[]
  private readonly pattern: readonly string[]
  private readonly classes = new Map<number, number>()
  readonly groups = new Map<number, { end: number; branches: [number, number][] }>()
  private readonly memo = new Map<string, Positions>()
  private readonly period: boolean

  constructor(name: string, pattern: string, period = false, extglob = true) {
    this.period = period && name.startsWith('.')
    this.name = Array.from(name)
    this.pattern = Array.from(pattern)
    const p = this.pattern
    const stack: { open: number; starts: number[]; literalDepth: number }[] = []
    let i = 0
    while (i < p.length) {
      const c = p[i] ?? ''
      if (c === '[') {
        const end = classEnd(p, i, true, true)
        if (end >= 0) {
          this.classes.set(i, end + 1)
          i = end + 1
          continue
        }
      }
      if (extglob && '@?*+!'.includes(c) && p[i + 1] === '(') {
        stack.push({ open: i, starts: [i + 2], literalDepth: 0 })
        i += 2
        continue
      }
      const frame = stack.at(-1)
      if (frame && c === '(') frame.literalDepth += 1
      else if (frame && c === ')' && frame.literalDepth > 0) frame.literalDepth -= 1
      else if (frame && c === '|' && frame.literalDepth === 0) frame.starts.push(i + 1)
      else if (frame && c === ')') {
        stack.pop()
        this.groups.set(frame.open, {
          end: i + 1,
          branches: frame.starts.map((start, j) => [start, (frame.starts[j + 1] ?? i + 1) - 1]),
        })
      }
      i += 1
    }
  }

  matches(): boolean {
    if (
      this.groups.size === 0 &&
      !this.pattern.join('').includes('[:') &&
      !QUOTED_RE.test(this.pattern.join(''))
    ) {
      return fnmatch(this.name.join(''), this.pattern.join(''), false, this.period)
    }
    return this.ends(0, this.pattern.length, 0).contains(this.name.length)
  }

  private ends(lo: number, hi: number, start: number): Positions {
    const key = `${String(lo)}:${String(hi)}:${String(start)}`
    const cached = this.memo.get(key)
    if (cached) return cached
    let positions = new Positions([[start, start + 1]])
    let i = lo
    while (i < hi && positions.spans.length > 0) {
      const c = this.pattern[i] ?? ''
      const group = this.groups.get(i)
      if (group && group.end <= hi) {
        let reached = new Positions()
        for (const position of positions) {
          let once = new Positions()
          for (const [a, b] of group.branches) once = once.union(this.ends(a, b, position))
          if (c === '!') {
            if (this.period && position === 0) continue
            once = new Positions([[position, this.name.length + 1]]).subtract(once)
          }
          reached = reached.union(once)
        }
        if (c === '*' || c === '?') reached = reached.union(positions)
        if (c === '*' || c === '+') {
          const pending = [...reached]
          while (pending.length > 0) {
            const current = pending.pop()
            if (current === undefined) break
            for (const [a, b] of group.branches) {
              const fresh = this.ends(a, b, current).subtract(reached)
              if (fresh.spans.length > 0) {
                reached = reached.union(fresh)
                for (const target of fresh) pending.push(target)
              }
            }
          }
        }
        positions = reached
        i = group.end
        continue
      }
      if (c === '*') {
        if (this.period) positions = positions.subtract(new Positions([[0, 1]]))
        const first = positions.spans[0]
        if (!first) break
        positions = new Positions([[first[0], this.name.length + 1]])
        i += 1
        continue
      }
      const end = this.classes.get(i) ?? i + 1
      const token = this.pattern.slice(i, end).join('')
      const spans: [number, number][] = []
      for (const position of positions) {
        if (
          position < this.name.length &&
          !(this.period && position === 0 && (c === '?' || end > i + 1)) &&
          (end > i + 1
            ? extendedClassMatches(this.name[position] ?? '', token)
            : c === '?' || (QUOTED_CHARS[c] ?? c) === this.name[position])
        )
          spans.push([position + 1, position + 2])
      }
      positions = new Positions(spans)
      i = end
    }
    this.memo.set(key, positions)
    return positions
  }
}

function extendedClassMatches(char: string, pattern: string): boolean {
  if (!pattern.includes('[:') && !QUOTED_RE.test(pattern)) return fnmatch(char, pattern)
  const out: string[] = []
  const source = pattern.startsWith('[!') ? '[^' + pattern.slice(2) : pattern
  try {
    translateBracket(source, 0, out)
    let expression = out.join('')
    for (const [mark, literal] of Object.entries(QUOTED_CHARS)) {
      expression = expression.replaceAll(mark, '\\x' + literal.charCodeAt(0).toString(16))
    }
    return new RegExp('^(?:' + expression + ')$', 'u').test(char)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    console.debug(`Invalid glob character class ${pattern}: ${String(err)}`)
    return false
  }
}

/** Replace extended groups with a wildcard for word classification. */
export function patternShape(pattern: string): string {
  const groups = new Matcher('', pattern).groups
  const chars = Array.from(pattern)
  let out = ''
  let i = 0
  while (i < chars.length) {
    const group = groups.get(i)
    if (group) {
      out += '*'
      i = group.end
    } else {
      out += chars[i] ?? ''
      i += 1
    }
  }
  return out
}

/** CPython's fnmatchcase: a leading caret in a class is a literal member. */
export function fnmatchcase(name: string, pattern: string): boolean {
  return match(characters(name), characters(pattern), false)
}

type Characters = string | readonly string[]

// A string as one character per index: the string itself while every code
// unit is a code point, its code points once a surrogate appears.
function characters(text: string): Characters {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdfff) return Array.from(text)
  }
  return text
}

function match(name: Characters, pattern: Characters, caret: boolean): boolean {
  let n = 0
  let p = 0
  let starP = -1
  let starN = 0
  while (n < name.length) {
    if (p < pattern.length) {
      const c = pattern[p]
      if (c === '*') {
        while (p < pattern.length && pattern[p] === '*') p += 1
        starP = p
        starN = n
        continue
      }
      const end = c === '[' ? classEnd(pattern, p, caret) : -1
      if (end >= 0) {
        if (classMatches(pattern.slice(p + 1, end), name[n] ?? '', caret)) {
          p = end + 1
          n += 1
          continue
        }
      } else if (c === '?' || c === name[n]) {
        p += 1
        n += 1
        continue
      }
    }
    if (starP < 0) return false
    starN += 1
    n = starN
    p = starP
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

function negates(c: string | undefined, caret: boolean): boolean {
  return c === '!' || (caret && c === '^')
}

// The index of the ] closing the class that opens at `open`, or -1 when
// none does and the [ is a literal. A ] right after the [ (or after its
// negation) is a member, not the close.
function classEnd(pattern: Characters, open: number, caret: boolean, posix = false): number {
  let j = open + 1
  if (j < pattern.length && negates(pattern[j], caret)) j += 1
  if (j < pattern.length && pattern[j] === ']') j += 1
  while (j < pattern.length && pattern[j] !== ']') {
    if (posix && pattern[j] === '[' && pattern[j + 1] === ':') {
      let end = j + 2
      while (end < pattern.length && !(pattern[end] === ':' && pattern[end + 1] === ']')) end += 1
      if (end < pattern.length) {
        j = end + 2
        continue
      }
    }
    j += 1
  }
  return j < pattern.length ? j : -1
}

// Whether one character is in a class body. Members are literal (a
// backslash is a member too), a-z is a range over code points, a - at
// either end is literal, and a class holding a range whose ends are out of
// order matches nothing. A body of just its negation matches any character.
function classMatches(body: Characters, ch: string, caret: boolean): boolean {
  const negate = negates(body[0], caret)
  const members = negate ? body.slice(1) : body
  const code = ch.codePointAt(0) ?? -1
  let found = false
  let i = 0
  while (i < members.length) {
    const lo = members[i] ?? ''
    if (members[i + 1] === '-' && i + 2 < members.length) {
      const low = lo.codePointAt(0) ?? 0
      const high = (members[i + 2] ?? '').codePointAt(0) ?? 0
      if (low > high) return false
      if (low <= code && code <= high) found = true
      i += 3
    } else {
      if (lo === ch) found = true
      i += 1
    }
  }
  return found !== negate
}

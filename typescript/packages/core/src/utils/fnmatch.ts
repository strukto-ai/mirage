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
import { POSIX_CLASSES } from './posix.ts'

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

/** Next unscheduled offset for a state, with successor-chain compression. */
function unseen(links: Uint32Array, position: number): number {
  let root = position
  while (links[root] !== root) root = links[root] ?? root
  while (links[position] !== position) {
    const next = links[position] ?? position
    links[position] = root
    position = next
  }
  return root
}

/**
 * Positive groups compile to epsilon transitions. Active states advance
 * together, sharing nested repetition work at each subject offset.
 * Negative groups request memoized branch endpoints on an explicit stack.
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
  private readonly transitions = new Map<number, readonly number[]>()
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

    for (const [opened, { end, branches }] of this.groups) {
      const operator = p[opened]
      if (operator === '!') continue
      this.transitions.set(opened, [
        ...branches.map(([a]) => a),
        ...(operator === '*' || operator === '?' ? [end] : []),
      ])
      for (const [, stop] of branches) {
        this.transitions.set(stop, [end, ...(operator === '*' || operator === '+' ? [opened] : [])])
      }
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
    const stack = [
      { key: `${String(lo)}:${String(hi)}:${String(start)}`, frame: this.evaluate(lo, hi, start) },
    ]
    let answer = new Positions()
    while (stack.length > 0) {
      const current = stack.at(-1)
      if (!current) break
      const step = current.frame.next(answer)
      if (step.done) {
        answer = step.value
        this.memo.set(current.key, answer)
        stack.pop()
        continue
      }
      const [a, b, position] = step.value
      const key = `${String(a)}:${String(b)}:${String(position)}`
      const cached = this.memo.get(key)
      if (cached) answer = cached
      else stack.push({ key, frame: this.evaluate(a, b, position) })
    }
    return answer
  }

  /** Yield dependencies so nested groups never consume the host stack. */
  private *evaluate(
    lo: number,
    hi: number,
    start: number,
  ): Generator<[number, number, number], Positions, Positions> {
    if (hi === lo + 1 && this.pattern[lo] === '*') {
      return this.period && start === 0
        ? new Positions()
        : new Positions([[start, this.name.length + 1]])
    }
    const pending = new Map<number, Set<number>>([[start, new Set([lo])]])
    const scheduled = new Map<number, Uint32Array>()
    const accepted: [number, number][] = []
    for (let position = start; position <= this.name.length; position += 1) {
      if (pending.size === 0) break
      const seen = pending.get(position) ?? new Set<number>()
      pending.delete(position)
      const active = [...seen]
      const schedule = (target: number, offset = position): void => {
        if (offset === position) {
          if (!seen.has(target)) {
            seen.add(target)
            active.push(target)
          }
        } else {
          let states = pending.get(offset)
          if (!states) {
            states = new Set()
            pending.set(offset, states)
          }
          states.add(target)
        }
      }
      while (active.length > 0) {
        const i = active.pop()
        if (i === undefined) break
        if (i === hi) {
          accepted.push([position, position + 1])
          continue
        }
        const transitions = this.transitions.get(i)
        if (transitions) {
          for (const target of transitions) schedule(target)
          continue
        }
        const c = this.pattern[i] ?? ''
        const group = this.groups.get(i)
        if (group && group.end <= hi) {
          if (this.period && position === 0) continue
          const matched: (readonly [number, number])[] = []
          for (const [a, b] of group.branches) {
            const once = yield [a, b, position]
            for (const span of once.spans) matched.push(span)
          }
          const reached = new Positions([[position, this.name.length + 1]]).subtract(
            new Positions(matched),
          )
          if (reached.contains(position)) schedule(group.end)
          for (const [lower, upper] of reached.spans) {
            if (upper <= position + 1) continue
            let links = scheduled.get(group.end)
            if (!links) {
              links = Uint32Array.from({ length: this.name.length + 2 }, (_, i) => i)
              scheduled.set(group.end, links)
            }
            let target = unseen(links, Math.max(lower, position + 1))
            while (target < upper) {
              schedule(group.end, target)
              links[target] = target + 1
              target = unseen(links, target)
            }
          }
          continue
        }
        const end = this.classes.get(i) ?? i + 1
        const wildcard = c === '*' || c === '?' || end > i + 1
        if (this.period && position === 0 && wildcard) continue
        if (c === '*') {
          schedule(end)
          if (position < this.name.length) schedule(i, position + 1)
        } else if (
          position < this.name.length &&
          (end > i + 1
            ? extendedClassMatches(this.name[position] ?? '', this.pattern.slice(i, end).join(''))
            : c === '?' || (QUOTED_CHARS[c] ?? c) === this.name[position])
        )
          schedule(end, position + 1)
      }
    }
    return new Positions(accepted)
  }
}

function extendedClassMatches(char: string, pattern: string): boolean {
  const chars = Array.from(pattern)
  const end = chars.length - 1
  const negate = chars[1] === '!' || chars[1] === '^'
  let i = negate ? 2 : 1
  let found = false
  while (i < end) {
    if (chars[i] === '[' && chars[i + 1] === ':') {
      let close = i + 2
      while (close < end && !(chars[close] === ':' && chars[close + 1] === ']')) close += 1
      if (close < end) {
        const name = chars.slice(i + 2, close).join('')
        const members = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
        if (members === undefined) return false
        found ||= new RegExp('^[' + members + ']$', 'u').test(char)
        i = close + 2
        continue
      }
    }
    const low = QUOTED_CHARS[chars[i] ?? ''] ?? chars[i] ?? ''
    if (i + 2 < end && chars[i + 1] === '-' && !(chars[i + 2] === '[' && chars[i + 3] === ':')) {
      const high = QUOTED_CHARS[chars[i + 2] ?? ''] ?? chars[i + 2] ?? ''
      const code = char.codePointAt(0) ?? 0
      found ||= (low.codePointAt(0) ?? 0) <= code && code <= (high.codePointAt(0) ?? 0)
      i += 3
    } else {
      found ||= low === char
      i += 1
    }
  }
  return negate ? !found : found
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

/** Split a pathname without splitting slashes inside extended groups. */
export function patternParts(pattern: string): string[] {
  if (!/[@?*+!]\(/.test(pattern)) return pattern.split('/')
  const groups = new Matcher('', pattern).groups
  const chars = Array.from(pattern)
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < chars.length) {
    const group = groups.get(i)
    if (group) {
      i = group.end
      continue
    }
    if (chars[i] === '/') {
      out.push(chars.slice(start, i).join(''))
      start = i + 1
    }
    i += 1
  }
  out.push(chars.slice(start).join(''))
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

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

import { ALL, CharSet, hostChar, hostClass } from './charset.ts'
import type { HostRegex } from './types.ts'
import {
  ASCII_CLASSES,
  ASCII_DIGIT,
  ASCII_SPACE,
  ASCII_WORD,
  WHITE_SPACE,
  category,
  fold,
  rustWord,
  unicodeProperty,
} from './unicode_tables.ts'

// regex-syntax's error kinds, worded as ripgrep 14.1.1 prints them.
const LOOK_AROUND = 'look-around, including look-ahead and look-behind, is not supported'
const BACKREFERENCE = 'backreferences are not supported'
const GROUP_UNCLOSED = 'unclosed group'
const GROUP_UNOPENED = 'unopened group'
const CLASS_UNCLOSED = 'unclosed character class'
const REPETITION_MISSING = 'repetition operator missing expression'
const REPETITION_DECIMAL = 'repetition quantifier expects a valid decimal'
const REPETITION_UNCLOSED = 'unclosed counted repetition'
const REPETITION_INVALID = 'invalid repetition count range, the start must be <= the end'
const DECIMAL_INVALID = 'decimal literal invalid'
const ESCAPE_UNRECOGNIZED = 'unrecognized escape sequence'
const ESCAPE_EOF = 'incomplete escape sequence, reached end of pattern prematurely'
const ESCAPE_IN_CLASS = 'invalid escape sequence found in character class'
const RANGE_LITERAL = 'invalid range boundary, must be a literal'
const RANGE_INVALID = 'invalid character class range, the start must be <= the end'
const HEX_DIGIT = 'invalid hexadecimal digit'
const HEX_EMPTY = 'hexadecimal literal empty'
const HEX_SCALAR = 'hexadecimal literal is not a Unicode scalar value'
const FLAG_UNRECOGNIZED = 'unrecognized flag'
const FLAG_DANGLING = 'dangling flag negation operator'
const FLAG_DUPLICATE = 'duplicate flag'
const FLAG_REPEATED_NEGATION = 'flag negation operator repeated'
const FLAG_EOF = 'expected flag but got end of regex'
const GROUP_NAME_EMPTY = 'empty capture group name'
const GROUP_NAME_INVALID = 'invalid capture group character'
const GROUP_NAME_EOF = 'unclosed capture group name'
const GROUP_NAME_DUPLICATE = 'duplicate capture group name'
const PROPERTY_UNSUPPORTED = 'Unicode property not supported in mirage'
const PCRE2_HINT =
  'Consider enabling PCRE2 with the --pcre2 flag, which can handle backreferences\nand look-around.'

const FLAG_LETTERS = 'imsUuxR'
// An inline flag group that could change case folding: `i` itself, or `u`,
// which turns Unicode folding off. A caseless pattern without one is caseless
// throughout, and the host engine folds it.
const INLINE_CASE = /\(\?[a-zA-Z-]*[iu]/
const META_ESCAPES = '\\.+*?()|[]{}^$#&-~'
const NAME_START = /^[_A-Za-z]$/
const NAME_CHARS = /^[_A-Za-z0-9.[\]]$/
const HOST_NAME = /^[_A-Za-z0-9]+$/
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  f: 0x0c,
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  v: 0x0b,
}
const HEX_WIDTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 }
const HEX = /^[0-9a-fA-F]$/

type Span = readonly [number, number]

/**
 * A pattern ripgrep's default engine refuses, framed as rg prints it after
 * its `rg: ` prefix: the pattern regex-syntax parsed (each `-e` wrapped in
 * `(?:...)` and joined with `|`), carets under the spans (character
 * columns; an empty span marks one), the error kind, and for the two kinds
 * PCRE2 would accept, ripgrep's `--pcre2` hint.
 */
export class RustRegexError extends Error {
  constructor(
    readonly display: string,
    readonly spans: readonly Span[],
    readonly kind: string,
    readonly hint = false,
  ) {
    super(renderError(display, spans, kind, hint))
  }
}

function renderError(display: string, spans: readonly Span[], kind: string, hint: boolean): string {
  const width = Array.from(display).length
  const marks: string[] = Array.from({ length: width + 1 }, () => ' ')
  for (const [start, end] of spans) {
    for (let i = start; i < Math.max(end, start + 1); i++) marks[i] = '^'
  }
  const carets = marks.join('').trimEnd()
  const text = `regex parse error:\n    ${display}\n    ${carets}\nerror: ${kind}`
  return hint ? text + '\n\n' + PCRE2_HINT : text
}

/** The inline flags in force at one point of a pattern. */
export interface Flags {
  readonly i: boolean
  readonly m: boolean
  readonly s: boolean
  readonly U: boolean
  readonly u: boolean
  readonly x: boolean
  readonly R: boolean
}

const DEFAULT_FLAGS: Flags = { i: false, m: false, s: false, U: false, u: true, x: false, R: false }

// `\w` in one mode.
function wordClass(unicode: boolean): CharSet {
  return unicode ? rustWord() : ASCII_WORD
}

const WORD_SOURCE = new Map<boolean, string>()

// The host class for `\w` in one mode, built once.
function wordSource(unicode: boolean): string {
  let found = WORD_SOURCE.get(unicode)
  if (found === undefined) {
    found = hostClass(wordClass(unicode))
    WORD_SOURCE.set(unicode, found)
  }
  return found
}

/**
 * One word-boundary assertion as host lookarounds. Both hosts' own `\b` is
 * ASCII, so every boundary is spelled out over the dialect's word class.
 * `kind` is `b`, `B`, `start`, `end`, `start-half` or `end-half`.
 */
export function boundary(kind: string, unicode: boolean): string {
  const w = wordSource(unicode)
  const table: Record<string, string> = {
    b: `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`,
    B: `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`,
    start: `(?<!${w})(?=${w})`,
    end: `(?<=${w})(?!${w})`,
    'start-half': `(?<!${w})`,
    'end-half': `(?!${w})`,
  }
  return table[kind] ?? ''
}

// `^` as the host reads it, also just after a `\n` under multi-line.
export function lineStart(multiLine: boolean): string {
  return multiLine ? '(?:^|(?<=\\n))' : '^'
}

// `$` as the host reads it, also just before a `\n` under multi-line.
export function lineEnd(multiLine: boolean): string {
  return multiLine ? '(?=\\n|$)' : '$'
}

// ripgrep's -x: the pattern spans a whole line.
export function wholeLine(source: string, multiLine: boolean): string {
  return `${lineStart(multiLine)}(?:${source})${lineEnd(multiLine)}`
}

// ripgrep's -w: `\b{start-half}(?:...)\b{end-half}`, over Unicode word
// characters unless --no-unicode turned them off.
export function wholeWord(source: string, unicode = true): string {
  return `${boundary('start-half', unicode)}(?:${source})${boundary('end-half', unicode)}`
}

// The one pattern ripgrep parses for a pattern list.
function displayOf(patterns: readonly string[]): string {
  return patterns.map((p) => `(?:${p})`).join('|')
}

interface Frame {
  readonly openAt: number
  readonly outStart: number
  readonly flags: Flags
}

/**
 * A ripgrep default-engine pattern re-emitted in this host's dialect.
 *
 * A single left-to-right scan of the regex-syntax 0.8 grammar ripgrep 14.1.1
 * bundles. It refuses what that parser refuses, with its wording and spans,
 * and emits everything it accepts as host source whose meaning does not
 * depend on the host's own class shorthands: `\w`, `\d`, `\s` and `\b` are
 * Unicode sets spelled out, case folding is Unicode simple folding applied to
 * each literal and class, and `(?i)` scoping is therefore free. The pattern
 * is scanned by code point, so every position is a character column as in
 * `rust_regex.py`.
 */
class RustTranslator {
  private readonly src: readonly string[]
  private pos = 0
  private flags: Flags
  private out: string[] = []
  private atomStart: number | null = null
  private atomQuantified = false
  private atomAssertion = false
  private stack: Frame[] = []
  private names = new Map<string, Span>()

  constructor(
    private readonly display: string,
    flags: Flags,
  ) {
    this.src = Array.from(display)
    this.flags = flags
  }

  private fail(start: number, end: number, message: string, ...more: Span[]): RustRegexError {
    const hint = message === LOOK_AROUND || message === BACKREFERENCE
    return new RustRegexError(this.display, [[start, end], ...more], message, hint)
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? ''
  }

  private startsWith(text: string, at: number): boolean {
    const chars = Array.from(text)
    return chars.every((ch, i) => this.src[at + i] === ch)
  }

  private find(ch: string, from: number): number {
    for (let i = from; i < this.src.length; i++) if (this.src[i] === ch) return i
    return -1
  }

  private slice(start: number, end: number): string {
    return this.src.slice(start, end).join('')
  }

  // Skip whitespace and `#` comments under `x`.
  private skipSpace(): void {
    while (this.flags.x && this.pos < this.src.length) {
      const ch = this.src[this.pos] ?? ''
      if (/^\s$/u.test(ch)) {
        this.pos += 1
      } else if (ch === '#') {
        const end = this.find('\n', this.pos)
        this.pos = end < 0 ? this.src.length : end + 1
      } else {
        return
      }
    }
  }

  translate(): string {
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.src.length) break
      this.step()
    }
    const frame = this.stack[this.stack.length - 1]
    if (frame !== undefined) throw this.fail(frame.openAt, frame.openAt + 1, GROUP_UNCLOSED)
    return this.out.join('')
  }

  private step(): void {
    const ch = this.src[this.pos] ?? ''
    if (ch === '(') {
      this.openGroup()
    } else if (ch === ')') {
      this.closeGroup()
    } else if (ch === '|') {
      this.pos += 1
      this.out.push('|')
      this.atomStart = null
    } else if (ch === '[') {
      this.atom(hostClass(this.parseClass()))
    } else if (ch === '*' || ch === '+' || ch === '?') {
      this.repetition(ch)
    } else if (ch === '{') {
      this.countedRepetition()
    } else if (ch === '\\') {
      this.escape()
    } else if (ch === '.') {
      this.pos += 1
      const excluded = this.flags.R ? CharSet.chars(0x0a, 0x0d) : CharSet.chars(0x0a)
      this.atom(hostClass(this.flags.s ? ALL : ALL.minus(excluded)))
    } else if (ch === '^') {
      this.pos += 1
      this.assertion(lineStart(this.flags.m))
    } else if (ch === '$') {
      this.pos += 1
      this.assertion(lineEnd(this.flags.m))
    } else {
      this.pos += 1
      this.literal(ch.codePointAt(0) ?? 0)
    }
  }

  private atom(text: string): void {
    this.atomStart = this.out.length
    this.out.push(text)
    this.atomQuantified = false
    this.atomAssertion = false
  }

  // Emit one zero-width assertion, which Rust lets a repetition apply to.
  private assertion(text: string): void {
    this.atom(text)
    this.atomAssertion = true
  }

  // Emit one literal code point, folded under `i`.
  private literal(cp: number): void {
    if (this.flags.i) this.atom(hostClass(fold(CharSet.chars(cp), !this.flags.u)))
    else this.atom(hostChar(cp))
  }

  // Emit a class-valued escape, folded under `i`.
  private setAtom(cs: CharSet): void {
    this.atom(hostClass(this.flags.i ? fold(cs, !this.flags.u) : cs))
  }

  // Scan a `(` and whatever group syntax follows it.
  private openGroup(): void {
    const start = this.pos
    if (this.startsWith('(?=', start) || this.startsWith('(?!', start)) {
      throw this.fail(start, start + 3, LOOK_AROUND)
    }
    if (this.startsWith('(?<=', start) || this.startsWith('(?<!', start)) {
      throw this.fail(start, start + 4, LOOK_AROUND)
    }
    this.pos += 1
    if (this.peek() !== '?') {
      this.push(start, '(')
      return
    }
    this.pos += 1
    if (this.startsWith('P<', this.pos) || this.peek() === '<') {
      this.pos += this.peek() === 'P' ? 2 : 1
      const name = this.groupName()
      this.push(start, name ? `(?<${name}>` : '(')
      return
    }
    if (this.peek() === ')') throw this.fail(this.pos - 1, this.pos, REPETITION_MISSING)
    const [flags, scoped] = this.parseFlags()
    if (scoped) {
      this.push(start, '(?:')
      this.flags = flags
    } else {
      this.flags = flags
      this.atomStart = null
    }
  }

  // Open a group whose host opener is `opener`.
  private push(start: number, opener: string): void {
    this.stack.push({ openAt: start, outStart: this.out.length, flags: this.flags })
    this.out.push(opener)
    this.atomStart = null
  }

  // Read a capture group name through its `>`: the name for the host, empty
  // when the host cannot spell it (Rust allows `.`, `[` and `]`), in which
  // case the group stays capturing and unnamed.
  private groupName(): string {
    const begin = this.pos
    for (;;) {
      if (this.pos >= this.src.length) throw this.fail(begin, this.pos, GROUP_NAME_EOF)
      const ch = this.src[this.pos] ?? ''
      if (ch === '>') break
      const allowed = this.pos === begin ? NAME_START : NAME_CHARS
      if (!allowed.test(ch)) throw this.fail(this.pos, this.pos + 1, GROUP_NAME_INVALID)
      this.pos += 1
    }
    const name = this.slice(begin, this.pos)
    if (!name) throw this.fail(this.pos, this.pos + 1, GROUP_NAME_EMPTY)
    const span: Span = [begin, this.pos]
    const seen = this.names.get(name)
    if (seen !== undefined) throw this.fail(span[0], span[1], GROUP_NAME_DUPLICATE, seen)
    this.names.set(name, span)
    this.pos += 1
    return HOST_NAME.test(name) ? name : ''
  }

  // Read `flags)` or `flags:` after a `(?`: the new flags, and whether they
  // open a scoped group rather than set the enclosing one's.
  private parseFlags(): [Flags, boolean] {
    const flags: { -readonly [K in keyof Flags]: boolean } = { ...this.flags }
    let negate: number | null = null
    const seen = new Map<string, number>()
    for (;;) {
      if (this.pos >= this.src.length) throw this.fail(this.pos, this.pos, FLAG_EOF)
      const ch = this.src[this.pos] ?? ''
      if (ch === ':' || ch === ')') {
        if (negate !== null && negate === this.pos - 1) {
          throw this.fail(negate, negate + 1, FLAG_DANGLING)
        }
        this.pos += 1
        return [flags, ch === ':']
      }
      if (ch === '-') {
        if (negate !== null) throw this.fail(this.pos, this.pos + 1, FLAG_REPEATED_NEGATION)
        negate = this.pos
        this.pos += 1
        continue
      }
      if (!FLAG_LETTERS.includes(ch)) throw this.fail(this.pos, this.pos + 1, FLAG_UNRECOGNIZED)
      const first = seen.get(ch)
      if (first !== undefined) {
        throw this.fail(this.pos, this.pos + 1, FLAG_DUPLICATE, [first, first + 1])
      }
      seen.set(ch, this.pos)
      flags[ch as keyof Flags] = negate === null
      this.pos += 1
    }
  }

  // Scan a `)`.
  private closeGroup(): void {
    const frame = this.stack.pop()
    if (frame === undefined) throw this.fail(this.pos, this.pos + 1, GROUP_UNOPENED)
    this.pos += 1
    this.out.push(')')
    this.flags = frame.flags
    this.atomStart = frame.outStart
    this.atomQuantified = false
    this.atomAssertion = false
  }

  // Scan `*`, `+` or `?` and an optional lazy `?`.
  private repetition(op: string): void {
    const at = this.pos
    this.pos += 1
    let lazy = false
    if (this.peek() === '?') {
      this.pos += 1
      lazy = true
    }
    this.apply(op, at, op === '+' ? 1 : 0, lazy)
  }

  // Scan `{n}`, `{n,}` or `{n,m}` and an optional lazy `?`.
  private countedRepetition(): void {
    const start = this.pos
    if (this.atomStart === null) throw this.fail(start, start + 1, REPETITION_MISSING)
    this.pos += 1
    this.skipSpace()
    if (this.pos >= this.src.length) throw this.fail(start, this.pos, REPETITION_UNCLOSED)
    const low = this.decimal()
    let high: number | null = low
    if (this.pos >= this.src.length) throw this.fail(start, this.pos, REPETITION_UNCLOSED)
    if (this.peek() === ',') {
      this.pos += 1
      this.skipSpace()
      if (this.pos >= this.src.length) throw this.fail(start, this.pos, REPETITION_UNCLOSED)
      high = this.peek() === '}' ? null : this.decimal()
    }
    this.skipSpace()
    if (this.pos >= this.src.length || this.peek() !== '}') {
      throw this.fail(start, this.pos, REPETITION_UNCLOSED)
    }
    this.pos += 1
    if (high !== null && low > high) throw this.fail(start, this.pos, REPETITION_INVALID)
    let lazy = false
    if (this.peek() === '?') {
      this.pos += 1
      lazy = true
    }
    const token =
      high === null
        ? `{${String(low)},}`
        : high === low
          ? `{${String(low)}}`
          : `{${String(low)},${String(high)}}`
    this.apply(token, start, low, lazy)
  }

  // Read one decimal inside a counted repetition.
  private decimal(): number {
    this.skipSpace()
    const begin = this.pos
    while (/^[0-9]$/.test(this.peek())) this.pos += 1
    if (begin === this.pos) throw this.fail(this.pos, this.pos, REPETITION_DECIMAL)
    const value = Number(this.slice(begin, this.pos))
    if (value > 0xffffffff) throw this.fail(begin, this.pos, DECIMAL_INVALID)
    this.skipSpace()
    return value
  }

  // Apply a repetition to the last atom.
  private apply(token: string, at: number, least: number, lazy: boolean): void {
    const start = this.atomStart
    if (start === null) throw this.fail(at, at + 1, REPETITION_MISSING)
    if (this.atomAssertion) {
      if (least === 0) {
        this.out.splice(start)
        this.assertion('(?:)')
      }
      return
    }
    let body = this.out.slice(start).join('')
    if (this.atomQuantified || this.out.length - start > 1) body = `(?:${body})`
    this.out.splice(
      start,
      this.out.length - start,
      body + token + (lazy !== this.flags.U ? '?' : ''),
    )
    this.atomQuantified = true
  }

  // Scan one escape outside a class.
  private escape(): void {
    const start = this.pos
    if (this.pos + 1 >= this.src.length) {
      throw this.fail(this.src.length, this.src.length, ESCAPE_EOF)
    }
    const ch = this.src[this.pos + 1] ?? ''
    this.pos += 2
    if (/^[0-9]$/.test(ch)) throw this.fail(start, this.pos, BACKREFERENCE)
    if (ch === 'b' && this.peek() === '{') {
      const close = this.find('}', this.pos)
      const kind = close > 0 ? this.slice(this.pos + 1, close) : ''
      if (['start', 'end', 'start-half', 'end-half'].includes(kind)) {
        this.pos = close + 1
        this.assertion(boundary(kind, this.flags.u))
        return
      }
    }
    const anchors: Record<string, string> = { b: 'b', B: 'B', '<': 'start', '>': 'end' }
    const anchor = anchors[ch]
    if (anchor !== undefined) {
      this.assertion(boundary(anchor, this.flags.u))
    } else if (ch === 'A') {
      this.assertion('^')
    } else if (ch === 'z') {
      this.assertion('$')
    } else {
      const cs = this.classEscape(start, ch)
      if (cs !== null) this.setAtom(cs)
      else this.literal(this.charEscape(start, ch))
    }
  }

  // A class-valued escape (`\d`, `\pL` ...) or null.
  private classEscape(start: number, ch: string): CharSet | null {
    const u = this.flags.u
    const table: Record<string, CharSet> = {
      d: u ? category('Nd') : ASCII_DIGIT,
      s: u ? WHITE_SPACE : ASCII_SPACE,
      w: wordClass(u),
    }
    const cs = table[ch.toLowerCase()]
    if (cs !== undefined && 'dswDSW'.includes(ch)) return ch === ch.toUpperCase() ? cs.negate() : cs
    if (ch === 'p' || ch === 'P') {
      const found = this.property(start)
      return ch === 'P' ? found.negate() : found
    }
    return null
  }

  // Read the name of `\p` / `\P` and look it up.
  private property(start: number): CharSet {
    if (this.pos >= this.src.length) throw this.fail(this.pos, this.pos, ESCAPE_EOF)
    let name: string
    if (this.peek() === '{') {
      const close = this.find('}', this.pos)
      if (close < 0) throw this.fail(this.src.length, this.src.length, ESCAPE_EOF)
      name = this.slice(this.pos + 1, close)
      this.pos = close + 1
    } else {
      name = this.src[this.pos] ?? ''
      this.pos += 1
    }
    const found = unicodeProperty(name)
    if (found === null) throw this.fail(start, this.pos, PROPERTY_UNSUPPORTED)
    return found
  }

  // A literal-valued escape's code point.
  private charEscape(start: number, ch: string): number {
    const simple = SIMPLE_ESCAPES[ch]
    if (simple !== undefined) return simple
    if (HEX_WIDTH[ch] !== undefined) return this.hexEscape(ch)
    const ascii = (ch.codePointAt(0) ?? 0x80) < 0x80
    if (META_ESCAPES.includes(ch) || (ascii && !/^[0-9A-Za-z<>]$/.test(ch))) {
      return ch.codePointAt(0) ?? 0
    }
    throw this.fail(start, this.pos, ESCAPE_UNRECOGNIZED)
  }

  // Read the digits of `\x`, `\u` or `\U`.
  private hexEscape(kind: string): number {
    if (this.peek() === '{') {
      const close = this.find('}', this.pos)
      const begin = this.pos + 1
      if (close < 0) throw this.fail(this.src.length, this.src.length, ESCAPE_EOF)
      const digits = this.slice(begin, close)
      if (!digits) throw this.fail(begin - 1, close + 1, HEX_EMPTY)
      for (let i = 0; i < close - begin; i++) {
        if (!HEX.test(this.src[begin + i] ?? '')) {
          throw this.fail(begin + i, begin + i + 1, HEX_DIGIT)
        }
      }
      this.pos = close + 1
      const cp = Number.parseInt(digits, 16)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw this.fail(begin, close, HEX_SCALAR)
      return cp
    }
    const begin = this.pos
    for (let n = 0; n < (HEX_WIDTH[kind] ?? 2); n++) {
      const d = this.peek()
      if (!d) throw this.fail(this.src.length, this.src.length, ESCAPE_EOF)
      if (!HEX.test(d)) throw this.fail(this.pos, this.pos + 1, HEX_DIGIT)
      this.pos += 1
    }
    const cp = Number.parseInt(this.slice(begin, this.pos), 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw this.fail(begin, this.pos, HEX_SCALAR)
    }
    return cp
  }

  // Scan one bracketed class, nested ones and set operations too: its
  // members, folded under `i` and then negated.
  private parseClass(): CharSet {
    const openAt = this.pos
    this.pos += 1
    let negated = false
    if (this.peek() === '^') {
      negated = true
      this.pos += 1
    }
    const openerEnd = this.pos
    let result: CharSet | null = null
    let op: string | null = null
    let current = new CharSet()
    let first = true
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.src.length) {
        const end = openerEnd + (this.src[openerEnd] === ']' ? 1 : 0)
        throw this.fail(openAt, end, CLASS_UNCLOSED)
      }
      const ch = this.src[this.pos] ?? ''
      if (ch === ']' && !first) {
        this.pos += 1
        break
      }
      first = false
      if ('&-~'.includes(ch) && this.startsWith(ch + ch, this.pos)) {
        result = result === null ? current : combine(result, current, op)
        op = ch
        current = new CharSet()
        this.pos += 2
        continue
      }
      current = current.union(this.classItem())
    }
    let cs = result === null ? current : combine(result, current, op)
    if (this.flags.i) cs = fold(cs, !this.flags.u)
    return negated ? cs.negate() : cs
  }

  // One member of a class: a range, a char, a nested class, a POSIX class or
  // a class escape.
  private classItem(): CharSet {
    const ch = this.src[this.pos] ?? ''
    if (ch === '[') return this.posixClass() ?? this.parseClass()
    const lowAt = this.pos
    const low = this.classChar()
    const lowEnd = this.pos
    this.skipSpace()
    const next = this.peek(1)
    const ranged =
      this.peek() === '-' && next !== ']' && next !== '' && !this.startsWith('--', this.pos)
    if (low instanceof CharSet) {
      if (ranged) throw this.fail(lowAt, lowEnd, RANGE_LITERAL)
      return low
    }
    if (!ranged) return CharSet.chars(low)
    this.pos += 1
    this.skipSpace()
    const highAt = this.pos
    const high = this.classChar()
    if (high instanceof CharSet) throw this.fail(highAt, this.pos, RANGE_LITERAL)
    if (high < low) throw this.fail(lowAt, this.pos, RANGE_INVALID)
    return CharSet.of([low, high])
  }

  // `[:name:]` or `[:^name:]` at the position, or null.
  private posixClass(): CharSet | null {
    if (!this.startsWith('[:', this.pos)) return null
    let close = -1
    for (let i = this.pos + 2; i + 1 < this.src.length; i++) {
      if (this.src[i] === ':' && this.src[i + 1] === ']') {
        close = i
        break
      }
    }
    if (close < 0) return null
    const name = this.slice(this.pos + 2, close)
    const negated = name.startsWith('^')
    const key = negated ? name.slice(1) : name
    const cs = Object.hasOwn(ASCII_CLASSES, key) ? ASCII_CLASSES[key] : undefined
    if (cs === undefined) return null
    this.pos = close + 2
    return negated ? cs.negate() : cs
  }

  // One character (or class escape) inside a class.
  private classChar(): number | CharSet {
    const ch = this.src[this.pos] ?? ''
    if (ch !== '\\') {
      this.pos += 1
      return ch.codePointAt(0) ?? 0
    }
    const start = this.pos
    if (this.pos + 1 >= this.src.length) {
      throw this.fail(this.src.length, this.src.length, ESCAPE_EOF)
    }
    const letter = this.src[this.pos + 1] ?? ''
    this.pos += 2
    if (/^[0-9]$/.test(letter)) throw this.fail(start, this.pos, BACKREFERENCE)
    if ('bBAz<>'.includes(letter)) throw this.fail(start, this.pos, ESCAPE_IN_CLASS)
    const cs = this.classEscape(start, letter)
    if (cs !== null) return cs
    return this.charEscape(start, letter)
  }
}

// Apply one class set operation (`&`, `-` or `~`, the doubled operator).
function combine(left: CharSet, right: CharSet, op: string | null): CharSet {
  if (op === '&') return left.intersect(right)
  if (op === '-') return left.minus(right)
  return left.xor(right)
}

/**
 * Translate a ripgrep pattern list into this host's regex dialect: host
 * source matching exactly what ripgrep's default engine matches, and whether
 * the host folds case (the whole pattern is caseless: -i, or -S over an
 * all-lowercase pattern). `multiLine` makes `^`/`$` also match at a `\n`
 * inside the subject (--null-data); `unicode` off (--no-unicode) is a leading
 * `(?-u)`. Throws RustRegexError for a pattern ripgrep refuses. The source is
 * `u`-flag syntax.
 */
export function translateRust(
  patterns: readonly string[],
  ignoreCase = false,
  multiLine = false,
  unicode = true,
): HostRegex {
  const display = displayOf(patterns)
  // The host folds Unicode letters, so only a Unicode pattern hands it the
  // folding; without Unicode the translator folds ASCII alone.
  if (ignoreCase && unicode && !INLINE_CASE.test(display)) {
    const source = new RustTranslator(display, {
      ...DEFAULT_FLAGS,
      m: multiLine,
      u: unicode,
    }).translate()
    return { source, ignoreCase: true }
  }
  const flags = { ...DEFAULT_FLAGS, i: ignoreCase, m: multiLine, u: unicode }
  return { source: new RustTranslator(display, flags).translate(), ignoreCase: false }
}

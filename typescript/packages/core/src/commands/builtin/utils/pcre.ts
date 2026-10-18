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

// Compile error texts from PCRE2 10.43 and 10.46 (BSD-3-Clause WITH
// PCRE2-exception; see licenses/third_party/pcre2.txt).

import { ALL, CharSet, hostChar, hostClass } from './charset.ts'
import { lineEnd, lineStart } from './rust_regex.ts'
import type { HostRegex } from './types.ts'
import {
  ASCII_CLASSES,
  ASCII_DIGIT,
  ASCII_SPACE,
  ASCII_WORD,
  PCRE_HSPACE,
  PCRE_VSPACE,
  category,
  fold,
  pcreWord,
  unicodeProperty,
} from './unicode_tables.ts'

// PCRE2's compile error texts (pcre2_error.c, 10.43 and 10.46 agree on every
// one used here), which grep prints after `grep: ` and ripgrep after
// `rg: PCRE2: error compiling pattern at offset N: `.
const MISSING_PAREN = 'missing closing parenthesis'
const UNMATCHED_PAREN = 'unmatched closing parenthesis'
const MISSING_BRACKET = 'missing terminating ] for character class'
const TRAILING_BACKSLASH = '\\ at end of pattern'
const TRAILING_C = '\\c at end of pattern'
const NOTHING_TO_REPEAT = 'quantifier does not follow a repeatable item'
const QUANTIFIER_ORDER = 'numbers out of order in {} quantifier'
const QUANTIFIER_BIG = 'number too big in {} quantifier'
const LOOKBEHIND_UNLIMITED = 'length of lookbehind assertion is not limited'
const UNKNOWN_PROPERTY = 'unknown property after \\P or \\p'
const MALFORMED_PROPERTY = 'malformed \\P or \\p sequence'
const N_IN_CLASS = '\\N is not supported in a class'
const NO_SUBPATTERN = 'reference to non-existent subpattern'
const BAD_GROUP_SYNTAX = 'unrecognized character after (? or (?-'
const CODE_POINT_BIG = 'character code point value in \\x{} or \\o{} is too large'
const RANGE_BAD = 'invalid range in character class'
const RANGE_ORDER = 'range out of order in character class'
const POSIX_UNKNOWN = 'unknown POSIX class name'
const HEX_BAD = 'non-hex character in \\x{} (closing brace missing?)'
const OCTAL_BAD = 'non-octal character in \\o{} (closing brace missing?)'
const DIGITS_MISSING = 'digits missing after \\x or in \\x{} or \\o{} or \\N{U+}'
const ESCAPE_UNKNOWN = 'unrecognized character follows \\'
const NAME_EXPECTED = 'subpattern name expected'
const NAME_UNTERMINATED = 'syntax error in subpattern name (missing terminator?)'
const NAME_DIGIT = 'subpattern name must start with a non-digit'
const NAME_DUPLICATE = 'two named subpatterns have the same name (PCRE2_DUPNAMES not set)'
const COMMENT_UNTERMINATED = 'missing ) after (?# comment'
const KEEP_IN_LOOKAROUND =
  '\\K is not allowed in lookarounds (but see PCRE2_EXTRA_ALLOW_LOOKAROUND_BSK)'
const NAMED_CHAR_UTF = '\\N{U+dddd} is supported only in Unicode (UTF) mode'
const CASE_ESCAPES = 'PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u'
const ESCAPE_IN_CLASS = 'escape sequence is invalid in character class'
const G_SYNTAX =
  '\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number'
const K_SYNTAX = '\\k is not followed by a braced, angle-bracketed, or quoted name'

// What mirage refuses although PCRE2 accepts it: nothing on either host
// engine can mean the same, so the pattern is refused rather than run as
// something else.
function unsupported(what: string): string {
  return `${what} is not supported in mirage`
}

// The reserved group names synthetic groups use. A `\K` is an empty group
// whose position becomes the reported match start (`matchStart`); an atomic
// group is emulated with a captured lookahead, which this host needs. Anything
// that numbers groups skips both (`userGroups`).
const KEEP_PREFIX = 'mirage_keep_'
const ATOMIC_PREFIX = 'mirage_atomic_'
const SYNTHETIC_PREFIX = 'mirage_'

const FLAG_LETTERS = 'imnsxJU'
const HEX = /^[0-9a-fA-F]$/
const NAME_START = /^[A-Za-z_]$/
const INTERVAL = /\{[ \t]*([0-9]*)[ \t]*(,[ \t]*([0-9]*)[ \t]*)?\}/y
const DIGITS = /[0-9]*/y
const OCTAL_TAIL = /[0-7]{0,2}/y
const HEX_PAIR = /[0-9a-fA-F]{0,2}/y
const NAME_CHARS = /[A-Za-z0-9_]*/y
const G_REFERENCE = /\{(-?[0-9]+)\}|(-?[0-9]+)|\{([A-Za-z_][A-Za-z0-9_]*)\}/y
const K_REFERENCE =
  /<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)'|\{([A-Za-z_][A-Za-z0-9_]*)\}/y
const GROUP_NAMES = /\(\?(?:P?<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)')/g
const POSIX_NAME = /^\^?[a-z<>]+$/
// An inline option group that could change case sensitivity: a caseless
// pattern without one is caseless throughout, and the host engine folds it.
const INLINE_CASE = /\(\?[\^a-zA-Z-]*[i^]/
const BACKREF_MARK = '\u0000'
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  e: 0x1b,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
}
const UCP_POSIX: Readonly<Record<string, readonly string[]>> = {
  alpha: ['L'],
  alnum: ['L', 'N'],
  digit: ['Nd'],
  lower: ['Ll'],
  upper: ['Lu'],
  cntrl: ['Cc'],
}
const GRAPH_EXCLUDED = CharSet.of([0x061c, 0x061c], [0x180e, 0x180e], [0x2066, 0x2069])
const NEWLINE_SEQUENCE = CharSet.of([0x0a, 0x0d], [0x85, 0x85], [0x2028, 0x2029])
const VERBS = new Set([
  'UTF',
  'UTF8',
  'UCP',
  'NO_JIT',
  'NO_START_OPT',
  'NO_AUTO_POSSESS',
  'NO_DOTSTAR_ANCHOR',
])

// A pattern PCRE2 (or mirage's reading of it) refuses, with the offset in the
// compiled pattern where PCRE2 reports it.
export class PcreError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message)
  }
}

/** The option letters in force at one point. */
export interface Flags {
  readonly i: boolean
  readonly m: boolean
  readonly n: boolean
  readonly s: boolean
  readonly x: boolean
  readonly xx: boolean
  readonly U: boolean
}

const DEFAULT_FLAGS: Flags = {
  i: false,
  m: false,
  n: false,
  s: false,
  x: false,
  xx: false,
  U: false,
}

type Width = readonly [number, number | null]

interface Frame {
  readonly openAt: number
  readonly outStart: number
  readonly flags: Flags
  readonly kind: 'group' | 'ahead' | 'behind' | 'atomic'
  readonly negative: boolean
  readonly branches: number[]
  readonly widths: Width[]
  low: number
  high: number | null
  atomic: number
}

// Two lengths in sequence.
function addWidth(a: Width, b: Width): Width {
  return [a[0] + b[0], a[1] === null || b[1] === null ? null : a[1] + b[1]]
}

function frameOf(
  openAt: number,
  outStart: number,
  flags: Flags,
  kind: Frame['kind'],
  negative = false,
): Frame {
  return {
    openAt,
    outStart,
    flags,
    kind,
    negative,
    branches: [],
    widths: [],
    low: 0,
    high: 0,
    atomic: 0,
  }
}

/**
 * A PCRE2 pattern re-emitted in this host's dialect.
 *
 * One scan that refuses what PCRE2 refuses, in its words and at its offsets,
 * and emits what it accepts without leaning on any host shorthand whose
 * meaning differs: `\d \w \s \h \v` and POSIX classes are explicit sets (ASCII
 * for grep, which runs PCRE2 without UCP; Unicode for rg, which sets it), case
 * folding is applied to each literal and class, `\K` is a marker group,
 * lookbehind is split into fixed-length alternatives (the only kind python's
 * engine reads, kept alike here), and an atomic group or possessive
 * quantifier, which JavaScript lacks, is a captured lookahead. The pattern is
 * scanned by code point, so offsets are character offsets as in `pcre.py`.
 */
class PcreTranslator {
  private readonly src: readonly string[]
  private readonly text: string
  private pos = 0
  private flags: Flags
  private out: string[] = []
  private atomStart: number | null = null
  private atomWidth: Width = [0, 0]
  private atomHostGroups = 0
  private repeatable = false
  private quantified = false
  private look = false
  private readonly stack: Frame[]
  private readonly totalGroups: number
  private groups = 0
  private hostGroups = 0
  private readonly groupMap = new Map<number, number>()
  private readonly names = new Set<string>()
  private keeps = 0
  private atomics = 0
  private caselessBackref = false
  private caseSensitiveText = false
  private readonly backrefs: [number, number][] = []

  constructor(
    pattern: string,
    private readonly unicode: boolean,
    flags: Flags,
    // PCRE2_NEWLINE_ANYCRLF (ripgrep's --crlf): `\r` ends a line too, for the
    // anchors and for `.`.
    private readonly crlf = false,
  ) {
    this.src = Array.from(pattern)
    this.text = this.src.join('')
    this.flags = flags
    this.stack = [frameOf(0, 0, flags, 'group')]
    this.totalGroups = countGroups(pattern)
  }

  private fail(message: string, offset?: number): PcreError {
    return new PcreError(message, offset ?? this.pos)
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? ''
  }

  private startsWith(text: string, at: number): boolean {
    return Array.from(text).every((ch, i) => this.src[at + i] === ch)
  }

  private find(text: string, from: number): number {
    for (let i = from; i < this.src.length; i++) if (this.startsWith(text, i)) return i
    return -1
  }

  private slice(start: number, end?: number): string {
    return this.src.slice(start, end).join('')
  }

  // A sticky regex matched at a code-point position: the match, and the
  // position just past it.
  private stickyAt(re: RegExp, at: number): [RegExpExecArray, number] | null {
    const unitIndex = this.slice(0, at).length
    re.lastIndex = unitIndex
    const found = re.exec(this.text)
    if (found === null) return null
    return [found, at + Array.from(found[0]).length]
  }

  translate(): HostRegex {
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.src.length) break
      this.step()
    }
    if (this.stack.length > 1) throw this.fail(MISSING_PAREN, this.src.length)
    let source = this.out.join('')
    for (const [index, [number, offset]] of this.backrefs.entries()) {
      const host = this.groupMap.get(number)
      if (host === undefined) throw this.fail(NO_SUBPATTERN, offset)
      source = source.replace(
        `${BACKREF_MARK}${String(index)}${BACKREF_MARK}`,
        `(?:\\${String(host)})`,
      )
    }
    if (this.caselessBackref && this.caseSensitiveText) {
      throw this.fail(unsupported('a caseless back-reference in a case-sensitive pattern'), 0)
    }
    return { source, ignoreCase: this.caselessBackref }
  }

  // Skip whitespace and `#` comments under `x`.
  private skipSpace(): void {
    while (this.flags.x && this.pos < this.src.length) {
      const ch = this.src[this.pos] ?? ''
      if (' \t\n\r\f\v'.includes(ch)) {
        this.pos += 1
      } else if (ch === '#') {
        const end = this.find('\n', this.pos)
        this.pos = end < 0 ? this.src.length : end + 1
      } else {
        return
      }
    }
  }

  private step(): void {
    const ch = this.src[this.pos] ?? ''
    if (ch === '(') {
      this.openGroup()
    } else if (ch === ')') {
      this.closeGroup()
    } else if (ch === '|') {
      this.pos += 1
      this.alternate()
    } else if (this.startsWith('[[:<:]]', this.pos) || this.startsWith('[[:>:]]', this.pos)) {
      const start = this.src[this.pos + 3] === '<'
      this.pos += 7
      this.assertion(wordEdge(start, this.unicode))
    } else if (ch === '[') {
      this.atom(hostClass(this.parseClass()), [1, 1])
    } else if (ch === '*' || ch === '+' || ch === '?') {
      this.quantifier(ch)
    } else if (ch === '{' && this.intervalAt(this.pos) !== null) {
      this.quantifier(ch)
    } else if (ch === '\\') {
      this.escape()
    } else if (ch === '.') {
      this.pos += 1
      const ends = this.crlf ? CharSet.chars(0x0a, 0x0d) : CharSet.chars(0x0a)
      this.atom(hostClass(this.flags.s ? ALL : ALL.minus(ends)), [1, 1])
    } else if (ch === '^') {
      this.pos += 1
      this.assertion(this.flags.m ? lineStart(true, this.crlf) : '^')
    } else if (ch === '$') {
      this.pos += 1
      this.assertion(
        this.flags.m ? lineEnd(true, this.crlf) : this.crlf ? '(?=(?:\\r\\n?|\\n)?$)' : '(?=\\n?$)',
      )
    } else {
      this.pos += 1
      this.literal(ch.codePointAt(0) ?? 0)
    }
  }

  private atom(text: string, width: Width): void {
    this.atomStart = this.out.length
    this.atomHostGroups = this.hostGroups
    this.out.push(text)
    this.atomWidth = width
    this.repeatable = true
    this.quantified = false
    this.look = false
    const frame = this.top()
    ;[frame.low, frame.high] = addWidth([frame.low, frame.high], width)
  }

  private top(): Frame {
    const frame = this.stack[this.stack.length - 1]
    if (frame === undefined) throw new Error('pcre: no open frame')
    return frame
  }

  // Emit one zero-width assertion, which no quantifier may follow.
  private assertion(text: string): void {
    this.out.push(text)
    this.atomStart = null
    this.repeatable = false
  }

  // Emit one literal code point, folded when caseless.
  private literal(cp: number): void {
    const folded = fold(CharSet.chars(cp), !this.unicode)
    if (folded.single() === null) {
      if (this.flags.i) {
        this.atom(hostClass(folded), [1, 1])
        return
      }
      this.caseSensitiveText = true
    }
    this.atom(hostChar(cp), [1, 1])
  }

  // Emit a class-valued escape, folded when caseless.
  private setAtom(cs: CharSet): void {
    this.atom(hostClass(this.caseless(cs)), [1, 1])
  }

  // A set folded when `i` is in force.
  private caseless(cs: CharSet): CharSet {
    const folded = fold(cs, !this.unicode)
    if (!this.flags.i) {
      if (!folded.equals(cs)) this.caseSensitiveText = true
      return cs
    }
    return folded
  }

  // Start the next alternative of the innermost group.
  private alternate(): void {
    const frame = this.top()
    frame.widths.push([frame.low, frame.high])
    frame.low = 0
    frame.high = 0
    this.out.push('|')
    frame.branches.push(this.out.length)
    this.atomStart = null
    this.repeatable = false
  }

  // Scan a `(` and the group syntax after it.
  private openGroup(): void {
    const start = this.pos
    if (this.startsWith('(*', start)) {
      this.verb(start)
      return
    }
    this.pos += 1
    if (this.peek() !== '?') {
      if (this.flags.n) this.push(start, '(?:', 'group')
      else this.capture(start, '')
      return
    }
    this.pos += 1
    const ch = this.peek()
    if (!ch) throw this.fail(MISSING_PAREN, this.src.length)
    if (this.startsWith('<=', this.pos) || this.startsWith('<!', this.pos)) {
      const negative = this.peek(1) === '!'
      this.pos += 2
      this.push(start, negative ? '(?<!' : '(?<=', 'behind', negative)
      return
    }
    if (ch === '=' || ch === '!') {
      this.pos += 1
      this.push(start, '(?' + ch, 'ahead', ch === '!')
      return
    }
    if (ch === '<' || ch === "'" || this.startsWith('P<', this.pos)) {
      this.pos += ch === 'P' ? 2 : 1
      this.capture(start, this.groupName(ch === "'" ? "'" : '>'))
      return
    }
    if (ch === ':') {
      this.pos += 1
      this.push(start, '(?:', 'group')
      return
    }
    if (ch === '>') {
      this.pos += 1
      this.openAtomic(start)
      return
    }
    if (ch === '#') {
      const close = this.find(')', this.pos)
      if (close < 0) throw this.fail(COMMENT_UNTERMINATED, this.src.length)
      this.pos = close + 1
      return
    }
    if (ch === 'C') {
      const close = this.find(')', this.pos)
      if (close < 0) throw this.fail(MISSING_PAREN, this.src.length)
      this.pos = close + 1
      return
    }
    if (this.startsWith('P=', this.pos) || this.startsWith('P>', this.pos)) {
      if (this.startsWith('P>', this.pos))
        throw this.fail(unsupported('(?P>name) recursion'), start)
      this.pos += 2
      const close = this.find(')', this.pos)
      if (close < 0) throw this.fail(NAME_UNTERMINATED, this.src.length)
      const name = this.slice(this.pos, close)
      const at = this.pos
      this.pos = close + 1
      this.namedBackref(name, at)
      return
    }
    if (ch === '|') throw this.fail(unsupported('(?| branch reset'), start)
    if (ch === '(') throw this.fail(unsupported('(?( conditional group'), start)
    if ('R&+'.includes(ch) || /^[0-9]$/.test(ch) || (ch === '-' && /^[0-9]$/.test(this.peek(1)))) {
      throw this.fail(unsupported('recursion'), start)
    }
    if (ch === '*') throw this.fail(unsupported('(?* non-atomic lookaround'), start)
    this.inlineFlags(start)
  }

  // A `(*...)` item: a start-of-pattern option or a verb.
  private verb(start: number): void {
    const close = this.find(')', start)
    if (close < 0) throw this.fail(MISSING_PAREN, this.src.length)
    const name = this.slice(start + 2, close)
    if ((start === 0 || this.out.length === 0) && VERBS.has(name)) {
      this.pos = close + 1
      return
    }
    throw this.fail(unsupported(`(*${name})`), start)
  }

  // Open a capturing group.
  private capture(start: number, name: string): void {
    this.groups += 1
    this.hostGroups += 1
    this.groupMap.set(this.groups, this.hostGroups)
    if (name) {
      if (this.names.has(name)) throw this.fail(NAME_DUPLICATE)
      this.names.add(name)
    }
    this.push(start, name ? `(?<${name}>` : '(', 'group')
  }

  // Read a group name through its terminator (`>` or `'`).
  private groupName(terminator: string): string {
    const begin = this.pos
    if (this.pos >= this.src.length || this.peek() === terminator) throw this.fail(NAME_EXPECTED)
    if (/^[0-9]$/.test(this.peek())) throw this.fail(NAME_DIGIT)
    if (!NAME_START.test(this.peek())) throw this.fail(NAME_EXPECTED)
    const found = this.stickyAt(NAME_CHARS, begin)
    this.pos = found === null ? begin : found[1]
    if (this.peek() !== terminator) throw this.fail(NAME_UNTERMINATED)
    const name = this.slice(begin, this.pos)
    this.pos += 1
    return name
  }

  // Open a group whose host opener is `opener`.
  private push(start: number, opener: string, kind: Frame['kind'], negative = false): Frame {
    const frame = frameOf(start, this.out.length, this.flags, kind, negative)
    this.stack.push(frame)
    this.out.push(opener)
    frame.branches.push(this.out.length)
    this.atomStart = null
    this.repeatable = false
    return frame
  }

  // Open `(?>`: JavaScript has no atomic group, so it is a lookahead whose
  // capture the next item must re-match, which gives up nothing it took.
  private openAtomic(start: number): void {
    this.atomics += 1
    this.hostGroups += 1
    const frame = this.push(start, `(?=(?<${ATOMIC_PREFIX}${String(this.atomics)}>`, 'atomic')
    frame.atomic = this.atomics
  }

  // Read `(?flags)` or `(?flags:`, the position past `(?`.
  private inlineFlags(start: number): void {
    const flags: { -readonly [K in keyof Flags]: boolean } = { ...this.flags }
    let on = true
    if (this.peek() === '^') {
      Object.assign(flags, { i: false, m: false, n: false, s: false, x: false, xx: false })
      this.pos += 1
    }
    let ch = ''
    for (;;) {
      if (this.pos >= this.src.length) throw this.fail(MISSING_PAREN, this.src.length)
      ch = this.src[this.pos] ?? ''
      this.pos += 1
      if (ch === ':' || ch === ')') break
      if (ch === '-' && on) {
        on = false
        continue
      }
      if (!FLAG_LETTERS.includes(ch)) throw this.fail(BAD_GROUP_SYNTAX, this.pos - 1)
      if (ch === 'J') continue
      if (ch === 'x' && this.peek() === 'x') {
        this.pos += 1
        flags.x = on
        flags.xx = on
        continue
      }
      flags[ch as keyof Flags] = on
    }
    if (ch === ':') {
      this.push(start, '(?:', 'group')
    } else {
      this.atomStart = null
      this.repeatable = false
    }
    this.flags = flags
  }

  // Scan a `)`.
  private closeGroup(): void {
    if (this.stack.length === 1) throw this.fail(UNMATCHED_PAREN)
    const frame = this.stack.pop() ?? this.top()
    this.pos += 1
    frame.widths.push([frame.low, frame.high])
    this.flags = frame.flags
    if (frame.kind === 'behind') {
      this.closeLookbehind(frame)
      return
    }
    this.out.push(')')
    if (frame.kind === 'atomic' && frame.atomic) {
      this.out.push(`)\\k<${ATOMIC_PREFIX}${String(frame.atomic)}>`)
    }
    this.out.splice(
      frame.outStart,
      this.out.length - frame.outStart,
      this.out.slice(frame.outStart).join(''),
    )
    this.atomStart = frame.outStart
    this.atomHostGroups = this.hostGroupsAt(frame)
    this.repeatable = true
    this.quantified = false
    if (frame.kind === 'ahead') {
      this.atomWidth = [0, 0]
      this.look = true
      return
    }
    const lows = frame.widths.map((w) => w[0])
    const highs = frame.widths.map((w) => w[1])
    const width: Width = [
      Math.min(...lows),
      highs.includes(null) ? null : Math.max(...highs.map((h) => h ?? 0)),
    ]
    this.atomWidth = width
    this.look = false
    const parent = this.top()
    ;[parent.low, parent.high] = addWidth([parent.low, parent.high], width)
  }

  // The host group count just before a frame's text: the groups whose
  // opener precedes it in the emitted source.
  private hostGroupsAt(frame: Frame): number {
    return countHostGroups(this.out.slice(0, frame.outStart).join(''))
  }

  // Close `(?<=` / `(?<!` as fixed-length host lookbehinds. PCRE2 10.43
  // accepts a bounded lookbehind whose alternatives differ in length;
  // python's engine takes one fixed length per lookbehind, so each
  // alternative becomes its own, joined with `|` for a positive assertion and
  // in sequence for a negative one. An alternative that is itself variable is
  // refused, on both hosts alike.
  private closeLookbehind(frame: Frame): void {
    for (const [low, high] of frame.widths) {
      if (high === null) throw this.fail(LOOKBEHIND_UNLIMITED, frame.openAt)
      if (low !== high) throw this.fail(unsupported('a variable-length lookbehind'), frame.openAt)
    }
    const edges = [...frame.branches, this.out.length + 1]
    const bodies = frame.branches.map((begin, i) =>
      this.out.slice(begin, (edges[i + 1] ?? this.out.length + 1) - 1).join(''),
    )
    const opener = frame.negative ? '(?<!' : '(?<='
    let text: string
    if (bodies.length === 1) text = opener + (bodies[0] ?? '') + ')'
    else if (frame.negative) text = bodies.map((b) => opener + b + ')').join('')
    else text = '(?:' + bodies.map((b) => opener + b + ')').join('|') + ')'
    this.out.splice(frame.outStart, this.out.length - frame.outStart, text)
    this.atomStart = null
    this.repeatable = false
  }

  // Scan a quantifier and its lazy or possessive suffix.
  private quantifier(op: string): void {
    let at = this.pos
    let low: number
    let high: number | null
    let token: string
    if (op === '{') {
      const interval = this.intervalAt(this.pos)
      if (interval === null) throw this.fail(NOTHING_TO_REPEAT, at)
      ;[low, high] = interval
      this.pos = interval[2]
      at = interval[2] - 1
      token =
        high === low
          ? `{${String(low)}}`
          : high === null
            ? `{${String(low)},}`
            : `{${String(low)},${String(high)}}`
    } else {
      this.pos += 1
      ;[low, high] = op === '*' ? [0, null] : op === '+' ? [1, null] : [0, 1]
      token = op
    }
    if (!this.repeatable || this.quantified || this.atomStart === null) {
      throw this.fail(NOTHING_TO_REPEAT, at)
    }
    let suffix = ''
    if (this.peek() === '?' || this.peek() === '+') {
      suffix = this.peek()
      this.pos += 1
    }
    if (suffix === '' && this.flags.U) suffix = '?'
    else if (suffix === '?' && this.flags.U) suffix = ''
    const start = this.atomStart
    if (this.look) {
      if (low === 0) this.out.splice(start)
      this.repeatable = false
      return
    }
    let body = this.out.slice(start).join('')
    if (this.out.length - start > 1) body = `(?:${body})`
    const width = this.atomWidth
    const frame = this.top()
    frame.low -= width[0]
    if (frame.high !== null && width[1] !== null) frame.high -= width[1]
    const least = width[0] * low
    let most = high === null || width[1] === null ? null : width[1] * high
    if (high === null && width[1] === 0) most = 0
    ;[frame.low, frame.high] = addWidth([frame.low, frame.high], [least, most])
    const text = suffix === '+' ? this.possessive(body + token) : body + token + suffix
    this.out.splice(start, this.out.length - start, text)
    this.quantified = true
    this.atomWidth = [least, most]
  }

  // A possessive quantifier: an atomic group around the greedy one. Its
  // synthetic capture opens before every group inside the repeated atom, so
  // those move one host number on.
  private possessive(greedy: string): string {
    this.atomics += 1
    this.hostGroups += 1
    for (const [user, host] of this.groupMap) {
      if (host > this.atomHostGroups) this.groupMap.set(user, host + 1)
    }
    const name = `${ATOMIC_PREFIX}${String(this.atomics)}`
    return `(?=(?<${name}>${greedy}))\\k<${name}>`
  }

  // A `{n}`, `{n,}`, `{n,m}` or `{,m}` quantifier at `i`: the bounds and the
  // index past the `}`, or null when the brace is a literal. Throws when the
  // bounds are out of order or too big.
  private intervalAt(i: number): [number, number | null, number] | null {
    const found = this.stickyAt(INTERVAL, i)
    if (found === null) return null
    const [m, end] = found
    const lowText = m[1] ?? ''
    const comma = m[2]
    const highText = m[3] ?? ''
    if (!lowText && !(comma !== undefined && highText)) return null
    const low = lowText ? Number(lowText) : 0
    const high = comma === undefined ? low : highText ? Number(highText) : null
    for (const value of [low, high]) {
      if (value !== null && value > 65535) throw this.fail(QUANTIFIER_BIG, end - 1)
    }
    if (high !== null && high < low) throw this.fail(QUANTIFIER_ORDER, end - 1)
    return [low, high, end]
  }

  // Scan one escape outside a class.
  private escape(): void {
    const start = this.pos
    if (this.pos + 1 >= this.src.length) throw this.fail(TRAILING_BACKSLASH, this.src.length)
    const ch = this.src[this.pos + 1] ?? ''
    this.pos += 2
    if (ch === 'Q') {
      const end = this.find('\\E', this.pos)
      const quoted = end < 0 ? this.src.slice(this.pos) : this.src.slice(this.pos, end)
      this.pos = end < 0 ? this.src.length : end + 2
      for (const c of quoted) this.literal(c.codePointAt(0) ?? 0)
      return
    }
    if (ch === 'E') return
    if (ch === 'K') {
      this.keep()
      return
    }
    if (ch === 'G') throw this.fail(unsupported('\\G'), start)
    if (ch === 'X' || ch === 'C') throw this.fail(unsupported('\\' + ch), start)
    if (ch === 'R') {
      this.atom('(?:\\r\\n|' + hostClass(NEWLINE_SEQUENCE) + ')', [1, 2])
      return
    }
    if (ch === 'b' || ch === 'B') {
      this.assertion(boundary(ch === 'b', this.unicode))
      return
    }
    if (ch === 'A') {
      this.assertion('^')
      return
    }
    if (ch === 'z') {
      this.assertion('$')
      return
    }
    if (ch === 'Z') {
      this.assertion('(?=\\n?$)')
      return
    }
    if (ch === 'N' && this.peek() === '{') {
      this.namedChar()
      return
    }
    if ((ch === 'g' || ch === 'k' || /^[1-9]$/.test(ch)) && this.reference(start, ch)) return
    const cs = this.classEscape(ch)
    if (cs !== null) {
      this.setAtom(cs)
      return
    }
    this.literal(this.charEscape(ch, false))
  }

  // `\N{U+hhhh}`, which only a UTF pattern may spell.
  private namedChar(): void {
    if (!this.unicode) throw this.fail(NAMED_CHAR_UTF)
    const close = this.find('}', this.pos)
    const body = close > 0 ? this.slice(this.pos + 1, close) : ''
    if (!body.startsWith('U+')) throw this.fail(CASE_ESCAPES)
    const digits = body.slice(2)
    if (!digits || !Array.from(digits).every((d) => HEX.test(d))) throw this.fail(DIGITS_MISSING)
    this.pos = close + 1
    this.literal(this.codePoint(Number.parseInt(digits, 16), close))
  }

  // `\K`: an empty marker group, refused inside a lookaround.
  private keep(): void {
    if (this.stack.some((f) => f.kind === 'ahead' || f.kind === 'behind')) {
      throw this.fail(KEEP_IN_LOOKAROUND, this.src.length)
    }
    this.hostGroups += 1
    this.out.push(`(?<${KEEP_PREFIX}${String(this.keeps)}>)`)
    this.keeps += 1
    this.atomStart = null
    this.repeatable = false
  }

  // A back-reference, or false when `\ddd` is an octal escape.
  private reference(start: number, ch: string): boolean {
    if (/^[0-9]$/.test(ch)) {
      const found = this.stickyAt(DIGITS, this.pos)
      const end = found === null ? this.pos : found[1]
      const number = Number(ch + this.slice(this.pos, end))
      if (number >= 10 && number > this.totalGroups) {
        if (ch === '8' || ch === '9') throw this.fail(NO_SUBPATTERN, end)
        return false
      }
      this.pos = end
      this.backref(number, this.pos - 1)
      return true
    }
    if (ch === 'g') {
      const found = this.stickyAt(G_REFERENCE, this.pos)
      if (found === null) {
        if (this.peek() === '<' || this.peek() === "'") {
          throw this.fail(unsupported('subroutine calls'), start)
        }
        throw this.fail(G_SYNTAX)
      }
      const [m, end] = found
      this.pos = end
      if (m[3] !== undefined) {
        this.namedBackref(m[3], end - Array.from(m[3]).length - 1)
        return true
      }
      let number = Number(m[1] ?? m[2])
      if (number < 0) number = this.groups + 1 + number
      if (number <= 0) throw this.fail(NO_SUBPATTERN, this.pos)
      this.backref(number, this.pos - 1)
      return true
    }
    const found = this.stickyAt(K_REFERENCE, this.pos)
    if (found === null) throw this.fail(K_SYNTAX)
    const [m, end] = found
    const at = this.pos + 1
    this.pos = end
    this.namedBackref(m[1] ?? m[2] ?? m[3] ?? '', at)
    return true
  }

  // Emit a numbered back-reference, resolved once every group is.
  private backref(number: number, offset: number): void {
    if (this.flags.i) this.caselessBackref = true
    this.atom(`${BACKREF_MARK}${String(this.backrefs.length)}${BACKREF_MARK}`, [0, null])
    this.backrefs.push([number, offset])
  }

  // Emit a back-reference by name; `at` is where the name starts, where
  // PCRE2 reports a missing group.
  private namedBackref(name: string, at: number): void {
    if (!this.names.has(name) && !namedGroups(this.text).has(name)) {
      throw this.fail(NO_SUBPATTERN, at)
    }
    if (this.flags.i) this.caselessBackref = true
    this.atom(`\\k<${name}>`, [0, null])
  }

  // A class-valued escape (`\d`, `\h`, `\pL` ...) or null.
  private classEscape(ch: string): CharSet | null {
    if (ch === 'N') return ALL.minus(CharSet.chars(0x0a))
    const table: Record<string, CharSet> = {
      d: this.unicode ? category('Nd') : ASCII_DIGIT,
      s: this.unicode ? PCRE_HSPACE.union(PCRE_VSPACE) : ASCII_SPACE,
      w: this.unicode ? pcreWord() : ASCII_WORD,
      h: PCRE_HSPACE,
      v: PCRE_VSPACE,
    }
    const cs = 'dswhvDSWHV'.includes(ch) ? table[ch.toLowerCase()] : undefined
    if (cs !== undefined) return ch === ch.toUpperCase() ? cs.negate() : cs
    if (ch === 'p' || ch === 'P') {
      const found = this.property()
      return ch === 'P' ? found.negate() : found
    }
    return null
  }

  // Read the name of `\p` / `\P` and look it up.
  private property(): CharSet {
    let name: string
    if (this.peek() === '{') {
      const close = this.find('}', this.pos)
      if (close < 0) throw this.fail(UNKNOWN_PROPERTY, this.src.length)
      name = this.slice(this.pos + 1, close)
      this.pos = close + 1
    } else if (this.pos < this.src.length) {
      name = this.src[this.pos] ?? ''
      this.pos += 1
      if (!/^\p{L}$/u.test(name)) throw this.fail(MALFORMED_PROPERTY)
    } else {
      throw this.fail(MALFORMED_PROPERTY, this.src.length)
    }
    const negated = name.startsWith('^')
    const cs = pcreProperty(negated ? name.slice(1) : name)
    if (cs === null) throw this.fail(unsupported(`\\p{${name}}`))
    return negated ? cs.negate() : cs
  }

  // A literal-valued escape's code point; inside a class `\b` is a backspace.
  private charEscape(ch: string, inClass: boolean): number {
    const simple = SIMPLE_ESCAPES[ch]
    if (simple !== undefined) return simple
    if (inClass && ch === 'b') return 0x08
    if (ch === 'c') {
      if (this.pos >= this.src.length) throw this.fail(TRAILING_C, this.src.length)
      const letter = this.src[this.pos] ?? ''
      this.pos += 1
      return (letter.toUpperCase().codePointAt(0) ?? 0) ^ 0x40
    }
    if (ch === 'x') return this.hexEscape()
    if (ch === 'o') {
      if (this.peek() !== '{') throw this.fail(DIGITS_MISSING)
      const close = this.find('}', this.pos)
      const digits = close > 0 ? this.slice(this.pos + 1, close) : ''
      if (close < 0 || !digits || !/^[0-7]+$/.test(digits)) {
        throw this.fail(
          digits || close < 0 ? OCTAL_BAD : DIGITS_MISSING,
          this.pos + 1 + firstOutside(digits, /^[0-7]$/),
        )
      }
      this.pos = close + 1
      return this.codePoint(Number.parseInt(digits, 8), close)
    }
    if (/^[0-9]$/.test(ch)) {
      if (ch === '8' || ch === '9') return ch.codePointAt(0) ?? 0
      const found = this.stickyAt(OCTAL_TAIL, this.pos)
      const end = found === null ? this.pos : found[1]
      const digits = ch + this.slice(this.pos, end)
      this.pos = end
      return Number.parseInt(digits, 8)
    }
    if ('LlUu'.includes(ch)) throw this.fail(CASE_ESCAPES)
    if (/^[0-9A-Za-z]$/.test(ch)) throw this.fail(ESCAPE_UNKNOWN, this.pos - 1)
    return ch.codePointAt(0) ?? 0
  }

  // Read the digits of `\x`.
  private hexEscape(): number {
    if (this.peek() === '{') {
      const close = this.find('}', this.pos)
      const digits = close > 0 ? this.slice(this.pos + 1, close) : ''
      if (close < 0 || !Array.from(digits).every((d) => HEX.test(d))) {
        throw this.fail(HEX_BAD, this.pos + 1 + firstOutside(digits, HEX))
      }
      if (!digits) throw this.fail(DIGITS_MISSING)
      this.pos = close + 1
      return this.codePoint(Number.parseInt(digits, 16), close)
    }
    const found = this.stickyAt(HEX_PAIR, this.pos)
    const end = found === null ? this.pos : found[1]
    const digits = this.slice(this.pos, end)
    if (!digits) throw this.fail(DIGITS_MISSING)
    this.pos = end
    return Number.parseInt(digits, 16)
  }

  // A numeric escape's value, refused past the code space.
  private codePoint(value: number, offset: number): number {
    const limit = this.unicode ? 0x10ffff : 0xff
    if (value > limit || (this.unicode && value >= 0xd800 && value <= 0xdfff)) {
      throw this.fail(CODE_POINT_BIG, offset)
    }
    return value
  }

  // Scan one bracket expression: its members, folded when caseless, then
  // negated.
  private parseClass(): CharSet {
    this.pos += 1
    let negated = false
    if (this.peek() === '^') {
      negated = true
      this.pos += 1
    }
    let cs = new CharSet()
    let first = true
    for (;;) {
      if (this.flags.xx) while (this.peek() === ' ' || this.peek() === '\t') this.pos += 1
      if (this.pos >= this.src.length) throw this.fail(MISSING_BRACKET, this.src.length)
      const ch = this.src[this.pos] ?? ''
      if (ch === ']' && !first) {
        this.pos += 1
        break
      }
      first = false
      if (this.startsWith('\\Q', this.pos)) {
        const end = this.find('\\E', this.pos + 2)
        const quoted = end < 0 ? this.src.slice(this.pos + 2) : this.src.slice(this.pos + 2, end)
        this.pos = end < 0 ? this.src.length : end + 2
        cs = cs.union(CharSet.chars(...quoted.map((c) => c.codePointAt(0) ?? 0)))
        continue
      }
      if (this.startsWith('\\E', this.pos)) {
        this.pos += 2
        continue
      }
      const posix = this.posixClass()
      if (posix !== null) {
        cs = cs.union(posix)
        continue
      }
      const low = this.classChar()
      const next = this.peek(1)
      const ranged = this.peek() === '-' && next !== ']' && next !== ''
      if (low instanceof CharSet) {
        if (ranged && !this.startsWith('\\E', this.pos + 1))
          throw this.fail(RANGE_BAD, this.pos + 1)
        cs = cs.union(low)
        continue
      }
      if (!ranged) {
        cs = cs.union(CharSet.chars(low))
        continue
      }
      this.pos += 1
      if (this.startsWith('[:', this.pos) && this.posixName() !== null)
        throw this.fail(RANGE_BAD, this.pos)
      const high = this.classChar()
      if (high instanceof CharSet) throw this.fail(RANGE_BAD, this.pos - 1)
      if (high < low) throw this.fail(RANGE_ORDER, this.pos - 1)
      cs = cs.union(CharSet.of([low, high]))
    }
    cs = this.caseless(cs)
    return negated ? cs.negate() : cs
  }

  // The name of a `[:name:]` at the position, or null.
  private posixName(): string | null {
    const close = this.find(':]', this.pos + 2)
    if (close < 0) return null
    const name = this.slice(this.pos + 2, close)
    return POSIX_NAME.test(name) ? name : null
  }

  // `[:name:]` or `[:^name:]` at the position, or null.
  private posixClass(): CharSet | null {
    if (!this.startsWith('[:', this.pos)) return null
    const name = this.posixName()
    if (name === null) return null
    const negated = name.startsWith('^')
    const bare = negated ? name.slice(1) : name
    if (bare === '<' || bare === '>') throw this.fail(unsupported(`[[:${bare}:]]`), this.pos)
    const cs = posixSet(bare, this.unicode)
    if (cs === null) throw this.fail(POSIX_UNKNOWN, this.find(':]', this.pos + 2) + 2)
    this.pos = this.find(':]', this.pos + 2) + 2
    return negated ? cs.negate() : cs
  }

  // One character (or class escape) inside a class.
  private classChar(): number | CharSet {
    const ch = this.src[this.pos] ?? ''
    if (ch !== '\\') {
      this.pos += 1
      return ch.codePointAt(0) ?? 0
    }
    if (this.pos + 1 >= this.src.length) throw this.fail(TRAILING_BACKSLASH, this.src.length)
    const letter = this.src[this.pos + 1] ?? ''
    this.pos += 2
    if (letter === 'N') throw this.fail(N_IN_CLASS)
    if ('BRXGKAzZgk'.includes(letter)) throw this.fail(ESCAPE_IN_CLASS)
    return this.classEscape(letter) ?? this.charEscape(letter, true)
  }
}

// The index of the first character of `text` the escape does not take.
function firstOutside(text: string, allowed: RegExp): number {
  const chars = Array.from(text)
  const found = chars.findIndex((ch) => !allowed.test(ch))
  return found < 0 ? chars.length : found
}

const WORD_SOURCE = new Map<boolean, string>()

// The host class for `\w`, built once per mode.
function wordSource(unicode: boolean): string {
  let found = WORD_SOURCE.get(unicode)
  if (found === undefined) {
    found = hostClass(unicode ? pcreWord() : ASCII_WORD)
    WORD_SOURCE.set(unicode, found)
  }
  return found
}

// Spencer's `[[:<:]]` / `[[:>:]]`: a word's start or end.
function wordEdge(start: boolean, unicode: boolean): string {
  const w = wordSource(unicode)
  return start ? `(?<!${w})(?=${w})` : `(?<=${w})(?!${w})`
}

// `\b` (`word`) or `\B` over the dialect's word class.
function boundary(word: boolean, unicode: boolean): string {
  const w = wordSource(unicode)
  if (word) return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`
  return `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`
}

// One POSIX class, under UCP as PCRE2 maps it to properties.
function posixSet(name: string, unicode: boolean): CharSet | null {
  const ascii = Object.hasOwn(ASCII_CLASSES, name) ? ASCII_CLASSES[name] : undefined
  if (ascii === undefined) return null
  if (!unicode || name === 'ascii' || name === 'xdigit') return ascii
  const parts = UCP_POSIX[name]
  if (parts !== undefined) {
    let out = new CharSet()
    for (const part of parts) out = out.union(category(part))
    return out
  }
  if (name === 'space') return PCRE_HSPACE.union(PCRE_VSPACE)
  if (name === 'blank') return PCRE_HSPACE
  if (name === 'word') return pcreWord()
  let graph = new CharSet()
  for (const part of ['L', 'M', 'N', 'P', 'S', 'Cf']) graph = graph.union(category(part))
  graph = graph.minus(GRAPH_EXCLUDED)
  if (name === 'graph') return graph
  if (name === 'print') return graph.union(category('Zs')).minus(GRAPH_EXCLUDED)
  return category('P').union(category('S').intersect(ASCII_CLASSES.ascii ?? new CharSet()))
}

// A `\p` name as PCRE2 reads it, or null.
function pcreProperty(name: string): CharSet | null {
  const special: Record<string, () => CharSet> = {
    'L&': () => category('LC'),
    Xan: () => category('L').union(category('N')),
    Xsp: () => PCRE_HSPACE.union(PCRE_VSPACE),
    Xps: () => PCRE_HSPACE.union(PCRE_VSPACE),
    Xwd: () => pcreWord(),
  }
  const make = Object.hasOwn(special, name) ? special[name] : undefined
  return make !== undefined ? make() : unicodeProperty(name)
}

const GROUP_COUNTS = new Map<string, number>()

// How many capturing groups a PCRE2 pattern has, for `\10`.
function countGroups(pattern: string): number {
  const cached = GROUP_COUNTS.get(pattern)
  if (cached !== undefined) return cached
  let count = 0
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '\\') {
      if (pattern.startsWith('\\Q', i)) {
        const end = pattern.indexOf('\\E', i + 2)
        i = end < 0 ? pattern.length : end + 2
        continue
      }
      i += 2
      continue
    }
    if (ch === '[') {
      i += 1
      if (pattern[i] === '^') i += 1
      if (pattern[i] === ']') i += 1
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (ch === '(') {
      const rest = pattern.slice(i + 1, i + 4)
      const plain = !rest.startsWith('?') && !rest.startsWith('*')
      const named =
        (rest.startsWith('?<') || rest.startsWith("?'") || rest.startsWith('?P<')) &&
        !rest.startsWith('?<=') &&
        !rest.startsWith('?<!')
      if (plain || named) count += 1
    }
    i += 1
  }
  if (GROUP_COUNTS.size > 256) GROUP_COUNTS.clear()
  GROUP_COUNTS.set(pattern, count)
  return count
}

// The group names a PCRE2 pattern defines anywhere.
function namedGroups(pattern: string): Set<string> {
  return new Set(Array.from(pattern.matchAll(GROUP_NAMES), (m) => m[1] ?? m[2] ?? ''))
}

/**
 * The capturing groups of a host source in opener order: whether each is a
 * synthetic group (a `\K` marker or an emulated atomic group). The source is
 * one of this module's own, so an escape, a class and a group opener are all
 * that need reading.
 */
function hostGroupKinds(source: string): boolean[] {
  const kinds: boolean[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      i += 1
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (ch === '(') {
      if (source[i + 1] !== '?') kinds.push(false)
      else if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
        kinds.push(source.startsWith(SYNTHETIC_PREFIX, i + 3))
      }
    }
    i += 1
  }
  return kinds
}

// The host groups a source opens, synthetic ones included.
function countHostGroups(source: string): number {
  return hostGroupKinds(source).length
}

/**
 * Translate a PCRE2 pattern into this host's regex dialect: `u`-flag source
 * and whether the host must fold case. `pattern` is what PCRE2 would compile,
 * after any -w/-x wrapping the caller applies; `unicode` is UTF with UCP
 * (ripgrep's default), else grep's ASCII classes. Either way mirage matches
 * code points, not bytes: `\x{00a0}` is the no-break space. Throws PcreError
 * for a pattern PCRE2 refuses or one no host engine can express.
 */
export function translatePcre(
  pattern: string,
  unicode = false,
  ignoreCase = false,
  multiLine = false,
  // PCRE2_DOTALL.
  dotall = false,
  // PCRE2_NEWLINE_ANYCRLF (--crlf with --multiline).
  crlf = false,
): HostRegex {
  if (ignoreCase && !INLINE_CASE.test(pattern)) {
    const translated = new PcreTranslator(
      pattern,
      unicode,
      { ...DEFAULT_FLAGS, m: multiLine, s: dotall },
      crlf,
    ).translate()
    return { source: translated.source, ignoreCase: true }
  }
  return new PcreTranslator(
    pattern,
    unicode,
    { ...DEFAULT_FLAGS, i: ignoreCase, m: multiLine, s: dotall },
    crlf,
  ).translate()
}

// The `u` (and, with a `\K`, `d`) flags a translated source compiles with.
export function hostFlags(source: string, ignoreCase: boolean): string {
  return 'u' + (ignoreCase ? 'i' : '') + (source.includes(`(?<${KEEP_PREFIX}`) ? 'd' : '')
}

/**
 * Where a match starts as PCRE2 reports it: past its last `\K`. The marker
 * groups' positions come from the `d` flag's indices, which `hostFlags` sets
 * whenever the source has one.
 */
export function matchStart(m: RegExpExecArray): number {
  const groups = m.indices?.groups
  if (groups === undefined) return m.index
  let start = -1
  for (const name of Object.keys(groups)) {
    const span = groups[name]
    if (span !== undefined && name.startsWith(KEEP_PREFIX)) start = Math.max(start, span[0])
  }
  return start < 0 ? m.index : start
}

// The text a match reports: from `matchStart` to its end.
export function matchText(m: RegExpExecArray): string {
  const start = matchStart(m)
  return start === m.index ? m[0] : m.input.slice(start, m.index + m[0].length)
}

const USER_GROUPS = new Map<string, readonly number[]>()

/**
 * The host group number of each group the user's pattern numbers. Synthetic
 * groups (`\K` markers, emulated atomic groups) take host numbers of their
 * own, so `$1` in a replacement is the first host group that is not one.
 */
export function userGroups(pattern: RegExp): readonly number[] {
  const cached = USER_GROUPS.get(pattern.source)
  if (cached !== undefined) return cached
  const numbers: number[] = []
  hostGroupKinds(pattern.source).forEach((synthetic, i) => {
    if (!synthetic) numbers.push(i + 1)
  })
  if (USER_GROUPS.size > 256) USER_GROUPS.clear()
  USER_GROUPS.set(pattern.source, numbers)
  return numbers
}

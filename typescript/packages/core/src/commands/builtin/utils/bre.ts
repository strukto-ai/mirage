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

// The strings glibc's `regerror` produces, which every GNU tool that
// compiles a BRE prints verbatim after its own `<prog>: ` prefix. Measured
// pattern by pattern on glibc 2.39 through BOTH `expr abc : PAT` and
// `nl -b pPAT`, which answer identically, so this is one table and not two.
// They are glibc-specific -- POSIX does not word these, and BSD libc words
// them differently -- so they look unusual on purpose: `expr abc : '\('`
// really does say `Unmatched ( or \(`.
import { POSIX_CLASSES, compilePosixRegex } from '../../../utils/posix.ts'
const UNMATCHED_OPEN = 'Unmatched ( or \\('
const UNMATCHED_CLOSE = 'Unmatched ) or \\)'
const UNMATCHED_BRACE = 'Unmatched \\{'
const UNMATCHED_BRACKET = 'Unmatched [, [^, [:, [., or [='
const INVALID_PATTERN = 'Invalid regular expression'
const TRAILING_BACKSLASH = 'Trailing backslash'
const BAD_CLASS_NAME = 'Invalid character class name'
const BAD_COLLATE = 'Invalid collation character'
const BAD_BRACE_CONTENT = 'Invalid content of \\{\\}'
const BAD_BACKREF = 'Invalid back reference'
const BAD_RANGE = 'Invalid range end'
const TOO_BIG = 'Regular expression too big'
const INVALID_PRECEDING = 'Invalid preceding regular expression'

// glibc's RE_DUP_MAX. An interval past it is refused by glibc rather than
// handed to the matcher, and both host engines have their own much larger
// ceilings, so the check has to live here for the two to agree.
const RE_DUP_MAX = 32767

const WORD_CHARS = '0-9A-Za-z_'
const SPACE_CHARS = ' \\t\\n\\v\\f\\r'

// `LC_ALL=C` expansions of the POSIX class names. expr runs in the C
// locale, so every class is the ASCII set and can be inlined into a host
// bracket expression, which is the only form python `re` and JavaScript
// `RegExp` both understand.

// GNU's `\w`/`\W`/`\s`/`\S` are expanded rather than passed through
// because python's own `\w` is Unicode-aware by default while GNU's is
// ASCII under `LC_ALL=C`. Expanding them also keeps this host and the
// python twin emitting the same character set instead of each inheriting
// its engine's idea of a word character.
const CLASS_ESCAPES: Record<string, string> = {
  w: `[${WORD_CHARS}]`,
  W: `[^${WORD_CHARS}]`,
  s: `[${SPACE_CHARS}]`,
  S: `[^${SPACE_CHARS}]`,
}

// The dialect-specific tokens. Three of them differ from the python twin
// (`bre.py`), and only one of the three is a real difference: python's `$`
// also matches just before a trailing newline, so a BRE `$` anchor has to
// become `\Z` there, where JavaScript's `$` without the `m` flag already
// means end-of-input. `BUFFER_START` and `BUFFER_END` (GNU's `` \` ``/`\'`)
// are spelled `^`/`$` here and `\A`/`\Z` there, which is the same thing on
// both hosts because neither side ever sets the multiline flag -- a
// 20,720-pattern differential over both dialects finds zero behavioural
// difference. A reader should not take either of those two for drift.
const ANCHOR_START = '^'
const ANCHOR_END = '$'
const BUFFER_START = '^'
const BUFFER_END = '$'
const WORD_START = `\\b(?=[${WORD_CHARS}])`
const WORD_END = `\\b(?<=[${WORD_CHARS}])`

const OUTSIDE_SPECIAL = '\\^$.|?*+()[]{}'
const INSIDE_SPECIAL = '\\]^-['

// An interval body. The low bound is optional, because glibc reads
// `\{,3\}` as `{0,3}` rather than refusing it (measured: `nl -b 'pa\{,3\}'`
// matches, and so does `pa\{,\}`); an entirely empty body is still refused.
// JavaScript's `$` is the absolute end of the subject without the `m` flag,
// so this refuses `a\{2<newline>\}` as GNU does; the python twin has to say
// `fullmatch` to get the same answer.
const INTERVAL_RE = /^([0-9]*)(,([0-9]*))?$/

// What an empty bracket expression becomes. An inverted plain-character
// range is not an error in glibc's expr/nl dialect -- `[z-a]` compiles and
// matches nothing, `[^z-a]` compiles and matches any one character -- but a
// host `[]` is an always-failing set in JavaScript and a syntax error in
// python, so the two are spelled out instead of left to the engine.
const MATCHES_NOTHING = '[^\\s\\S]'
const MATCHES_ANY_ONE = '[\\s\\S]'

// The bracket items a range endpoint may be. A collating element is one
// (`[[.a.]-z]` compiles); a character class and an equivalence class are not
// (`[[:alpha:]-z]`, `[[=a=]-z]` and `[a-[:alpha:]]` are all
// `Invalid range end`).
const RANGE_KINDS = new Set(['char', '.'])

// A pattern glibc's regex compiler refuses, worded as it words it.
export class BreError extends Error {}

/**
 * Which of glibc's syntax-bit sets a pattern is read with. `BASIC` is
 * `RE_SYNTAX_POSIX_BASIC` (grep, sed, expr, nl). `EGREP` is `RE_SYNTAX_EGREP`
 * as GNU grep 3.11 compiles `-E`: a repetition operator with nothing before
 * it is dropped (with dfa.c's `* at start of expression` warning when only the
 * start of the expression precedes it) and a brace that opens no valid
 * interval is a literal. `EXTENDED` is `RE_SYNTAX_POSIX_EXTENDED`, what
 * `regcomp(REG_EXTENDED)` reads (bash's `[[ =~ ]]`): both of those are
 * refusals there. Mirrors `PosixSyntax` in `bre.py`.
 */
export enum PosixSyntax {
  BASIC = 'basic',
  EGREP = 'egrep',
  EXTENDED = 'extended',
}

// One literal character, safe outside a host bracket expression:
// backslash-escaped when the host engine would otherwise read it as an
// operator.
function escapeOutside(ch: string): string {
  return OUTSIDE_SPECIAL.includes(ch) ? '\\' + ch : ch
}

// One literal character, safe inside a host bracket expression:
// backslash-escaped when it would otherwise close the set, negate it, or
// open a range.
function escapeInside(ch: string): string {
  return INSIDE_SPECIAL.includes(ch) ? '\\' + ch : ch
}

// The text between `\{` and `\}`, re-emitted as a host interval. Throws
// BreError when the body is not `n`, `n,` or `n,m`, when the bounds are
// inverted, or when a bound is past glibc's RE_DUP_MAX.
function intervalToken(body: string): string {
  const matched = INTERVAL_RE.exec(body)
  if (matched === null || body === '') throw new BreError(BAD_BRACE_CONTENT)
  const low = Number(matched[1] === '' ? '0' : matched[1])
  const bare = matched[2] === undefined
  let high: number | null
  if (bare) {
    high = low
  } else if (matched[3] === '') {
    high = null
  } else {
    high = Number(matched[3])
  }
  if (low > RE_DUP_MAX || (high !== null && high > RE_DUP_MAX)) {
    throw new BreError(TOO_BIG)
  }
  if (high === null) return `{${String(low)},}`
  if (high < low) throw new BreError(BAD_BRACE_CONTENT)
  if (bare) return `{${String(low)}}`
  return `{${String(low)},${String(high)}}`
}

// One member of a bracket expression, read at `i`. Answers the index just
// past the member, its kind (`char` for an ordinary byte, else the `:`/`.`/`=`
// of the construct it is) and its value -- one character for a byte, a
// collating element or an equivalence class, and the whole expanded set for a
// `[:class:]`. The value comes back unescaped, because the caller needs it
// twice and wants it differently each time: escaped for the host set, and raw
// to compare against the other end of a range. Throws BreError for an
// unterminated construct, a class name that is not a POSIX one, or a
// collating element the C locale has not got.
function bracketItem(src: string, i: number): [number, string, string] {
  const after = src.slice(i + 1, i + 2)
  if (src[i] === '[' && (after === ':' || after === '.' || after === '=')) {
    const close = src.indexOf(after + ']', i + 2)
    if (close < 0) throw new BreError(UNMATCHED_BRACKET)
    const name = src.slice(i + 2, close)
    if (after === ':') {
      const expansion = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined
      if (expansion === undefined) throw new BreError(BAD_CLASS_NAME)
      return [close + 2, after, expansion]
    }
    if (name.length !== 1) throw new BreError(BAD_COLLATE)
    return [close + 2, after, name]
  }
  return [i + 1, 'char', src[i] ?? '']
}

// A POSIX BRE scanned once and re-emitted in this host's dialect.
//
// GNU expr compiles its `:` and `match` patterns with
// `RE_SYNTAX_POSIX_BASIC`, where `\(`, `\|`, `\+`, `\?` and `\{n\}` are
// the operators and their bare spellings are literals -- the exact
// inverse of JavaScript `RegExp` and python `re`. Handing the pattern to
// either engine unchanged is wrong for every one of those constructs, so
// it is scanned here and emitted as the host's own syntax. The method
// names are mirrored one for one in `bre.py` so the two dialects
// cannot drift apart.
class BreTranslator {
  private readonly src: string
  private pos = 0
  private out: string[] = []
  private groups = 0
  private openGroups: number[] = []
  private groupStarts: number[] = []
  // Where the last repeatable atom begins in `out`, or null when there
  // is nothing to repeat: at the start of the pattern, after `\(`, after
  // `\|`, and after an anchor. BRE reads `*` as a literal in exactly
  // those positions, where both host engines instead throw "nothing to
  // repeat".
  private atomStart: number | null = null
  private atomQuantified = false
  // Where `^` is the anchor rather than a literal caret: the start of
  // the pattern, just after `\(`, and just after `\|`. Nowhere else,
  // and that is narrower than "nothing precedes": `^^a` matches a line
  // starting `^a`, so the second `^` is a literal although an anchor is
  // all that precedes it.
  private caretAnchors = true
  private readonly refuseInvertedRange: boolean
  private readonly syntax: PosixSyntax
  private readonly extended: boolean
  private readonly dotMatchesNul: boolean
  readonly warnings: string[] = []
  // glibc's `completed_bkref_map`: the groups a back-reference may name. A
  // branch of an alternation starts again from what was complete when the
  // alternation began, so `\(a\)\|\1` is `Invalid back reference` while
  // `\(\(a\)\|b\)\2` is not.
  private completed = new Set<number>()
  private altInitial: Set<number>[] = [new Set()]
  private altAccum: Set<number>[] = [new Set()]
  // dfa.c's `laststart`: only the start of the expression, a `(`, a `|` or
  // zero-width operators precede this position, which is where GNU grep
  // warns about a repetition operator.
  private laststart = true
  // An ERE repetition operator with nothing to repeat was just dropped;
  // glibc then reads the next token as an expression of its own, so a `)`
  // right after it is a literal.
  private dropped = false
  // Where in `out` the anchor that is the last thing emitted sits, for the
  // dfa's reading of a repetition applied to it.
  private anchorAt: number | null = null

  constructor(
    pattern: string,
    refuseInvertedRange: boolean,
    syntax = PosixSyntax.BASIC,
    dotMatchesNul = true,
  ) {
    this.src = pattern
    this.refuseInvertedRange = refuseInvertedRange
    this.syntax = syntax
    this.dotMatchesNul = dotMatchesNul
    this.extended = syntax !== PosixSyntax.BASIC
  }

  // Scan the whole pattern, returning the host pattern source and how
  // many capturing groups it has. The count is what tells `:` whether to
  // answer with group 1 or with the match length, and it has to survive
  // a failed match, where there is no match object to ask.
  translate(): [string, number] {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] ?? ''
      const dropped = this.dropped
      this.dropped = false
      if (ch === '\\') {
        this.escape()
      } else if (ch === '[') {
        this.bracket()
      } else if (ch === '*' || (this.extended && (ch === '+' || ch === '?'))) {
        this.pos += 1
        if (this.extended) this.ereRepeat(ch)
        else this.repeat('*', '*')
      } else if (this.extended && ch === '{') {
        this.pos += 1
        this.ereInterval()
      } else if (this.extended && ch === '(') {
        this.pos += 1
        this.openGroup()
      } else if (this.extended && ch === ')' && this.openGroups.length > 0 && !dropped) {
        this.pos += 1
        this.closeGroup()
      } else if (this.extended && ch === '|') {
        this.pos += 1
        this.alternate()
      } else if (ch === '.') {
        this.pos += 1
        this.atom(this.dotMatchesNul ? '.' : '(?:(?!\\x00).)')
      } else if (ch === '^') {
        this.pos += 1
        if (this.extended || this.caretAnchors) this.anchor(ANCHOR_START)
        else this.atom(escapeOutside('^'))
      } else if (ch === '$') {
        this.pos += 1
        if (this.extended || this.dollarIsAnchor()) this.anchor(ANCHOR_END)
        else this.atom(escapeOutside('$'))
      } else {
        this.pos += 1
        this.atom(escapeOutside(ch))
      }
    }
    if (this.openGroups.length > 0) throw new BreError(UNMATCHED_OPEN)
    return [this.out.join(''), this.groups]
  }

  // Whether the `$` just consumed was an anchor rather than a character.
  // glibc reads `$` as an anchor only at the very end of the pattern or
  // immediately before `\)` or `\|`; anywhere else it is a literal dollar
  // sign, which is why `expr 'a$b' : 'a$b'` is 3.
  private dollarIsAnchor(): boolean {
    if (this.pos >= this.src.length) return true
    const next = this.src.slice(this.pos, this.pos + 2)
    return next === '\\)' || next === '\\|'
  }

  // Emit one repeatable atom.
  private atom(text: string): void {
    this.atomStart = this.out.length
    this.out.push(text)
    this.atomQuantified = false
    this.caretAnchors = false
    this.laststart = false
    this.anchorAt = null
  }

  // Emit one anchor, which no quantifier may follow.
  private anchor(text: string): void {
    this.anchorAt = this.out.length
    this.out.push(text)
    this.atomStart = null
    this.atomQuantified = false
    this.caretAnchors = false
  }

  // Apply a quantifier to the last atom, or emit it as a literal.
  //
  // There is no "nothing to repeat" refusal, because glibc has none: every
  // position where it cannot repeat, it re-reads the operator as an ordinary
  // character instead. `nl -b 'p*'` matches a literal `*`, `p\+` matches a
  // `+`, and `p\{1\}` matches the three bytes `{1}` -- all exit 0. Both host
  // engines refuse those patterns outright, which is why this arm exists and
  // why glibc's `Invalid preceding regular expression` is absent from the
  // table at the top of this module: no BRE reaches it.
  private repeat(token: string, literal: string): void {
    const start = this.atomStart
    if (start === null) {
      this.atom(escapeOutside(literal))
      return
    }
    if (this.atomQuantified) {
      // glibc stacks quantifiers (`a**` is `(a*)*`); both host engines
      // reject a bare second one, so the atom is wrapped.
      this.out.splice(start, 0, '(?:')
      this.out.push(')')
    }
    this.out.push(token)
    this.atomQuantified = true
  }

  // Apply an ERE `*`, `+` or `?`, or drop it with nothing to repeat.
  //
  // glibc's `RE_CONTEXT_INDEP_OPS` skips an operator that has no expression
  // before it -- the start of the pattern, a `(`, a `|` or an anchor -- and
  // `RE_CONTEXT_INVALID_OPS` refuses it instead. GNU grep also warns where
  // dfa.c's `laststart` holds: measured, `grep -E '*a'` matches `a` and warns
  // `* at start of expression`, `grep -E 'a$*b'` drops the `*` without a word.
  //
  // After an anchor the line is selected as dfa.c reads it, where the
  // operator repeats the anchor: `a$?` and `^*a` select `ab` and `*ab` (GNU's
  // `-o` then prints nothing, because its regex matcher reads glibc's skip;
  // one matcher cannot give both answers).
  private ereRepeat(op: string): void {
    if (this.atomStart !== null) {
      this.repeat(op, op)
      return
    }
    if (this.syntax === PosixSyntax.EXTENDED) throw new BreError(INVALID_PRECEDING)
    if (this.laststart) this.warnings.push(`${op} at start of expression`)
    this.dropRepeat(op !== '+')
  }

  // Drop a repetition that has no expression before it; one that allows
  // zero means the anchor it follows no longer has to hold.
  private dropRepeat(optional: boolean): void {
    if (optional && this.anchorAt !== null) this.out.splice(this.anchorAt)
    this.anchorAt = null
    this.dropped = true
  }

  // Open one capturing group: ERE's `(` or BRE's `\(`.
  private openGroup(): void {
    this.groups += 1
    this.openGroups.push(this.groups)
    this.groupStarts.push(this.out.length)
    this.out.push('(')
    this.altInitial.push(new Set(this.completed))
    this.altAccum.push(new Set())
    this.anchorAt = null
    this.atomStart = null
    this.atomQuantified = false
    this.caretAnchors = true
    this.laststart = true
  }

  // Close the innermost group, which becomes the repeatable atom.
  private closeGroup(): void {
    const number = this.openGroups.pop() ?? 0
    const start = this.groupStarts.pop() ?? 0
    this.out.push(')')
    for (const n of this.altAccum.pop() ?? []) this.completed.add(n)
    this.altInitial.pop()
    this.completed.add(number)
    this.anchorAt = null
    this.atomStart = start
    this.atomQuantified = false
    this.caretAnchors = false
    this.laststart = false
  }

  // Start the next branch: ERE's `|` or BRE's `\|`.
  private alternate(): void {
    this.out.push('|')
    const accum = this.altAccum[this.altAccum.length - 1]
    for (const n of this.completed) accum?.add(n)
    this.completed = new Set(this.altInitial[this.altInitial.length - 1])
    this.anchorAt = null
    this.atomStart = null
    this.atomQuantified = false
    this.caretAnchors = true
    this.laststart = true
  }

  // Scan one backslash sequence.
  private escape(): void {
    if (this.pos + 1 >= this.src.length) throw new BreError(TRAILING_BACKSLASH)
    const ch = this.src[this.pos + 1] ?? ''
    this.pos += 2
    if (this.extended && '()|+?{}'.includes(ch)) {
      this.atom(escapeOutside(ch))
    } else if (ch === '(') {
      this.openGroup()
    } else if (ch === ')') {
      if (this.openGroups.length === 0) throw new BreError(UNMATCHED_CLOSE)
      this.closeGroup()
    } else if (ch === '|') {
      this.alternate()
    } else if (ch === '+') {
      this.repeat('+', '+')
    } else if (ch === '?') {
      this.repeat('?', '?')
    } else if (ch === '{') {
      this.interval()
    } else if (ch >= '1' && ch <= '9') {
      if (!this.completed.has(Number(ch))) throw new BreError(BAD_BACKREF)
      this.atom('\\' + ch)
    } else if (CLASS_ESCAPES[ch] !== undefined) {
      this.atom(CLASS_ESCAPES[ch] ?? '')
    } else if (ch === 'b') {
      this.anchor('\\b')
    } else if (ch === 'B') {
      this.anchor('\\B')
    } else if (ch === '<') {
      this.anchor(WORD_START)
    } else if (ch === '>') {
      this.anchor(WORD_END)
    } else if (ch === '`') {
      this.anchor(BUFFER_START)
    } else if (ch === "'") {
      this.anchor(BUFFER_END)
    } else {
      this.atom(escapeOutside(ch))
    }
  }

  // Scan one `\{n,m\}`, the position already past the `\{`.
  //
  // With nothing to repeat there is no interval to scan at all: glibc
  // re-reads the `\{` as a literal `{` and carries on from just after it, so
  // the body is never examined and `p\{2,1\}`, `p\{x\}` and `p\{32768\}` are
  // all accepted although every one of those bodies is refused in a real
  // interval. Measured: `nl -b 'p\{2,1\}'` matches the five bytes `{2,1}`.
  private interval(): void {
    if (this.atomStart === null) {
      this.atom(escapeOutside('{'))
      return
    }
    const close = this.src.indexOf('\\}', this.pos)
    if (close < 0) throw new BreError(UNMATCHED_BRACE)
    const body = this.src.slice(this.pos, close)
    this.pos = close + 2
    this.repeat(intervalToken(body), '{')
  }

  // Scan one ERE `{n,m}`, the position already past the `{`.
  //
  // glibc's `parse_dup_op` and `fetch_number`: `{,m}` is `{0,m}`, `{}` and
  // `{m,n,o}` are `Invalid content of \{\}`, and any other body that is not
  // digits and one comma rolls back to a literal `{` under
  // `RE_INVALID_INTERVAL_ORD` (grep -E: `a{x}` matches the four bytes) and is
  // refused without it (regcomp: `Unmatched \{` when the pattern ends
  // first). With nothing to repeat, grep drops a valid interval as dfa.c does
  // and warns `{...} at start of expression`, while an invalid one is a
  // literal brace.
  private ereInterval(): void {
    const start = this.pos
    if (this.atomStart === null && this.syntax === PosixSyntax.EXTENDED) {
      throw new BreError(INVALID_PRECEDING)
    }
    let token: string | null
    let end: number
    try {
      ;[token, end] = this.intervalBody(start)
    } catch (err) {
      if (!(err instanceof BreError) || this.atomStart !== null) throw err
      ;[token, end] = [null, start]
    }
    if (token === null) {
      this.atom(escapeOutside('{'))
      return
    }
    this.pos = end
    if (this.atomStart === null) {
      if (this.laststart) this.warnings.push('{...} at start of expression')
      this.dropRepeat(token.startsWith('{0}') || token.startsWith('{0,'))
      return
    }
    this.repeat(token, '{')
  }

  // glibc's reading of an interval body from `start` (just past the `{`):
  // the host quantifier and the index past the `}`, or null when the brace
  // rolls back to a literal. Throws BreError for a body glibc refuses in
  // every syntax.
  private intervalBody(start: number): [string | null, number] {
    let [low, i, term] = this.fetchNumber(start)
    let high = -2
    if (low === -1) {
      if (term !== ',') throw new BreError(BAD_BRACE_CONTENT)
      low = 0
    }
    if (low !== -2) {
      if (term === '}') high = low
      else if (term === ',') [high, i, term] = this.fetchNumber(i)
    }
    if (low === -2 || high === -2) {
      if (this.syntax === PosixSyntax.EGREP) return [null, start]
      throw new BreError(term === '' ? UNMATCHED_BRACE : BAD_BRACE_CONTENT)
    }
    if ((high !== -1 && low > high) || term !== '}') throw new BreError(BAD_BRACE_CONTENT)
    if ((high === -1 ? low : high) > RE_DUP_MAX) throw new BreError(TOO_BIG)
    if (high === -1) return [`{${String(low)},}`, i]
    if (high === low) return [`{${String(low)}}`, i]
    return [`{${String(low)},${String(high)}}`, i]
  }

  // glibc's `fetch_number`: digits up to a `}` or a `,`. Answers -1 when
  // nothing precedes the terminator, -2 when something other than a digit
  // does or the pattern ends first, else the value (capped just past
  // RE_DUP_MAX); the index past the terminator; and the terminator, empty at
  // the end of the pattern.
  private fetchNumber(from: number): [number, number, string] {
    let num = -1
    let i = from
    const src = this.src
    for (;;) {
      if (i >= src.length) return [-2, i, '']
      const ch = src[i] ?? ''
      if (ch === '\\') {
        i += 2
        num = -2
        continue
      }
      i += 1
      if (ch === '}' || ch === ',') return [num, i, ch]
      if (num === -2 || ch < '0' || ch > '9') num = -2
      else if (num === -1) num = Number(ch)
      else num = Math.min(RE_DUP_MAX + 1, num * 10 + Number(ch))
    }
  }

  // Scan one `[...]`, whose escaping rules are their own dialect. Inside a
  // POSIX bracket expression a backslash is an ordinary character, a `]` in
  // the first slot is a member rather than the close, and `[:alpha:]`-style
  // constructs are the only escapes there are. So the members are re-emitted
  // one at a time, each escaped for the host set, rather than passed through.
  //
  // Two of glibc's answers here are the opposite of what both host engines
  // say, and both are measured:
  //
  //   * An inverted plain range is LEGAL in expr's and nl's dialect. `[z-a]`
  //     compiles and matches nothing, `[^z-a]` compiles and matches any one
  //     character; JavaScript and python both refuse the range. So an inverted
  //     range contributes no members and an empty set is spelled out
  //     (MATCHES_NOTHING / MATCHES_ANY_ONE). grep and sed are the exception
  //     and refuse it (`grep '[z-a]'` is `Invalid range end`, exit 2), which
  //     is what `refuseInvertedRange` says.
  //   * `Invalid range end` is about the KIND of endpoint, not its order: a
  //     `[:class:]` or `[=equiv=]` on either side of the `-` is refused, a
  //     `[.elem.]` is not, and a `-x` that follows an already-closed range is
  //     (`[a-c-e]`).
  private bracket(): void {
    const src = this.src
    let i = this.pos + 1
    let negated = false
    if (i < src.length && src[i] === '^') {
      negated = true
      i += 1
    }
    // `[` or `[^` and then nothing. glibc answers REG_BADPAT for exactly
    // these two and REG_EBRACK for every other run-off, so `p[` is
    // `Invalid regular expression` while `p[a` is
    // `Unmatched [, [^, [:, [., or [=`.
    if (i >= src.length) throw new BreError(INVALID_PATTERN)
    const members: string[] = []
    let first = true
    for (;;) {
      if (i >= src.length) throw new BreError(UNMATCHED_BRACKET)
      if (src[i] === ']' && !first) {
        i += 1
        break
      }
      first = false
      const [afterItem, kind, value] = bracketItem(src, i)
      i = afterItem
      const dash = src.slice(i, i + 1)
      const beyond = src.slice(i + 1, i + 2)
      if (dash !== '-' || beyond === '' || beyond === ']') {
        members.push(kind === ':' ? value : escapeInside(value))
        continue
      }
      if (!RANGE_KINDS.has(kind)) throw new BreError(BAD_RANGE)
      const [afterHigh, highKind, high] = bracketItem(src, i + 1)
      i = afterHigh
      if (!RANGE_KINDS.has(highKind)) throw new BreError(BAD_RANGE)
      if (high >= value) members.push(escapeInside(value) + '-' + escapeInside(high))
      else if (this.refuseInvertedRange) throw new BreError(BAD_RANGE)
      // A `-` straight after a closed range is a second range end, which
      // glibc refuses: `[a-c-e]` is `Invalid range end` while `[a-c-]` and
      // `[a-cd-f]` both compile.
      const trailing = src.slice(i + 1, i + 2)
      if (src.slice(i, i + 1) === '-' && trailing !== '' && trailing !== ']') {
        throw new BreError(BAD_RANGE)
      }
    }
    this.pos = i
    if (members.length === 0) {
      this.atom(negated ? MATCHES_ANY_ONE : MATCHES_NOTHING)
      return
    }
    this.atom('[' + (negated ? '^' : '') + members.join('') + ']')
  }
}

// Translate a POSIX BRE into this host's regex dialect, answering the host
// pattern source and its group count. The raw entry point, for a caller that
// needs the source text rather than a matcher: `grep` splices several
// translated patterns into one alternation and wraps each in `\b` for `-w`,
// which it can only do with a string.
//
// `refuseInvertedRange` is true for grep's dialect, where a range whose end
// sorts before its start is refused, and false for expr's and nl's, where it
// compiles to an empty set. This is the one place the two GNU dialects
// disagree about what a pattern means (`grep '[z-a]'` is `Invalid range end`
// and exits 2, while `nl -b 'p[z-a]'` and `expr x : '[z-a]'` both exit 0
// having matched nothing).
export function translateBre(pattern: string, refuseInvertedRange = false): [string, number] {
  return new BreTranslator(pattern, refuseInvertedRange).translate()
}

// Translate a POSIX BRE and compile it. The `s` flag is set because
// `RE_SYNTAX_POSIX_BASIC` carries `RE_DOT_NEWLINE`, and the `y` flag
// because GNU matches with `re_match`, which is anchored at position 0 --
// sticky gives that without rewriting the pattern, so a top-level `\|`
// keeps meaning what it meant.
/**
 * Translate a POSIX ERE into this host's regex dialect: the same scanner as
 * `translateBre`, reading the extended syntax. An escape means exactly what
 * glibc says, so `\w \W \s \S \b \B \< \> \` \'` and back-references are
 * GNU's operators and any other escaped character is that character -- `\d`
 * is `d`, `\t` is `t` and `\x41` is `x41`, never the host's digit, tab or
 * `A`. A `(?` is glibc's, not a host group: the `?` has nothing to repeat. An
 * inverted range is refused, as `RE_NO_EMPTY_RANGES` does in both extended
 * syntaxes. Answers the host source, its group count, and GNU grep's warnings
 * (without the `grep: warning: ` prefix), which only `EGREP` produces.
 * `dotMatchesNul` controls whether a dot may consume a NUL byte.
 */
export function translateEre(
  pattern: string,
  syntax = PosixSyntax.EGREP,
  dotMatchesNul = true,
): [string, number, readonly string[]] {
  const translator = new BreTranslator(pattern, true, syntax, dotMatchesNul)
  const [source, groups] = translator.translate()
  return [source, groups, [...translator.warnings]]
}

/**
 * Translate a POSIX BRE and compile it, anchored at the start (`y`) with `.`
 * matching a newline (`s`, glibc's `RE_DOT_NEWLINE`). `utf8` means the subject
 * is text under a UTF-8 locale. Mirrors Python's `compile_bre`.
 */
export function compileBre(pattern: string, utf8 = false): [RegExp, number] {
  const [source, groups] = translateBre(pattern)
  try {
    return [compilePosixRegex(source, 'sy', utf8), groups]
  } catch (err) {
    throw new BreError(INVALID_PATTERN, { cause: err })
  }
}

// Translate a POSIX BRE and compile it for an unanchored search.
//
// The companion to `compileBre`, and the difference between them is the one
// thing the two callers disagree about. `expr` matches with `re_match`, which
// is anchored at position 0 -- so `expr abc : 'b'` is 0 -- while `nl` matches
// its `-b p<re>` style with `re_search`, which is not:
// `printf 'foo\n' | nl -b po` numbers the line. JavaScript spells that
// distinction in the flags (the `y` compileBre sets), python spells it at the
// call site, so the two hosts would drift if each caller picked its own; this
// keeps one function per behaviour and mirrors `search_bre` in `bre.py`.
//
// The group count `compileBre` reports is not returned, because a search only
// ever asks whether the subject matched.
// Ignore-case searches use the shared ASCII fold, including backreferences.
export function searchBre(pattern: string, ignoreCase = false): RegExp {
  const [source] = translateBre(pattern)
  try {
    return compilePosixRegex(source, ignoreCase ? 'si' : 's')
  } catch (err) {
    throw new BreError(INVALID_PATTERN, { cause: err })
  }
}

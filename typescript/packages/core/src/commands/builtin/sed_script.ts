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

import { byteChar, byteView, encodeText, textView } from '../../shell/bytes.ts'
import { compilePosixRegex } from '../../utils/posix.ts'
import { BreError, PosixSyntax, translateBre, translateEre } from './utils/bre.ts'

// The GNU sed version `v` compares against.
export const SED_VERSION = '4.9'

// The names GNU's get_openfile answers itself rather than opening.
export const SED_STDOUT = '/dev/stdout'
export const SED_STDERR = '/dev/stderr'

/**
 * One regex of a script: `null` in its place means the last one run.
 * `pattern` is the text between the delimiters; `source` is the host regex
 * it compiles to, through GNU's escape pre-pass and the glibc translator.
 */
export interface SedRegex {
  readonly pattern: string
  readonly source: string
  readonly groups: number
  readonly icase: boolean
  readonly multiline: boolean
}

/**
 * The host flags a sed regex compiles with. GNU sed's regex syntax has
 * RE_DOT_NEWLINE, so `.` matches the newline `N` puts in the pattern
 * space; `M` (REG_NEWLINE) takes that away and makes `^` and `$` line
 * anchors. Divergence: the host has no buffer-only anchor in multiline
 * mode, so under `M` GNU's `\`` and `\'` anchor at lines too, and `[^a]`
 * still matches a newline.
 */
export function sedRegexFlags(re: SedRegex, global: boolean): string {
  return (re.icase ? 'i' : '') + (re.multiline ? 'm' : 's') + (global ? 'g' : '')
}

export type SedAddr =
  | { readonly kind: 'num'; readonly n: number }
  | { readonly kind: 'mod'; readonly first: number; readonly step: number }
  | { readonly kind: 'step'; readonly n: number }
  | { readonly kind: 'stepmod'; readonly n: number }
  | { readonly kind: 'last' }
  | { readonly kind: 'null' }
  | { readonly kind: 'regex'; readonly re: SedRegex | null }

export interface SedSubst {
  re: SedRegex | null
  replacement: string
  global: boolean
  print: boolean
  numb: number
  outf: string | null
}

export interface SedCommand {
  cmd: string
  a1: SedAddr | null
  a2: SedAddr | null
  bang: boolean
  // a/i/c text, closing newline included; null when there is none.
  text?: string | null
  label?: string
  // Resolved target of `{`, `b`, `t` and `T`: the index of the matching
  // `}` or label, or the script's length for the end of the script.
  jump?: number
  // The number after `l`, `q` or `Q`; -1 when there is none.
  intArg?: number
  fname?: string
  // `0r FILE` writes the file before the first line instead of after it.
  prepend?: boolean
  subst?: SedSubst
  ySrc?: string[]
  yDst?: string[]
}

export interface SedProgram {
  commands: SedCommand[]
  // `#n` on the script's first line, which acts as -n.
  noDefaultOutput: boolean
  // Files `w`, `W` and `s///w` write, in the order GNU opens (truncates) them.
  wfiles: string[]
  // Files `r` reads (again at every append), and files `R` reads (opened
  // once, as GNU opens them when it compiles the command).
  rfiles: string[]
  readerFiles: string[]
  // Where GNU places an error found once the script has run out, as a
  // missing previous regex at run time: the last piece, past its end.
  endWhere: string
}

/** One -e expression or -f script file, in command-line order. */
export interface SedScriptPiece {
  kind: 'expr' | 'file'
  text: string
  // The script file's name as given, for `file NAME line N:`.
  name?: string
}

/**
 * What a piece of script text is, as GNU's `text_types`. It decides what an
 * escape spells: a regex and a replacement keep an unknown escape's
 * backslash for their own reader, and a replacement quotes the `\` or `&` a
 * numeric escape spells, so it stays a literal byte rather than a
 * backreference.
 */
enum SedText {
  BUFFER = 'buffer',
  REPLACEMENT = 'replacement',
  REGEX = 'regex',
}

/**
 * A script GNU refuses. `wfiles` are the files the script had opened
 * (and so truncated) before the error, since GNU opens a `w` file the
 * moment it compiles the command. `exitCode` is 1 for a syntax error and
 * 4 for GNU's panics (an undefined label).
 */
export class SedError extends Error {
  readonly exitCode: number
  readonly wfiles: readonly string[]

  constructor(message: string, exitCode = 1, wfiles: readonly string[] = []) {
    super(message)
    this.exitCode = exitCode
    this.wfiles = wfiles
  }
}

const BAD_BANG = "multiple `!'s"
const BAD_COMMA = "unexpected `,'"
const BAD_STEP = 'invalid usage of +N or ~N as first address'
const EXCESS_OPEN_BRACE = "unmatched `{'"
const EXCESS_CLOSE_BRACE = "unexpected `}'"
const EXCESS_JUNK = 'extra characters after command'
const EXPECTED_SLASH = "expected \\ after `a', `c' or `i'"
const NO_CLOSE_BRACE_ADDR = "`}' doesn't want any addresses"
const NO_COLON_ADDR = ": doesn't want any addresses"
const NO_SHARP_ADDR = "comments don't accept any addresses"
const NO_COMMAND = 'missing command'
const ONE_ADDR = 'command only uses one address'
const UNTERM_ADDR_RE = 'unterminated address regex'
const UNTERM_S_CMD = "unterminated `s' command"
const UNTERM_Y_CMD = "unterminated `y' command"
const UNKNOWN_S_OPT = "unknown option to `s'"
const EXCESS_P_OPT = "multiple `p' options to `s' command"
const EXCESS_G_OPT = "multiple `g' options to `s' command"
const EXCESS_N_OPT = "multiple number options to `s' command"
const ZERO_N_OPT = "number option to `s' command may not be zero"
const Y_CMD_LEN = "strings for `y' command are different lengths"
const BAD_DELIM = 'delimiter character is not a single-byte character'
const ANCIENT_VERSION = 'expected newer version of sed'
const INVALID_LINE_0 = 'invalid usage of line address 0'
const COLON_LACKS_LABEL = '":" lacks a label'
const RECURSIVE_ESCAPE_C = 'recursive escaping after \\c not allowed'
const MISSING_FILENAME = 'missing filename in r/R/w/W commands'
const BAD_MODIF = 'cannot specify modifiers on empty regexp'
const INVALID_PATTERN = 'Invalid regular expression'
const UNMATCHED_CLOSE = 'Unmatched ) or \\)'
// dfa.c's refusal of a bracket that looks like a class written without
// its outer brackets, which sed's dfawarn turns into a panic (exit 4).
const CONFUSING_BRACKET = 'character class syntax is [[:space:]], not [:space:]'
// GNU runs `e` and `s///e` through popen; mirage has no door to run a
// shell command from inside sed, so it refuses both where GNU compiles
// them, in the words GNU's own no-popen build uses at run time.
const NO_EVAL = "`e' command not supported"

const TEXT_ESCAPES: Record<string, string> = {
  a: '\x07',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\n': '\n',
}

const TEXT_ESCAPE_BASES: Record<string, number> = { d: 10, o: 8, x: 16 }

function isBlank(ch: string | null): boolean {
  return ch === ' ' || ch === '\t'
}

function isSpace(ch: string | null): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r'
}

function isDigit(ch: string | null): boolean {
  return ch !== null && ch >= '0' && ch <= '9'
}

// The first byte of one character, as GNU's bad_command prints it.
function firstByte(ch: string): string {
  const bytes = encodeText(ch)
  return bytes.length <= 1 ? ch : byteChar(bytes[0] ?? 0)
}

// GNU's strverscmp over two version strings: digit runs compare as numbers.
function versionCompare(a: string, b: string): number {
  const split = (s: string): string[] => s.match(/\d+|\D+/g) ?? []
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

interface BlockMark {
  index: number
  where: string
}

/**
 * GNU sed 4.9's compile.c over one script given as -e and -f pieces.
 * Pieces compile in order into one program, as GNU compiles each -e or
 * -f in turn: an a/i/c text a piece leaves open on a backslash goes on in
 * the next, a `{` in one closes in another, and labels are resolved once
 * the last piece is read. Every blank and error position follows GNU:
 * blanks and `;` before an address, blanks after one, around the range
 * comma and after `!`, then the command's own rules.
 */
class Compiler {
  private chars: string[] = []
  private pos = 0
  private line = 0
  private name: string | null = null
  private exprCount = 0
  private firstScript = true
  private readonly commands: SedCommand[] = []
  private readonly blocks: BlockMark[] = []
  private readonly labels = new Map<string, number>()
  private readonly jumps: [number, string][] = []
  private pendingText: string | null = null
  private oldTextCmd: SedCommand | null = null
  private noDefaultOutput = false
  private readonly wfiles: string[] = []
  private readonly rfiles: string[] = []
  private readonly readerFiles: string[] = []

  constructor(
    private readonly extended: boolean,
    private readonly utf8 = false,
  ) {}

  compile(pieces: readonly SedScriptPiece[]): SedProgram {
    for (const piece of pieces) {
      this.chars = Array.from(piece.text)
      this.pos = 0
      if (piece.kind === 'file') {
        this.line = 1
        this.name = piece.name ?? '-'
      } else {
        this.line = 0
        this.name = null
        this.exprCount += 1
      }
      this.compileProgram()
      this.firstScript = false
    }
    this.checkFinal()
    return {
      commands: this.commands,
      noDefaultOutput: this.noDefaultOutput,
      wfiles: this.wfiles,
      rfiles: this.rfiles,
      readerFiles: this.readerFiles,
      endWhere: this.blockWhere(),
    }
  }

  // `unread` is how many bytes of the last character GNU, reading byte
  // by byte, has not reached: an unknown command stops after the first
  // byte of a multibyte character.
  private where(unread = 0): string {
    if (this.name !== null) return `file ${this.name} line ${String(this.line)}`
    const consumed = encodeText(this.chars.slice(0, this.pos).join('')).length - unread
    return `-e expression #${String(this.exprCount)}, char ${String(consumed)}`
  }

  private bad(why: string, unread = 0): never {
    throw new SedError(`sed: ${this.where(unread)}: ${why}`, 1, [...this.wfiles])
  }

  private inchar(): string | null {
    if (this.pos >= this.chars.length) return null
    const ch = this.chars[this.pos] ?? null
    this.pos += 1
    if (ch === '\n') this.line += 1
    return ch
  }

  private savchar(ch: string | null): void {
    if (ch === null) return
    if (ch === '\n' && this.line > 0) this.line -= 1
    this.pos -= 1
  }

  private inNonblank(): string | null {
    let ch = this.inchar()
    while (isBlank(ch)) ch = this.inchar()
    return ch
  }

  private readEndOfCmd(): void {
    const ch = this.inNonblank()
    if (ch === '}' || ch === '#') this.savchar(ch)
    else if (ch !== null && ch !== '\n' && ch !== ';') this.bad(EXCESS_JUNK)
  }

  private inInteger(first: string | null): number {
    let num = 0
    let ch = first
    while (isDigit(ch)) {
      num = num * 10 + Number(ch)
      ch = this.inchar()
    }
    this.savchar(ch)
    return num
  }

  private readFilename(): string {
    let b = ''
    let ch = this.inNonblank()
    while (ch !== null && ch !== '\n') {
      b += ch
      ch = this.inchar()
    }
    return b
  }

  private openFile(write: boolean): string {
    const name = this.readFilename()
    if (name === '') this.bad(MISSING_FILENAME)
    const list = write ? this.wfiles : this.readerFiles
    if (!list.includes(name)) list.push(name)
    return name
  }

  // A label for `:`, `b`, `t`, `T` or `v`: it ends at a blank, `;`, `}`,
  // `#` or the end of the line.
  private readLabel(): string {
    let b = ''
    let ch = this.inNonblank()
    while (ch !== null && ch !== '\n' && !isBlank(ch) && ch !== ';' && ch !== '}' && ch !== '#') {
      b += ch
      ch = this.inchar()
    }
    this.savchar(ch)
    return b
  }

  private snarfCharClass(b: { v: string }): string | null {
    let state = 0
    let delim = ''
    const addThenNext = (c: string): string | null => {
      b.v += c
      return this.inchar()
    }
    let ch = this.inchar()
    if (ch === '^') ch = addThenNext(ch)
    if (ch === ']') ch = addThenNext(ch)
    for (; ; ch = addThenNext(ch)) {
      if (ch === null || ch === '\n') return ch
      if (ch === '.' || ch === ':' || ch === '=') {
        if (state === 1) {
          delim = ch
          state = 2
          continue
        }
        if (state === 2 && ch === delim) {
          state = 3
          continue
        }
      } else if (ch === '[') {
        if (state === 0) state = 1
        continue
      } else if (ch === ']') {
        if (state === 0 || state === 1) return ch
        if (state === 3) state = 0
      }
      state &= ~1
    }
  }

  // GNU's match_slash: read up to the closing delimiter. A backslash
  // before the delimiter is dropped (so `s|a\|b||` matches a literal
  // `a|b`), before a newline it leaves the newline, and before anything
  // else it stays. In a regex a bracket expression is read whole, so a
  // delimiter inside `[...]` does not end it.
  private matchSlash(slash: string | null, regex: boolean): string | null {
    if (slash !== null && (slash.codePointAt(0) ?? 0) > 0x7f) this.bad(BAD_DELIM)
    const b = { v: '' }
    let ch = this.inchar()
    while (ch !== null && ch !== '\n') {
      if (ch === slash) return b.v
      if (ch === '\\') {
        ch = this.inchar()
        if (ch === null) break
        if (ch !== '\n' && (ch !== slash || (!regex && ch === '&'))) b.v += '\\'
      } else if (ch === '[' && regex) {
        b.v += ch
        ch = this.snarfCharClass(b)
        if (ch !== ']') break
      }
      b.v += ch
      ch = this.inchar()
    }
    if (ch === '\n') this.savchar(ch)
    return null
  }

  // GNU's compile_regex: normalize_text's escapes, then regcomp in the
  // basic or extended syntax (here the glibc translator), whose refusal
  // is reported where the command was read, then dfa's bracket check. An
  // `s` whose replacement names a group the regex lacks is refused too.
  private regex(
    pattern: string,
    icase: boolean,
    multiline: boolean,
    reference = 0,
  ): SedRegex | null {
    if (pattern === '') {
      if (icase || multiline) this.bad(BAD_MODIF)
      return null
    }
    const normalized = this.normalizeText(pattern, SedText.REGEX)
    let source: string
    let groups: number
    try {
      if (this.extended) {
        // GNU sed clears RE_UNMATCHED_RIGHT_PAREN_ORD, which the POSIX
        // extended syntax sets: an unmatched `)` is refused, unless the
        // pattern before it is already refused for something else.
        const close = unmatchedCloseParen(normalized)
        if (close >= 0) {
          translateEre(normalized.slice(0, close), PosixSyntax.EXTENDED)
          throw new BreError(UNMATCHED_CLOSE)
        }
        ;[source, groups] = translateEre(normalized, PosixSyntax.EXTENDED)
      } else [source, groups] = translateBre(normalized, true)
    } catch (err) {
      if (!(err instanceof BreError)) throw err
      this.bad(err.message)
    }
    const re: SedRegex = { pattern, source, groups, icase, multiline }
    try {
      compilePosixRegex(source, sedRegexFlags(re, false), this.utf8)
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err
      this.bad(INVALID_PATTERN)
    }
    if (reference > groups) {
      this.bad(`invalid reference \\${String(reference)} on \`s' command's RHS`)
    }
    if (confusingBracket(normalized)) {
      throw new SedError(`sed: ${CONFUSING_BRACKET}`, 4, [...this.wfiles])
    }
    return re
  }

  // GNU's normalize_text, over the text's byte view: C escapes, `\dNNN`,
  // `\oNNN` and `\xHH` bytes and `\cX` control characters. In a text buffer
  // (a/i/c and y) a backslash before any other character is dropped; in a
  // regex it stays for regcomp, and what an escape produced is read as regex
  // syntax, so `\x2e` is any character and `\x5c` a trailing backslash. Under a
  // UTF-8 locale the result is read back as text, so `\xc3\xa9` is the one
  // character it spells.
  private normalizeText(text: string, kind = SedText.BUFFER): string {
    const buf = byteView(text)
    let out = ''
    let i = 0
    while (i < buf.length) {
      const ch = buf.charAt(i)
      if (ch !== '\\' || i + 1 >= buf.length) {
        out += ch
        i += 1
        continue
      }
      const nx = buf.charAt(i + 1)
      i += 2
      const simple = TEXT_ESCAPES[nx]
      if (simple !== undefined) {
        out += simple
        continue
      }
      const base = TEXT_ESCAPE_BASES[nx]
      if (base !== undefined) {
        let value = 0
        let digits = 0
        for (let max = 1; i < buf.length && max <= 255; max *= base) {
          const d = Number.parseInt(buf.charAt(i), 16)
          if (Number.isNaN(d) || d >= base) break
          value = value * base + d
          digits += 1
          i += 1
        }
        const char = digits === 0 ? nx : String.fromCharCode(value & 0xff)
        if (kind === SedText.REPLACEMENT && digits !== 0 && (char === '\\' || char === '&'))
          out += '\\'
        out += char
        continue
      }
      if (nx === 'c') {
        if (i >= buf.length) {
          if (kind === SedText.REGEX) out += '\\'
          continue
        }
        const x = buf.charAt(i)
        const upper = x >= 'a' && x <= 'z' ? x.toUpperCase() : x
        const char = String.fromCharCode(upper.charCodeAt(0) ^ 0x40)
        if (kind === SedText.REPLACEMENT && (char === '\\' || char === '&')) out += '\\'
        out += char
        i += 1
        if (x === '\\') {
          if (buf.charAt(i) !== '\\') this.bad(RECURSIVE_ESCAPE_C)
          i += 1
        }
        continue
      }
      out += kind === SedText.BUFFER ? nx : '\\' + nx
    }
    return this.utf8 ? textView(out) : out
  }

  // GNU's read_text. `leadin` is the text's first character, or a newline
  // for none. The text runs to the first newline no backslash escapes and
  // keeps that newline; a piece that ends on a backslash leaves the text
  // pending for the next piece.
  private readText(cmd: SedCommand | null, leadin: string | null): void {
    if (cmd !== null) {
      this.pendingText = ''
      cmd.text = null
      this.oldTextCmd = cmd
    }
    if (leadin === null) return
    let pending = this.pendingText ?? ''
    if (leadin !== '\n') pending += leadin
    let ch = this.inchar()
    while (ch !== null && ch !== '\n') {
      if (ch === '\\') {
        ch = this.inchar()
        if (ch !== null) pending += '\\'
      }
      if (ch === null) {
        this.pendingText = pending + '\n'
        return
      }
      pending += ch
      ch = this.inchar()
    }
    pending += '\n'
    const target = cmd ?? this.oldTextCmd
    if (target !== null) target.text = this.normalizeText(pending)
    this.pendingText = null
  }

  private compileAddress(first: string | null): SedAddr | null {
    let ch = first
    if (ch === '/' || ch === '\\') {
      if (ch === '\\') ch = this.inchar()
      const b = this.matchSlash(ch, true)
      if (b === null) this.bad(UNTERM_ADDR_RE)
      let icase = false
      let multiline = false
      for (;;) {
        ch = this.inNonblank()
        if (ch === 'I') icase = true
        else if (ch === 'M') multiline = true
        else {
          this.savchar(ch)
          return { kind: 'regex', re: this.regex(b, icase, multiline) }
        }
      }
    }
    if (isDigit(ch)) {
      const n = this.inInteger(ch)
      ch = this.inNonblank()
      if (ch !== '~') {
        this.savchar(ch)
        return { kind: 'num', n }
      }
      const step = this.inInteger(this.inNonblank())
      return step > 0 ? { kind: 'mod', first: n, step } : { kind: 'num', n }
    }
    if (ch === '+' || ch === '~') {
      const step = this.inInteger(this.inNonblank())
      if (step === 0) return { kind: 'null' }
      return ch === '+' ? { kind: 'step', n: step } : { kind: 'stepmod', n: step }
    }
    if (ch === '$') return { kind: 'last' }
    return null
  }

  private markSubstOpts(sub: SedSubst): [boolean, boolean] {
    let icase = false
    let multiline = false
    for (;;) {
      const ch = this.inNonblank()
      switch (ch) {
        case 'i':
        case 'I':
          icase = true
          break
        case 'm':
        case 'M':
          multiline = true
          break
        case 'e':
          this.bad(NO_EVAL)
          break
        case 'p':
          if (sub.print) this.bad(EXCESS_P_OPT)
          sub.print = true
          break
        case 'g':
          if (sub.global) this.bad(EXCESS_G_OPT)
          sub.global = true
          break
        case 'w':
          sub.outf = this.openFile(true)
          return [icase, multiline]
        case '}':
        case '#':
          this.savchar(ch)
          return [icase, multiline]
        case null:
        case '\n':
        case ';':
          return [icase, multiline]
        case '\r':
          if (this.inchar() === '\n') return [icase, multiline]
          this.bad(UNKNOWN_S_OPT)
          break
        default:
          if (isDigit(ch)) {
            if (sub.numb !== 0) this.bad(EXCESS_N_OPT)
            sub.numb = this.inInteger(ch)
            if (sub.numb === 0) this.bad(ZERO_N_OPT)
            break
          }
          this.bad(UNKNOWN_S_OPT)
      }
    }
  }

  private compileProgram(): void {
    if (this.pendingText !== null) this.readText(null, '\n')
    for (;;) {
      let ch = this.inchar()
      while (ch === ';' || isSpace(ch)) ch = this.inchar()
      if (ch === null) break
      const cmd: SedCommand = { cmd: '', a1: null, a2: null, bang: false }
      const a1 = this.compileAddress(ch)
      if (a1 !== null) {
        if (a1.kind === 'step' || a1.kind === 'stepmod') this.bad(BAD_STEP)
        cmd.a1 = a1
        ch = this.inNonblank()
        if (ch === ',') {
          const a2 = this.compileAddress(this.inNonblank())
          if (a2 === null) this.bad(BAD_COMMA)
          cmd.a2 = a2
          ch = this.inNonblank()
        }
        if (
          a1.kind === 'num' &&
          a1.n === 0 &&
          ((cmd.a2 === null && ch !== 'r') || (cmd.a2 !== null && cmd.a2.kind !== 'regex'))
        ) {
          this.bad(INVALID_LINE_0)
        }
      }
      if (ch === '!') {
        cmd.bang = true
        ch = this.inNonblank()
        if (ch === '!') this.bad(BAD_BANG)
      }
      if (ch === null) this.bad(NO_COMMAND)
      cmd.cmd = ch
      if (!this.compileCommand(cmd, ch)) continue
      this.commands.push(cmd)
    }
  }

  // Compile the command letter `ch`; false for `#` and `v`, which leave
  // nothing in the program.
  private compileCommand(cmd: SedCommand, ch: string): boolean {
    switch (ch) {
      case '#': {
        if (cmd.a1 !== null) this.bad(NO_SHARP_ADDR)
        let c = this.inchar()
        if (c === 'n' && this.firstScript && this.line < 2 && this.pos === 2) {
          this.noDefaultOutput = true
        }
        while (c !== null && c !== '\n') c = this.inchar()
        return false
      }
      case 'v': {
        const version = this.readLabel()
        if (versionCompare(version === '' ? '4.0' : version, SED_VERSION) > 0) {
          this.bad(ANCIENT_VERSION)
        }
        return false
      }
      case '{':
        this.blocks.push({ index: this.commands.length, where: this.blockWhere() })
        cmd.bang = !cmd.bang
        return true
      case '}': {
        const open = this.blocks.pop()
        if (open === undefined) this.bad(EXCESS_CLOSE_BRACE)
        if (cmd.a1 !== null) this.bad(NO_CLOSE_BRACE_ADDR)
        this.readEndOfCmd()
        const target = this.commands[open.index]
        if (target !== undefined) target.jump = this.commands.length
        return true
      }
      case 'e':
        this.bad(NO_EVAL)
        return false
      case 'a':
      case 'i':
      case 'c': {
        let c = this.inNonblank()
        if (c === null) this.bad(EXPECTED_SLASH)
        if (c === '\\') c = this.inchar()
        else {
          this.savchar(c)
          c = '\n'
        }
        this.readText(cmd, c)
        return true
      }
      case ':': {
        if (cmd.a1 !== null) this.bad(NO_COLON_ADDR)
        const label = this.readLabel()
        if (label === '') this.bad(COLON_LACKS_LABEL)
        cmd.label = label
        this.labels.set(label, this.commands.length)
        return true
      }
      case 'T':
      case 'b':
      case 't':
        cmd.label = this.readLabel()
        this.jumps.push([this.commands.length, cmd.label])
        return true
      case 'Q':
      case 'q':
      case 'L':
      case 'l': {
        if ((ch === 'q' || ch === 'Q') && cmd.a2 !== null) this.bad(ONE_ADDR)
        const c = this.inNonblank()
        if (isDigit(c)) cmd.intArg = this.inInteger(c)
        else {
          cmd.intArg = -1
          this.savchar(c)
        }
        this.readEndOfCmd()
        return true
      }
      case '=':
      case 'd':
      case 'D':
      case 'F':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'n':
      case 'N':
      case 'p':
      case 'P':
      case 'z':
      case 'x':
        this.readEndOfCmd()
        return true
      case 'r': {
        const name = this.readFilename()
        if (name === '') this.bad(MISSING_FILENAME)
        cmd.fname = name
        if (!this.rfiles.includes(name)) this.rfiles.push(name)
        if (cmd.a1 !== null && cmd.a1.kind === 'num' && cmd.a1.n === 0 && cmd.a2 === null) {
          cmd.a1 = { kind: 'num', n: 1 }
          cmd.prepend = true
        }
        return true
      }
      case 'R':
        cmd.fname = this.openFile(false)
        return true
      case 'W':
      case 'w':
        cmd.fname = this.openFile(true)
        return true
      case 's': {
        const slash = this.inchar()
        const pattern = this.matchSlash(slash, true)
        if (pattern === null) this.bad(UNTERM_S_CMD)
        const replacement = this.matchSlash(slash, false)
        if (replacement === null) this.bad(UNTERM_S_CMD)
        const sub: SedSubst = {
          re: null,
          replacement: this.normalizeText(replacement, SedText.REPLACEMENT),
          global: false,
          print: false,
          numb: 0,
          outf: null,
        }
        const [icase, multiline] = this.markSubstOpts(sub)
        sub.re = this.regex(pattern, icase, multiline, maxReference(replacement))
        cmd.subst = sub
        return true
      }
      case 'y': {
        const slash = this.inchar()
        const src = this.matchSlash(slash, false)
        if (src === null) this.bad(UNTERM_Y_CMD)
        const dst = this.matchSlash(slash, false)
        if (dst === null) this.bad(UNTERM_Y_CMD)
        const ySrc = Array.from(this.normalizeText(src))
        const yDst = Array.from(this.normalizeText(dst))
        if (ySrc.length !== yDst.length) this.bad(Y_CMD_LEN)
        cmd.ySrc = ySrc
        cmd.yDst = yDst
        this.readEndOfCmd()
        return true
      }
      default:
        this.bad(`unknown command: \`${firstByte(ch)}'`, encodeText(ch).length - 1)
    }
  }

  // Where an unmatched `{` is reported: GNU keeps the block's line but no
  // longer has a position within the expression, so it says char 0.
  private blockWhere(): string {
    if (this.name !== null) return `file ${this.name} line ${String(this.line)}`
    return `-e expression #${String(this.exprCount)}, char 0`
  }

  private checkFinal(): void {
    const open = this.blocks[this.blocks.length - 1]
    if (open !== undefined) {
      throw new SedError(`sed: ${open.where}: ${EXCESS_OPEN_BRACE}`, 1, [...this.wfiles])
    }
    if (this.pendingText !== null && this.oldTextCmd !== null) {
      this.oldTextCmd.text = this.pendingText === '' ? null : byteView(this.pendingText, this.utf8)
      this.pendingText = null
    }
    for (const [index, label] of this.jumps) {
      const target = this.labels.get(label)
      const cmd = this.commands[index]
      if (cmd === undefined) continue
      if (target !== undefined) cmd.jump = target
      else if (label !== '') {
        throw new SedError(`sed: can't find label for jump to \`${label}'`, 4, [...this.wfiles])
      } else cmd.jump = this.commands.length
    }
  }
}

/**
 * Compile a sed script given as its -e and -f pieces, as GNU sed 4.9 does.
 *
 * Throws SedError with GNU's wording, `sed: -e expression #N, char M:` or
 * `sed: file F line L:` before the reason.
 */
/**
 * Compile a sed script given as its -e and -f pieces, as GNU 4.9 does. `utf8`
 * is a UTF-8 locale, so the script's texts and regexes are characters rather
 * than bytes.
 */
export function compileScript(
  pieces: readonly SedScriptPiece[],
  extended = false,
  utf8 = false,
): SedProgram {
  return new Compiler(extended, utf8).compile(pieces)
}

/**
 * Whether the script ever asks if more input follows. GNU asks (`test_eof`)
 * for a `$` address and for `n` and `N`, and that lookahead passes over a
 * directory to the operands after it; only a new cycle reads the directory
 * and fails. So only a script that looks ahead needs the operands after a
 * directory.
 */
export function looksAhead(program: SedProgram): boolean {
  return program.commands.some(
    (cmd) =>
      cmd.cmd === 'n' || cmd.cmd === 'N' || cmd.a1?.kind === 'last' || cmd.a2?.kind === 'last',
  )
}

// The highest group an `s` replacement names (`\1`..`\9`), 0 for none.
function maxReference(replacement: string): number {
  let max = 0
  for (let i = 0; i < replacement.length; i++) {
    if (replacement.charAt(i) !== '\\') continue
    const d = replacement.charAt(i + 1)
    if (d >= '0' && d <= '9') max = Math.max(max, Number(d))
    i += 1
  }
  return max
}

// Where an ERE's first `)` with no open group sits, or -1.
function unmatchedCloseParen(pattern: string): number {
  let depth = 0
  let i = 0
  while (i < pattern.length) {
    const ch = pattern.charAt(i)
    if (ch === '\\') i += 2
    else if (ch === '[') i = bracketEnd(pattern, i)
    else {
      if (ch === '(') depth += 1
      else if (ch === ')') {
        if (depth === 0) return i
        depth -= 1
      }
      i += 1
    }
  }
  return -1
}

// The index just past the bracket expression opening at `start`.
function bracketEnd(pattern: string, start: number): number {
  let j = start + 1
  if (pattern.charAt(j) === '^') j += 1
  if (pattern.charAt(j) === ']') j += 1
  while (j < pattern.length && pattern.charAt(j) !== ']') {
    const open = pattern.charAt(j + 1)
    if (pattern.charAt(j) === '[' && (open === ':' || open === '.' || open === '=')) {
      const close = pattern.indexOf(`${open}]`, j + 2)
      j = close < 0 ? pattern.length : close + 2
    } else j += 1
  }
  return j + 1
}

/**
 * dfa.c's check for `[:space:]` written without its outer brackets: a
 * bracket expression that starts and ends with `:`, holds some other
 * character, and has no range or class inside. glibc accepts it (as the
 * set of those characters); GNU sed then refuses it.
 */
function confusingBracket(pattern: string): boolean {
  const chars = Array.from(pattern)
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '[') {
      i += 1
      continue
    }
    let j = i + 1
    if (chars[j] === '^') j += 1
    let state = chars[j] === ':' ? 1 : 0
    let first = true
    for (;;) {
      const c = chars[j]
      if (c === undefined) return false
      if (c === ']' && !first) {
        j += 1
        break
      }
      first = false
      state &= ~2
      const open = chars[j + 1]
      if (c === '[' && (open === ':' || open === '.' || open === '=')) {
        let k = j + 2
        while (k < chars.length && !(chars[k] === open && chars[k + 1] === ']')) k += 1
        j = k + 2
        state |= 8
        continue
      }
      const end = chars[j + 2]
      if (chars[j + 1] === '-' && end !== undefined && end !== ']') {
        state |= 8
        j += 3
        continue
      }
      state |= c === ':' ? 2 : 4
      j += 1
    }
    if (state === 7) return true
    i = j
  }
  return false
}

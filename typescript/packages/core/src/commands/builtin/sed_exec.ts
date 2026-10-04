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

import { byteView, fromByteView, textView } from '../../shell/bytes.ts'
import { compilePosixRegex } from '../../utils/posix.ts'
import {
  SED_STDERR,
  SED_STDOUT,
  sedRegexFlags,
  type SedAddr,
  type SedCommand,
  type SedProgram,
  type SedRegex,
} from './sed_script.ts'

// GNU's default `l` line length.
export const SED_LINE_LENGTH = 70

const LIST_ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
}

/**
 * Render a pattern space the way GNU's `l` (do_list) does.
 *
 * A printable ASCII byte is itself and a backslash is doubled; `\a \b \f
 * \n \r \t \v` are C escapes; every other byte, each byte of a multibyte
 * character included and whatever the locale, is three octal digits. A
 * line is folded with `\` before an escape that would reach `width`
 * columns, so 69 characters and the `\` fill a 70-column line; `width` 0
 * turns folding off, and 1 folds before every character. The end is `$`.
 */
export function listLine(text: string, width: number): string {
  let out = ''
  let col = 0
  for (const ch of text) {
    for (const byte of fromByteView(ch)) {
      let piece: string
      if (byte >= 0x20 && byte < 0x7f) piece = byte === 0x5c ? '\\\\' : String.fromCharCode(byte)
      else piece = LIST_ESCAPES[byte] ?? '\\' + byte.toString(8).padStart(3, '0')
      if (width > 0 && col + piece.length >= width) {
        out += '\\\n'
        col = 0
      }
      out += piece
      col += piece.length
    }
  }
  return out + '$\n'
}

/** One output stream and whether its last line was written without a newline. */
export class SedOutput {
  missingNewline = false

  constructor(readonly chunks: string[] = []) {}

  // GNU's output_missing_newline: a line written without its newline gets
  // it the moment anything else goes to the same stream.
  flushNewline(): void {
    if (this.missingNewline) {
      this.chunks.push('\n')
      this.missingNewline = false
    }
  }

  line(text: string, newline: boolean): void {
    this.flushNewline()
    this.chunks.push(text)
    if (newline) this.chunks.push('\n')
    else this.missingNewline = true
  }

  raw(text: string): void {
    this.chunks.push(text)
  }
}

/**
 * The contents of a file `r` or `R` names, read before the run: its text,
 * `null` when it could not be opened (GNU reads that as empty), or the
 * read-error line GNU panics with (a directory opens and then fails).
 */
export type SedFileContent = { text: string } | { error: string } | null

/**
 * One input operand in order: its text, or the error line GNU reports on
 * reaching it, with the exit code. A fatal error (a read error) stops the
 * run there, as GNU panics; any other is reported and skipped.
 */
export type SedInput =
  | { name: string; text: string }
  | { name: string; error: string; code: number; fatal: boolean }

export interface SedRunOptions {
  suppress: boolean
  separate: boolean
  lineLength: number
  // What each `r` file holds now, and what each `R` file held when the
  // script was compiled.
  files: ReadonlyMap<string, SedFileContent>
  readerFiles: ReadonlyMap<string, SedFileContent>
}

/** Thrown to stop the run the way GNU's panic exits: a message, then exit 4. */
class SedPanic extends Error {
  constructor(
    message: string,
    readonly code = 4,
  ) {
    super(message)
  }
}

interface AppendItem {
  text?: string
  rfile?: string
}

interface InputLine {
  text: string
  chomped: boolean
}

const RANGE_INACTIVE = 0
const RANGE_ACTIVE = 1
const RANGE_CLOSED = 2

function splitLines(text: string): InputLine[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (text.endsWith('\n')) {
    parts.pop()
    return parts.map((p) => ({ text: p, chomped: true }))
  }
  return parts.map((p, i) => ({ text: p, chomped: i < parts.length - 1 }))
}

function readerLines(text: string): string[] {
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl + 1
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

/**
 * GNU sed 4.9's execute.c over a compiled program.
 *
 * One machine lives for the whole command: the `w` files, the `R`
 * readers, the hold space and the last regex carry across its runs, so
 * -i can run it once per file. `stdout` and `stderr` collect what goes to
 * the special files and to the error stream; `process` returns the main
 * output, which is stdout itself unless -i sends it to the file.
 */
export class SedMachine {
  readonly stdout = new SedOutput()
  readonly stderrLines: string[] = []
  readonly wfiles = new Map<string, SedOutput>()
  quitCode: number | null = null
  panicCode: number | null = null
  badCode = 0

  private readonly program: SedProgram
  private readonly opts: SedRunOptions
  private readonly noDefaultOutput: boolean
  private readonly regexCache = new Map<SedRegex, RegExp>()
  private readonly globalCache = new Map<SedRegex, RegExp>()
  private readonly readers = new Map<string, { lines: string[]; pos: number } | null>()
  private readonly rangeState: number[]
  private readonly a2Number: number[]
  private readonly specialOut = new SedOutput(this.stdout.chunks)
  private readonly specialErr = new SedOutput()
  private lastRegex: SedRegex | null = null
  private files: ReadonlyMap<string, SedFileContent>

  private main = this.stdout
  private inputs: SedInput[] = []
  private fileIdx = 0
  private lines: InputLine[] = []
  private lineIdx = 0
  private fileName = '-'
  private resetAtNextFile = true
  private lineNumber = 0
  private pattern = ''
  private chomped = true
  private hold = ''
  private replaced = false
  private appendQueue: AppendItem[] = []

  constructor(program: SedProgram, opts: SedRunOptions) {
    this.program = program
    this.opts = opts
    this.files = opts.files
    this.noDefaultOutput = opts.suppress || program.noDefaultOutput
    this.rangeState = program.commands.map(() => RANGE_INACTIVE)
    this.a2Number = program.commands.map(() => 0)
    for (const name of program.wfiles) {
      if (name !== SED_STDOUT && name !== SED_STDERR) this.wfiles.set(name, new SedOutput())
    }
  }

  /** What the program wrote to /dev/stderr, then the error lines. */
  stderr(): string {
    return textView(this.specialErr.chunks.join('')) + this.stderrLines.join('')
  }

  /** The exit status GNU would end with after the runs so far. */
  exitCode(): number {
    if (this.panicCode !== null) return this.panicCode
    if (this.badCode !== 0) return this.badCode
    return (this.quitCode ?? 0) & 0xff
  }

  /** Whether a `q`, `Q` or panic ended the run: no further input is read. */
  stopped(): boolean {
    return this.quitCode !== null || this.panicCode !== null
  }

  /**
   * Run the program over `inputs` as one stream (or file by file with
   * `separate`), writing the main output to stdout or, when `toStdout` is
   * false, to a fresh stream whose text is returned (-i's per-file output).
   */
  process(inputs: SedInput[], toStdout: boolean): string {
    const out = toStdout ? this.stdout : new SedOutput()
    this.main = out
    this.inputs = inputs
    this.fileIdx = 0
    this.lines = []
    this.lineIdx = 0
    this.resetAtNextFile = true
    try {
      while (!this.stopped() && this.readPatternSpace(false)) {
        const status = this.executeProgram()
        if (status !== -1) this.quitCode = status
      }
    } catch (err) {
      if (!(err instanceof SedPanic)) throw err
      this.panicCode = err.code
      this.stderrLines.push(err.message)
    }
    return toStdout ? '' : out.chunks.join('')
  }

  private resetAddresses(): void {
    this.program.commands.forEach((cmd, i) => {
      this.rangeState[i] = cmd.a1?.kind === 'num' && cmd.a1.n === 0 ? RANGE_ACTIVE : RANGE_INACTIVE
    })
  }

  // Open the next operand; false when there is none.
  private openNextFile(): boolean {
    for (;;) {
      const next = this.inputs[this.fileIdx]
      if (next === undefined) return false
      this.fileIdx += 1
      this.fileName = next.name
      if ('error' in next) {
        if (next.fatal) throw new SedPanic(next.error)
        this.stderrLines.push(next.error)
        this.badCode = Math.max(this.badCode, next.code)
        this.lines = []
        this.lineIdx = 0
        continue
      }
      this.lines = splitLines(next.text)
      this.lineIdx = 0
      return true
    }
  }

  private readPatternSpace(append: boolean): boolean {
    if (this.appendQueue.length > 0) this.dumpAppendQueue()
    this.replaced = false
    while (this.lineIdx >= this.lines.length) {
      if (this.fileIdx >= this.inputs.length) return false
      if (this.resetAtNextFile) {
        this.lineNumber = 0
        this.hold = ''
        this.resetAddresses()
        for (const reader of this.readers.values()) if (reader !== null) reader.pos = 0
        this.resetAtNextFile = this.opts.separate
      }
      if (!this.openNextFile()) return false
    }
    const line = this.lines[this.lineIdx]
    this.lineIdx += 1
    if (line === undefined) return false
    this.pattern = append ? this.pattern + line.text : line.text
    this.chomped = line.chomped
    this.lineNumber += 1
    return true
  }

  // GNU's test_eof for `$`, `n` and `N`: this operand has no more lines
  // and, unless files are separate, neither has any later one. The later
  // operands are opened on the way, so their errors are reported now.
  private testEof(): boolean {
    if (this.lineIdx < this.lines.length) return false
    if (this.opts.separate) return true
    for (;;) {
      const next = this.inputs[this.fileIdx]
      if (next === undefined) return true
      if ('error' in next) {
        this.fileIdx += 1
        this.fileName = next.name
        if (!next.fatal) {
          this.stderrLines.push(next.error)
          this.badCode = Math.max(this.badCode, next.code)
        }
        continue
      }
      this.fileIdx += 1
      this.fileName = next.name
      this.lines = splitLines(next.text)
      this.lineIdx = 0
      if (this.lines.length > 0) return false
    }
  }

  private compiled(re: SedRegex | null, global: boolean): RegExp {
    const regex = re ?? this.lastRegex
    if (regex === null) {
      throw new SedPanic(`sed: ${this.program.endWhere}: no previous regular expression\n`, 1)
    }
    this.lastRegex = regex
    const cache = global ? this.globalCache : this.regexCache
    let hit = cache.get(regex)
    if (hit === undefined) {
      hit = compilePosixRegex(regex.source, sedRegexFlags(regex, global))
      cache.set(regex, hit)
    }
    return hit
  }

  private matchOne(addr: SedAddr, index: number): boolean {
    switch (addr.kind) {
      case 'null':
        return true
      case 'regex': {
        const re = this.compiled(addr.re, false)
        re.lastIndex = 0
        return re.test(this.pattern)
      }
      case 'mod':
        return this.lineNumber >= addr.first && (this.lineNumber - addr.first) % addr.step === 0
      case 'step':
      case 'stepmod':
        return (this.a2Number[index] ?? 0) <= this.lineNumber
      case 'last':
        return this.testEof()
      case 'num':
        return addr.n === this.lineNumber
    }
  }

  // GNU's match_address_p, range states and all.
  private matchAddress(cmd: SedCommand, index: number): boolean {
    const a1 = cmd.a1
    const a2 = cmd.a2
    if (a1 === null) return true
    if (this.rangeState[index] !== RANGE_ACTIVE) {
      if (a2 === null) return this.matchOne(a1, index)
      if (a1.kind === 'num') {
        if (this.rangeState[index] === RANGE_CLOSED || this.lineNumber < a1.n) return false
      } else if (!this.matchOne(a1, index)) return false
      this.rangeState[index] = RANGE_ACTIVE
      switch (a2.kind) {
        case 'regex':
          return true
        case 'num':
          if (this.lineNumber >= a2.n) this.rangeState[index] = RANGE_CLOSED
          return this.lineNumber <= a2.n || this.matchOne(a1, index)
        case 'step':
          this.a2Number[index] = this.lineNumber + a2.n
          return true
        case 'stepmod':
          this.a2Number[index] = this.lineNumber + a2.n - (this.lineNumber % a2.n)
          return true
        default:
          break
      }
    }
    if (a2 === null) return true
    if (a2.kind === 'num') {
      if (this.lineNumber >= a2.n) this.rangeState[index] = RANGE_CLOSED
      return this.lineNumber <= a2.n
    }
    if (this.matchOne(a2, index)) this.rangeState[index] = RANGE_CLOSED
    return true
  }

  /**
   * Replace what the `r` files hold. GNU opens an `r` file each time the
   * append queue is written, so under -i a file edited earlier in the
   * command reads with its new content; within one run nothing it reads
   * changes (a `w` file stays in its stdio buffer until sed exits).
   */
  setFiles(files: ReadonlyMap<string, SedFileContent>): void {
    this.files = files
  }

  private fileText(name: string): string {
    const content = this.files.get(name) ?? null
    if (content === null) return ''
    if ('error' in content) throw new SedPanic(content.error)
    return content.text
  }

  private dumpAppendQueue(): void {
    this.main.flushNewline()
    const queue = this.appendQueue
    this.appendQueue = []
    for (const item of queue) {
      if (item.text !== undefined) this.main.raw(item.text)
      if (item.rfile !== undefined) this.main.raw(this.fileText(item.rfile))
    }
  }

  private outputFor(name: string): SedOutput {
    if (name === SED_STDOUT) return this.specialOut
    if (name === SED_STDERR) return this.specialErr
    let out = this.wfiles.get(name)
    if (out === undefined) {
      out = new SedOutput()
      this.wfiles.set(name, out)
    }
    return out
  }

  private readLine(name: string): string | null {
    let reader = this.readers.get(name)
    if (reader === undefined) {
      const content = this.opts.readerFiles.get(name) ?? null
      if (content !== null && 'error' in content) throw new SedPanic(content.error)
      reader = content === null ? null : { lines: readerLines(content.text), pos: 0 }
      this.readers.set(name, reader)
    }
    if (reader === null) return null
    const line = reader.lines[reader.pos]
    if (line === undefined) return null
    reader.pos += 1
    return line
  }

  private substitute(cmd: SedCommand): void {
    const sub = cmd.subst
    if (sub === undefined) return
    const scan = this.compiled(sub.re, true)
    const count = sub.numb === 0 ? 1 : sub.numb
    let n = 0
    let lastEnd = -1
    const state = { done: false }
    scan.lastIndex = 0
    const result = this.pattern.replace(scan, (m: string, ...rest: unknown[]) => {
      const offsetIndex = rest.findIndex((arg) => typeof arg === 'number')
      const at = rest[offsetIndex] as number
      if (m === '' && at === lastEnd) return ''
      if (m !== '') lastEnd = at + m.length
      n += 1
      const hit = sub.global ? n >= count : n === count
      if (!hit) return m
      state.done = true
      const groups = rest
        .slice(0, offsetIndex)
        .map((value) => (typeof value === 'string' ? value : undefined))
      return applyReplacement(sub.replacement, [m, ...groups])
    })
    if (!state.done) return
    this.replaced = true
    this.pattern = result
    if (sub.print) this.main.line(this.pattern, this.chomped)
    if (sub.outf !== null) this.outputFor(sub.outf).line(this.pattern, this.chomped)
  }

  private transliterate(cmd: SedCommand): void {
    const src = cmd.ySrc ?? []
    const dst = cmd.yDst ?? []
    let out = ''
    for (const ch of this.pattern) {
      const idx = src.indexOf(ch)
      out += idx >= 0 ? (dst[idx] ?? ch) : ch
    }
    this.pattern = out
  }

  // One cycle of the script; -1 to go on to the next line, or the exit
  // status `q` or `Q` stops with.
  private executeProgram(): number {
    const commands = this.program.commands
    let pc = 0
    while (pc < commands.length) {
      const cmd = commands[pc]
      if (cmd === undefined) break
      if (this.matchAddress(cmd, pc) !== cmd.bang) {
        switch (cmd.cmd) {
          case 'a':
            if (cmd.text !== null && cmd.text !== undefined)
              this.appendQueue.push({ text: cmd.text })
            break
          case '{':
          case 'b':
            pc = cmd.jump ?? commands.length
            continue
          case '}':
          case ':':
            break
          case 'c':
            if (
              this.rangeState[pc] !== RANGE_ACTIVE &&
              cmd.text !== null &&
              cmd.text !== undefined
            ) {
              this.main.line(cmd.text.slice(0, -1), true)
            }
            return -1
          case 'd':
            return -1
          case 'D': {
            const nl = this.pattern.indexOf('\n')
            if (nl < 0) return -1
            this.pattern = this.pattern.slice(nl + 1)
            pc = 0
            continue
          }
          case 'g':
            this.pattern = this.hold
            break
          case 'G':
            this.pattern += '\n' + this.hold
            break
          case 'h':
            this.hold = this.pattern
            break
          case 'H':
            this.hold += '\n' + this.pattern
            break
          case 'i':
            if (cmd.text !== null && cmd.text !== undefined)
              this.main.line(cmd.text.slice(0, -1), true)
            break
          case 'l': {
            const width =
              cmd.intArg === undefined || cmd.intArg === -1 ? this.opts.lineLength : cmd.intArg
            this.main.flushNewline()
            this.main.raw(listLine(this.pattern, width))
            break
          }
          case 'L':
            // GNU 4.9 still compiles the removed `L` and then has no case
            // for it: an internal error the moment it runs.
            throw new SedPanic('sed: INTERNAL ERROR: Bad cmd L\n')
          case 'n':
            if (!this.noDefaultOutput) this.main.line(this.pattern, this.chomped)
            if (this.testEof() || !this.readPatternSpace(false)) return -1
            break
          case 'N':
            this.pattern += '\n'
            if (this.testEof() || !this.readPatternSpace(true)) {
              this.pattern = this.pattern.slice(0, -1)
              if (!this.noDefaultOutput) this.main.line(this.pattern, this.chomped)
              return -1
            }
            break
          case 'p':
            this.main.line(this.pattern, this.chomped)
            break
          case 'P': {
            const nl = this.pattern.indexOf('\n')
            if (nl >= 0) this.main.line(this.pattern.slice(0, nl), true)
            else this.main.line(this.pattern, this.chomped)
            break
          }
          case 'q':
            if (!this.noDefaultOutput) this.main.line(this.pattern, this.chomped)
            this.dumpAppendQueue()
            return cmd.intArg === undefined || cmd.intArg === -1 ? 0 : cmd.intArg
          case 'Q':
            return cmd.intArg === undefined || cmd.intArg === -1 ? 0 : cmd.intArg
          case 'r':
            if (cmd.fname !== undefined) {
              if (cmd.prepend === true) {
                this.main.flushNewline()
                this.main.raw(this.fileText(cmd.fname))
              } else this.appendQueue.push({ rfile: cmd.fname })
            }
            break
          case 'R': {
            const text = cmd.fname === undefined ? null : this.readLine(cmd.fname)
            if (text !== null) this.appendQueue.push({ text })
            break
          }
          case 's':
            this.substitute(cmd)
            break
          case 't':
            if (this.replaced) {
              this.replaced = false
              pc = cmd.jump ?? commands.length
              continue
            }
            break
          case 'T':
            if (!this.replaced) {
              pc = cmd.jump ?? commands.length
              continue
            }
            this.replaced = false
            break
          case 'w':
            if (cmd.fname !== undefined) this.outputFor(cmd.fname).line(this.pattern, this.chomped)
            break
          case 'W':
            if (cmd.fname !== undefined) {
              const nl = this.pattern.indexOf('\n')
              const out = this.outputFor(cmd.fname)
              if (nl >= 0) out.line(this.pattern.slice(0, nl), true)
              else out.line(this.pattern, this.chomped)
            }
            break
          case 'x': {
            const tmp = this.pattern
            this.pattern = this.hold
            this.hold = tmp
            break
          }
          case 'y':
            this.transliterate(cmd)
            break
          case 'z':
            this.pattern = ''
            break
          case '=':
            this.main.flushNewline()
            this.main.raw(`${String(this.lineNumber)}\n`)
            break
          case 'F':
            this.main.flushNewline()
            this.main.raw(byteView(`${this.fileName}\n`))
            break
          default:
            break
        }
      }
      pc += 1
    }
    if (!this.noDefaultOutput) this.main.line(this.pattern, this.chomped)
    return -1
  }
}

/** Expand against the original captures, preserving boundary context and case. */
// `text` with its ASCII letters mapped, as the C locale maps them.
function caseMapped(text: string, upper: boolean): string {
  return upper
    ? text.replace(/[a-z]+/g, (run) => run.toUpperCase())
    : text.replace(/[A-Z]+/g, (run) => run.toLowerCase())
}

/**
 * Expand a GNU sed replacement against a match: `&` is the whole match,
 * `\1`..`\9` are groups, `\n`/`\t` are newline/tab and `\X` is a literal
 * X. `\U` and `\L` map everything after them to upper or lower case until
 * `\E` or the other one; `\u` and `\l` map only the next character. A
 * one-shot escape a case escape follows is dropped, and of two one-shots
 * the later wins. One that lands on an empty group passes to whatever comes
 * next (GNU sed 4.9's `append_replacement`). The C locale maps ASCII letters
 * only, so a byte above 0x7f is written as it is; GNU 4.9 writes 0xff for
 * it, which is not copied. Mirrors Python's `_apply_repl`.
 */
function applyReplacement(repl: string, groups: readonly (string | undefined)[]): string {
  let out = ''
  let sticky: boolean | null = null
  let pending: boolean | null = null
  let carried: boolean | null = null
  const emit = (piece: string, group = false): void => {
    const first = pending ?? carried
    const own = pending !== null
    pending = carried = null
    if (piece === '') {
      if (group && own) carried = first
      return
    }
    if (first !== null) {
      out += caseMapped(piece.charAt(0), first)
      piece = piece.slice(1)
    }
    out += sticky === null ? piece : caseMapped(piece, sticky)
  }
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i] ?? ''
    if (ch === '&') emit(groups[0] ?? '', true)
    else if (ch === '\\' && i + 1 < repl.length) {
      const next = repl[++i] ?? ''
      if (/[0-9]/.test(next)) emit(groups[Number(next)] ?? '', true)
      else if (next === 'U' || next === 'L' || next === 'E') {
        sticky = next === 'E' ? null : next === 'U'
        pending = null
      } else if (next === 'u' || next === 'l') pending = next === 'u'
      else if (next === 'n') emit('\n')
      else if (next === 't') emit('\t')
      else emit(next)
    } else emit(ch)
  }
  return out
}

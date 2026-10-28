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

import { mergeSignals } from '../../../../utils/abort.ts'
import { chunks } from '../../../../io/cooperative.ts'
import { PipeConsole } from '../../../../shell/console/pipe.ts'
import { Channel } from '../../../../shell/console/types.ts'
import { pump } from '../../jobs.ts'
import { PipeClosed } from '../../../../io/errors.ts'
import { boundedMapStream } from '../../../../concurrency/limiter.ts'
import type { EvaluationContext } from '../../../evaluation.ts'

import { versionLine } from '../../../../commands/spec/standard.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { runAsProgram, runWithEvaluation } from '../../../../context/session_context.ts'
import { renderHelp } from '../../../../commands/spec/help.ts'
import { SHELL_SPECS, parseShellOptions } from '../../../../commands/spec/shell.ts'
import {
  ambiguousOptionError,
  missingValueError,
  unexpectedValueError,
  unknownOptionError,
  usageHint,
} from '../../../../commands/spec/usage.ts'
import { IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { SharedStdin, yieldBytes } from '../../../../io/stream.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { shellJoin } from '../../../../shell/join.ts'
import { asyncContextIsolatesTasks } from '../../../../utils/async_context.ts'
import { fsStrerror, enoent } from '../../../../errors/fs.ts'
import { shellQuote } from '../../../../utils/quote.ts'
import { execs } from '../../../lookup/lookup.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { varsFromEnv } from '../../../session/session.ts'

import { envSnapshot } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { readScriptBytes } from '../script/script.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import { concat, findBytes } from '../../../../utils/bytes.ts'
import { NOT_FOUND_STATUS, SIGPIPE_STATUS, TIMEOUT_STATUS } from '../../../../shell/constants.ts'

const SYNOPSIS = 'xargs [OPTION]... COMMAND [INITIAL-ARGS]...'

// The sizes GNU findutils 4.10 reports with --show-limits on Linux with an
// 8 MiB stack: exec takes 2 MiB of arguments and environment, 2 KiB of
// which xargs leaves unused, and a command line holds 128 KiB unless -s
// says otherwise. -P takes at most a C int.
const EXEC_BYTES = 2097152
const UNUSED_BYTES = 2048
const POSIX_FLOOR = 4096
const STANDARD_WIDTH = 131072
const MOST_JOBS = 2147483647

const INTEGER = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/
// The bytes that end a run the quoting reader copies as it is: outside
// quotes, inside a whole -I line once it has begun, and inside each quote.
const WORD_RUN: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x27, 0x22, 0x5c, 0x00])
const LINE_RUN: ReadonlySet<number> = new Set([0x0a, 0x27, 0x22, 0x5c, 0x00])
const QUOTED_RUN: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [0x27, new Set([0x27, 0x0a, 0x00])],
  [0x22, new Set([0x22, 0x0a, 0x00])],
])
const QUOTE_WORDS: ReadonlyMap<number, string> = new Map([
  [0x27, 'single'],
  [0x22, 'double'],
])
// Vertical tab, form feed and carriage return are skipped before a word but
// kept inside one (GNU 4.10: `\ra \vb\r` gives `a` and `b\r`), and skipping
// one leaves a line's last blank as it was for -L.
const SKIPPED_BEFORE_WORD: ReadonlySet<number> = new Set([0x0b, 0x0c, 0x0d])
const LETTER_ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x61, 0x07],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
  [0x76, 0x0b],
  [0x5c, 0x5c],
])
const HEX_DIGITS = /^[0-9a-fA-F]*/
const OCTAL_DIGITS = /^[0-7]*/

const NUL_IN_INPUT =
  'xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n'
const NO_TTY = 'xargs: failed to open /dev/tty for reading: No such device or address\n'
const LINE_TOO_LONG = 'xargs: argument line too long\n'
const LIST_TOO_LONG = 'xargs: argument list too long\n'
const NO_ROOM = 'xargs: cannot fit single argument within argument list size limit\n'
const TEMPLATE_TOO_LONG = 'xargs: command too long\n'
const CROWDED = 'xargs: environment is too large for exec\n'
// What a previous -I, -L or -n is called when a later one cancels it.
const CANCELLED: Readonly<Record<Grouping, string>> = Object.freeze({
  template: '--replace',
  lines: '--max-lines',
  group: '--max-args',
})

type Grouping = 'template' | 'lines' | 'group'
type XargsEvent = string | Uint8Array[]

/** An option xargs will not run with, refused before any input is read. */
class Refusal extends Error {
  constructor(
    readonly text: string,
    readonly code = 1,
  ) {
    super(text)
  }
}

function refusal(stderr: string | Uint8Array, code = 1): Result {
  const data = typeof stderr === 'string' ? encodeText(stderr) : stderr
  return [
    null,
    new IOResult({ stderr: data, exitCode: code }),
    new ExecutionNode({ command: 'xargs', exitCode: code }),
  ]
}

function answer(option: string, notes: string): Result {
  // --help and --version answer where they stand, after the warnings of
  // the options before them.
  const text =
    option === 'help'
      ? renderHelp('xargs', SHELL_SPECS.xargs, [], undefined, SYNOPSIS)
      : versionLine('xargs')
  return [
    yieldBytes(encodeText(text)),
    new IOResult(notes === '' ? {} : { stderr: encodeText(notes) }),
    new ExecutionNode({ command: 'xargs', exitCode: 0 }),
  ]
}

function conflict(option: string, previous: string): string {
  return `xargs: warning: options ${previous} and ${option} are mutually exclusive, ignoring previous ${previous} value\n`
}

/**
 * Read a count option as GNU does: blanks may lead, nothing may trail. A
 * null ceiling has no bound, so GNU 4.10 runs `-n 99999999999999999999`.
 */
function wholeNumber(
  raw: string,
  letter: string,
  floor: number,
  ceiling: number | null = null,
): number {
  const hint = usageHint('xargs')
  if (!INTEGER.test(raw)) {
    throw new Refusal(`xargs: invalid number "${raw}" for -${letter} option\n${hint}\n`)
  }
  const value = Number(raw.trim())
  if (value < floor) {
    throw new Refusal(
      `xargs: value ${raw} for -${letter} option should be >= ${String(floor)}\n${hint}\n`,
    )
  }
  if (ceiling !== null && value > ceiling) {
    throw new Refusal(
      `xargs: value ${raw} for -${letter} option should be <= ${String(ceiling)}\n${hint}\n`,
    )
  }
  return value
}

/**
 * The byte -d names: one character, or a backslash escape.
 *
 * A letter escape ignores what follows it (GNU 4.10 takes `\nX` as
 * newline); a numeric one (`\x41`, `\101`) reads every digit of its base, so
 * `\x411` is out of range and `\x41z` has a tail.
 */
function separator(spec: string): number {
  const raw = encodeText(spec)
  if (raw.length === 1) return raw[0] ?? 0
  if (raw[0] !== 0x5c) {
    throw new Refusal(
      `xargs: Invalid input delimiter specification ${spec}: the delimiter must be either a single character or an escape sequence starting with \\.\n`,
    )
  }
  const lead = raw[1] ?? 0
  const letter = LETTER_ESCAPES.get(lead)
  if (letter !== undefined) return letter
  let digits: RegExp
  let body: string
  let top: [string, number]
  if (lead === 0x78) {
    digits = HEX_DIGITS
    body = decodeText(raw.subarray(2))
    top = ['ff', 16]
  } else if (lead >= 0x30 && lead <= 0x39) {
    digits = OCTAL_DIGITS
    body = decodeText(raw.subarray(1))
    top = ['377', 8]
  } else {
    throw new Refusal(`xargs: Invalid escape sequence ${spec} in input delimiter specification.\n`)
  }
  const width = (digits.exec(body)?.[0] ?? '').length
  const value = width > 0 ? parseInt(body.slice(0, width), top[1]) : 0
  if (value > 0xff) {
    throw new Refusal(
      `xargs: Invalid escape sequence ${spec} in input delimiter specification; character values must not exceed ${top[0]}.\n`,
    )
  }
  if (width < body.length) {
    throw new Refusal(
      `xargs: Invalid escape sequence ${spec} in input delimiter specification; trailing characters ${body.slice(width)} not recognised.\n`,
    )
  }
  return value
}

function limitsReport(environment: number, room: number, width: number): string {
  return (
    `Your environment variables take up ${String(environment)} bytes\n` +
    `POSIX upper limit on argument length (this system): ${String(room)}\n` +
    `POSIX smallest allowable upper limit on argument length (all systems): ${String(POSIX_FLOOR)}\n` +
    `Maximum length of command we could actually use: ${String(room - environment)}\n` +
    `Size of command buffer we are actually using: ${String(width)}\n` +
    `Maximum parallelism (--max-procs must be no greater): ${String(MOST_JOBS)}\n`
  )
}

function ttyAbort(name: Uint8Array): string {
  // GNU 4.10 without a terminal: the child cannot reopen /dev/tty and dies
  // of SIGABRT, which xargs reports as 125.
  return (
    "xargs: '/dev/tty': No such device or address\n" +
    "xargs: xargs.c:1648: wait_for_proc_all: Assertion `getpid () == parent' failed.\n" +
    `xargs: ${decode(name)}: terminated by signal 6\n`
  )
}

function unclosed(mark: number): string {
  return `xargs: unmatched ${QUOTE_WORDS.get(mark) ?? ''} quote; by default quotes are special to xargs unless you use the -0 option\n`
}

function beforeNul(word: Uint8Array): Uint8Array {
  // An argument is a C string: a NUL ends it, though every byte read still
  // counts against -s (GNU 4.10: `a\0bbbbbbbbbbbb` needs 15).
  const cut = word.indexOf(0)
  return cut < 0 ? word : word.subarray(0, cut)
}

/**
 * What the options asked for, in the order they were given.
 *
 * -I (`template`), -L/-l (`lines`) and -n (`group`) exclude one another: the
 * last one given holds, with a warning for the one it cancels, except that
 * `-n 1` after -I is ignored silently. `room` is what -s may reach once the
 * environment is counted; `crowded` says the environment alone leaves none.
 */
class Plan {
  notes = ''
  width = 0
  separator: number | null = null
  endWord: string | null = null
  template: string | null = null
  lines = 0
  group = 0
  jobs = 1
  source = '-'
  slotVar: string | null = null
  readonly flags = new Set<string>()

  constructor(
    readonly room: number,
    readonly crowded: boolean,
  ) {}

  active(): Grouping | null {
    if (this.template !== null) return 'template'
    if (this.lines > 0) return 'lines'
    return this.group > 0 ? 'group' : null
  }

  warnOver(option: string, ...kinds: Grouping[]): void {
    const held = this.active()
    if (held !== null && kinds.includes(held)) this.notes += conflict(option, CANCELLED[held])
  }

  take(name: string, value: string | null): void {
    if (name === '0') {
      this.separator = 0
    } else if (name === 'd' && value !== null) {
      this.separator = separator(value)
    } else if (name === 'E' || name === 'e') {
      this.endWord = value === null || value === '' ? null : value
    } else if (['t', 'p', 'x', 'o', 'r', 'show-limits'].includes(name)) {
      this.flags.add(name)
    } else if (name === 'a' && value !== null) {
      this.source = value
    } else if (name === 'process-slot-var' && value !== null) {
      this.takeSlotVar(value)
    } else if (name === 's' && value !== null) {
      this.takeWidth(value)
    } else if (name === 'I' || name === 'i') {
      this.warnOver('--replace/-I/-i', 'group', 'lines')
      this.template = value ?? '{}'
      this.lines = 0
      this.group = 0
    } else if (name === 'L' || name === 'l') {
      const count = wholeNumber(value ?? '1', name, 1)
      this.warnOver(name === 'L' ? '-L' : '--max-lines/-l', 'group', 'template')
      this.template = null
      this.lines = count
      this.group = 0
    } else if (name === 'n' && value !== null) {
      this.takeGroup(wholeNumber(value, 'n', 1))
    } else if (name === 'P' && value !== null) {
      this.jobs = wholeNumber(value, 'P', 0, MOST_JOBS)
    }
  }

  takeGroup(count: number): void {
    // GNU reads `-I {} -n1` as plain -I.
    if (this.active() === 'template' && count === 1) return
    this.warnOver('--max-args/-n', 'lines', 'template')
    this.template = null
    this.lines = 0
    this.group = count
  }

  takeWidth(value: string): void {
    if (this.crowded) throw new Refusal(CROWDED)
    if (!INTEGER.test(value)) {
      throw new Refusal(`xargs: invalid number "${value}" for -s option\n${usageHint('xargs')}\n`)
    }
    let width = Number(value.trim())
    if (width < 1) {
      this.notes += `xargs: value ${value} for -s option should be >= 1\n`
      width = 1
    } else if (width > this.room) {
      this.notes += `xargs: value ${value} for -s option should be <= ${String(this.room)}\n`
      width = this.room
    }
    this.width = width
  }

  takeSlotVar(value: string): void {
    if (value.includes('=')) {
      throw new Refusal(
        "xargs: option --process-slot-var may not be set to a value which includes `='\n",
      )
    }
    if (value === '') {
      throw new Refusal('xargs: failed to unset environment variable : Invalid argument\n')
    }
    this.slotVar = value
  }
}

/**
 * Where the reader's words go: commands to run and messages to print, in
 * order, and the error that ended the run. `base` is the command name and
 * its initial arguments, `width` the -s limit in bytes with a NUL counted
 * per word; -p asks first and -o reopens the terminal, and there is no
 * terminal, so the first command fails each way.
 */
abstract class Collector {
  out: XargsEvent[] = []
  failure: [string, number] | null = null
  protected ended = false
  private waiting = false
  protected readonly ask: boolean
  protected readonly reopen: boolean
  protected readonly traced: boolean

  constructor(
    protected readonly base: Uint8Array[],
    protected readonly width: number,
    protected readonly flags: ReadonlySet<string>,
  ) {
    this.ask = flags.has('p')
    this.reopen = flags.has('o')
    this.traced = flags.has('t')
  }

  halted(): boolean {
    return this.ended
  }

  holding(): boolean {
    // A built command waits to be run: the reader pauses until it has been
    // handed on, so one is held at a time.
    return this.waiting
  }

  drain(): XargsEvent[] {
    const ready = this.out
    this.out = []
    this.waiting = false
    return ready
  }

  note(text: string): void {
    this.out.push(text)
  }

  stop(text: string, code = 1): void {
    this.failure ??= [text, code]
    this.ended = true
  }

  ship(line: Uint8Array[]): void {
    if (this.ask) {
      // GNU shows the line it would prompt for, then cannot read the answer.
      this.stop(trace(line).slice(0, -1) + NO_TTY)
    } else if (this.reopen) {
      const shown = this.traced ? trace(line) : ''
      this.stop(shown + ttyAbort(line[0] ?? new Uint8Array()), 125)
    } else {
      this.out.push(line)
      this.waiting = true
    }
  }

  begin(): void {
    // Most collectors check nothing before the input.
  }

  /**
   * The most bytes one word may hold; a longer one is `argument line too
   * long`, which GNU 4.10 reports at the first byte past it, reading no
   * further (with `echo` it stops 131067 bytes into a longer word).
   */
  abstract wordRoom(): number

  abstract word(word: Uint8Array): void

  lineDone(): void {
    // Only -L counts lines.
  }

  fail(text: string): void {
    this.stop(text)
  }

  close(): void {
    this.ended = true
  }
}

/**
 * Packs words after the initial arguments, as many as -s, -n and -L allow.
 *
 * With -x, or -L, a command may not be cut short: a word that does not fit
 * is `argument list too long` (with -x only when -n asks for a count), and
 * an error drops the words gathered so far, which otherwise run before
 * xargs stops. A word too long for any command line is `argument line too
 * long`. Without -r, input with no words still runs the command once.
 */
class Packer extends Collector {
  private readonly strict: boolean
  private readonly whole: boolean
  private readonly runEmpty: boolean
  private readonly fixed: number
  private held: Uint8Array[] = []
  private heldBytes = 0
  private linesHeld = 0
  private shipped = false

  constructor(
    base: Uint8Array[],
    width: number,
    flags: ReadonlySet<string>,
    private readonly group: number,
    private readonly lines: number,
    private readonly mostWords: number,
  ) {
    super(base, width, flags)
    this.strict = flags.has('x')
    this.whole = this.strict || lines > 0
    this.runEmpty = !flags.has('r')
    this.fixed = base.reduce((sum, word) => sum + word.length + 1, 0)
  }

  override begin(): void {
    if (this.fixed > this.width) this.stop(NO_ROOM)
  }

  flush(): void {
    const line = [...this.base, ...this.held.map(beforeNul)]
    this.held = []
    this.heldBytes = 0
    this.linesHeld = 0
    this.shipped = true
    this.ship(line)
  }

  override wordRoom(): number {
    return this.width - this.fixed - 1
  }

  override word(word: Uint8Array): void {
    const size = word.length + 1
    if (word.length > this.wordRoom()) {
      // A word with bytes is stopped while it is read; only an empty one
      // gets here, when -s leaves no room after the command.
      this.fail(word.length > 0 ? LINE_TOO_LONG : NO_ROOM)
      return
    }
    if (
      this.held.length > 0 &&
      (this.fixed + this.heldBytes + size > this.width ||
        this.base.length + this.held.length >= this.mostWords)
    ) {
      if (this.lines > 0 || (this.strict && this.group > 0)) {
        this.stop(LIST_TOO_LONG)
        return
      }
      this.flush()
      if (this.halted()) return
    }
    this.held.push(word)
    this.heldBytes += size
    if (this.group > 0 && this.held.length === this.group) this.flush()
  }

  override lineDone(): void {
    if (this.lines > 0 && this.held.length > 0) {
      this.linesHeld += 1
      if (this.linesHeld === this.lines) this.flush()
    }
  }

  override fail(text: string): void {
    if (this.held.length > 0 && !this.whole) this.flush()
    this.stop(text)
  }

  override close(): void {
    if (this.held.length > 0 || (this.runEmpty && !this.shipped)) this.flush()
    this.ended = true
  }
}

/**
 * Runs the command once per -I line, the line put in place of every
 * occurrence of the string in each initial argument (not the name).
 *
 * Measured on GNU 4.10: the first line must fit -s on its own and every
 * later one beside the command name, else `argument line too long`; the
 * name must fit (`cannot fit single argument`); an argument whose filled-in
 * text, with two bytes more, exceeds -s is `command too long`, as is any
 * initial argument when the string is empty; and the whole line must fit,
 * else `argument list too long`.
 */
class Filler extends Collector {
  private later = false

  constructor(
    base: Uint8Array[],
    width: number,
    flags: ReadonlySet<string>,
    private readonly template: Uint8Array,
  ) {
    super(base, width, flags)
  }

  override wordRoom(): number {
    const taken = this.later ? (this.base[0]?.length ?? 0) + 1 : 0
    return this.width - taken - 1
  }

  override word(word: Uint8Array): void {
    const name = this.base[0] ?? new Uint8Array()
    // The limit is met while bytes arrive, so an empty line passes (GNU 4.10
    // runs `-I{} -s 5 echo` on a later empty line).
    if (word.length > 0 && word.length > this.wordRoom()) {
      this.stop(LINE_TOO_LONG)
      return
    }
    this.later = true
    if (name.length + 1 > this.width) {
      this.stop(NO_ROOM)
      return
    }
    let used = name.length + 1
    const line = [name]
    for (const part of this.base.slice(1)) {
      if (this.template.length === 0) {
        this.stop(TEMPLATE_TOO_LONG)
        return
      }
      // The filled-in size is counted before the text is built, so a long
      // line in a long template costs no more than -s.
      const size = part.length + this.occurrences(part) * (word.length - this.template.length)
      if (size + 2 > this.width) {
        this.stop(TEMPLATE_TOO_LONG)
        return
      }
      used += size + 1
      if (used > this.width) {
        this.stop(LIST_TOO_LONG)
        return
      }
      line.push(beforeNul(this.fill(part, word)))
    }
    this.ship(line)
  }

  occurrences(part: Uint8Array): number {
    let found = 0
    let from = 0
    for (;;) {
      const at = findBytes(part, this.template, from)
      if (at < 0) return found
      found += 1
      from = at + this.template.length
    }
  }

  fill(part: Uint8Array, word: Uint8Array): Uint8Array {
    // Each occurrence, left to right, never overlapping: GNU 4.10 turns
    // `aaa` into `Za` for `-I aa`.
    const pieces: Uint8Array[] = []
    let from = 0
    for (;;) {
      const at = findBytes(part, this.template, from)
      if (at < 0) break
      pieces.push(part.subarray(from, at), word)
      from = at + this.template.length
    }
    if (pieces.length === 0) return part
    pieces.push(part.subarray(from))
    return concat(pieces)
  }
}

/**
 * Splits input into words the way xargs does without -0 or -d.
 *
 * Blanks and newlines separate words; '...' and "..." keep blanks and take
 * no escapes; a backslash outside them takes the next byte as it is, a
 * newline included. A newline inside quotes is an unmatched quote; so is the
 * end of input inside them, but only once the word holds a byte: GNU 4.10
 * runs nothing and exits 0 on a lone `'`. A word cut off by the end of input
 * is dropped when it holds no byte.
 *
 * A line that ends in a blank goes on into the next one, which -L counts
 * with it, and so does a line with no word on it (GNU 4.10 runs `a b` once
 * for `a <newline><newline>b` with -L1). The -E word ends the input wherever
 * a blank or newline closes it, but cut off by the end of input only as the
 * first word of its line (GNU 4.10 stops at `a<newline>STOP` and passes
 * `a STOP` on). With -I a whole line is one word: blanks inside it stay,
 * leading ones go.
 */
class QuotedReader {
  private word: number[] = []
  private begun = false
  private quote: number | null = null
  private escaped = false
  private previous = -1
  private lineOpen = false
  private wordOnLine = false
  private warned = false

  constructor(
    private readonly sink: Collector,
    private readonly endWord: Uint8Array | null,
    private readonly wholeLines: boolean,
  ) {}

  keep(byte: number): void {
    if (byte === 0 && !this.warned) {
      this.warned = true
      this.sink.note(NUL_IN_INPUT)
    }
    this.word.push(byte)
    this.begun = true
    this.checkRoom()
  }

  checkRoom(): void {
    if (this.word.length > this.sink.wordRoom()) this.sink.fail(LINE_TOO_LONG)
  }

  /**
   * Reads from `at` until the data runs out, xargs stops, or a command is
   * built; returns where it stopped.
   */
  feed(data: Uint8Array, at = 0): number {
    const sink = this.sink
    while (at < data.length && !sink.halted() && !sink.holding()) {
      const next = data[at] ?? 0
      if (this.escaped) {
        this.escaped = false
        this.previous = next
        this.keep(next)
        at += 1
        continue
      }
      const closing = this.quote === null ? undefined : QUOTED_RUN.get(this.quote)
      if (this.quote !== null && closing !== undefined) {
        const after = this.copyRun(data, at, closing)
        if (after > at) {
          at = after
          continue
        }
        const byte = data[at] ?? 0
        at += 1
        this.previous = byte
        if (byte === this.quote) this.quote = null
        else if (byte === 0x0a) sink.fail(unclosed(this.quote))
        else this.keep(byte)
        continue
      }
      if (!this.begun && SKIPPED_BEFORE_WORD.has(next)) {
        at += 1
        continue
      }
      const after = this.copyRun(data, at, this.wholeLines && this.begun ? LINE_RUN : WORD_RUN)
      if (after > at) {
        this.begun = true
        at = after
        continue
      }
      const byte = data[at] ?? 0
      at += 1
      if (byte === 0x5c) {
        this.escaped = true
      } else if (byte === 0x27 || byte === 0x22) {
        this.quote = byte
        this.begun = true
      } else if (byte === 0x0a) {
        const carried = !this.wholeLines && (this.previous === 0x20 || this.previous === 0x09)
        if (this.begun) this.finishWord(false)
        const ends = !carried && this.wordOnLine
        this.wordOnLine = false
        if (ends && !sink.halted()) {
          this.lineOpen = false
          sink.lineDone()
        }
      } else if (byte === 0x20 || byte === 0x09) {
        if (this.begun && !this.wholeLines) this.finishWord(false)
      } else {
        this.keep(byte)
      }
      this.previous = byte
    }
    return at
  }

  copyRun(data: Uint8Array, at: number, run: ReadonlySet<number>): number {
    // Copies the bytes from `at` that need no decision, but no more than one
    // past what the word may hold; returns where the next one starts.
    const last = Math.min(
      data.length,
      at + Math.max(1, this.sink.wordRoom() - this.word.length + 1),
    )
    let end = at
    while (end < last && !run.has(data[end] ?? 0)) end += 1
    if (end === at) return at
    for (let index = at; index < end; index += 1) this.word.push(data[index] ?? 0)
    this.previous = data[end - 1] ?? 0
    this.checkRoom()
    return end
  }

  finishWord(cutOff: boolean): void {
    const word = Uint8Array.from(this.word)
    this.word = []
    this.begun = false
    const endWord = this.endWord
    if (endWord !== null && !(cutOff && this.lineOpen)) {
      const text = beforeNul(word)
      if (text.length === endWord.length && text.every((byte, index) => byte === endWord[index])) {
        this.sink.close()
        return
      }
    }
    this.lineOpen = true
    this.wordOnLine = true
    this.sink.word(word)
  }

  /**
   * Finishes the input; false when it paused with a command built from the
   * last word, to be called again once that has been run.
   */
  end(): boolean {
    const sink = this.sink
    if (sink.halted()) return true
    if (this.word.length > 0) {
      if (this.quote !== null) {
        sink.fail(unclosed(this.quote))
        return true
      }
      this.finishWord(true)
      if (sink.holding() && !sink.halted()) return false
    }
    if (!sink.halted()) sink.close()
    return true
  }
}

/**
 * Splits input at one byte (-0, -d): every piece is a word as it stands, an
 * empty one included, and counts as a line for -L; a last piece with no
 * separator after it is a word too when it holds a byte.
 */
class SplitReader {
  private piece: Uint8Array[] = []
  private pieceBytes = 0

  constructor(
    private readonly sink: Collector,
    private readonly separator: number,
  ) {}

  /**
   * Reads from `at` until the data runs out, xargs stops, or a command is
   * built; returns where it stopped.
   */
  feed(data: Uint8Array, at = 0): number {
    while (!this.sink.halted() && !this.sink.holding()) {
      const cut = data.indexOf(this.separator, at)
      if (!this.take(data, at, cut < 0 ? data.length : cut)) return data.length
      if (cut < 0) return data.length
      at = cut + 1
      this.handOver()
    }
    return at
  }

  take(data: Uint8Array, start: number, stop: number): boolean {
    // Copies no more than one byte past what the word may hold, so an item
    // that never ends stops at the limit.
    const room = this.sink.wordRoom()
    const part = data.slice(start, Math.min(stop, start + Math.max(1, room - this.pieceBytes + 1)))
    if (part.length > 0) {
      this.piece.push(part)
      this.pieceBytes += part.length
    }
    if (this.pieceBytes > 0 && this.pieceBytes > room) {
      this.sink.fail(LINE_TOO_LONG)
      return false
    }
    return true
  }

  handOver(): void {
    const word = concat(this.piece)
    this.piece = []
    this.pieceBytes = 0
    this.sink.word(word)
    if (!this.sink.halted()) this.sink.lineDone()
  }

  /**
   * Finishes the input; false when it paused with a command built from the
   * last piece, to be called again once that has been run.
   */
  end(): boolean {
    if (this.pieceBytes > 0 && !this.sink.halted()) {
      this.handOver()
      if (this.sink.holding() && !this.sink.halted()) return false
    }
    if (!this.sink.halted()) this.sink.close()
    return true
  }
}

function assemble(
  plan: Plan,
  base: Uint8Array[],
  room: number,
): [Collector, QuotedReader | SplitReader] {
  const sink =
    plan.template !== null
      ? new Filler(base, plan.width, plan.flags, encodeText(plan.template))
      : new Packer(
          base,
          plan.width,
          plan.flags,
          plan.group,
          plan.lines,
          // GNU 4.10 tries at most room / 8 - 2 words in one line (with -s
          // 2095097 and 300000 empty -0 items it tries 261885, then halves
          // what exec refuses; that retry is not modelled).
          Math.floor(room / 8) - 2,
        )
  if (plan.separator !== null) return [sink, new SplitReader(sink, plan.separator)]
  const endWord = plan.endWord !== null ? encodeText(plan.endWord) : null
  return [sink, new QuotedReader(sink, endWord, plan.template !== null)]
}

function decode(word: Uint8Array): string {
  return decodeText(word)
}

function trace(line: readonly Uint8Array[]): string {
  return `${line.map((word) => shellQuote(decode(word))).join(' ')}\n`
}

/** GNU's report of a command xargs finds nothing to run for. */
export function xargsMissing(name: string): string {
  return `xargs: ${name}: No such file or directory\n`
}

interface RunOptions {
  trace?: boolean
  slotVar?: string | null
  registry?: MountRegistry | null
  stdin?: ByteSource | null
  /** Filled at teardown with the runs still going, for the caller to record. */
  torn: IOResult[]
}

/**
 * Run one command into its pipe, keeping its stderr and status when cut
 * short; one cut short before answering died of SIGPIPE.
 */
async function drainChild(
  child: Promise<IOResult>,
  output: IOResult,
  pipe: PipeConsole,
): Promise<void> {
  let io: IOResult | undefined
  try {
    io = await child
    await pump(pipe, Channel.STDERR, io.stderr)
    await pump(pipe, Channel.STDOUT, io.stdout)
  } finally {
    output.stderr = await pipe.snapshot(Channel.STDERR)
    output.exitCode = io === undefined ? SIGPIPE_STATUS : io.exitCode
  }
}

/**
 * Run the builder's command lines as they arrive, at most `procs` at a time.
 *
 * Messages keep their place among the runs. A command nobody provides stops
 * xargs with GNU's 127 before it runs, and one exiting 255 stops it with 124
 * once it has run, each after GNU's diagnostic; the commands already running
 * finish. Parallel mode, and a slot variable, give every command a fork of
 * the session, even a single command, so one cannot see another's
 * variables, and each drains inside its fork, since a stream can still read
 * the ambient session. Where the async context cannot keep concurrent forks
 * apart (a browser without AsyncLocalStorage) the lines run one at a time,
 * each in its own fork. The results come back in input order, which is the
 * order their output is written in.
 */
async function* runLines(
  executeFn: ExecuteStringFn,
  events: (signal: AbortSignal) => AsyncGenerator<XargsEvent>,
  context: EvaluationContext,
  procs: number,
  opts: RunOptions,
): AsyncGenerator<[IOResult[], number | null]> {
  const session = context.session
  const slotVar = opts.slotVar ?? null
  const registry = opts.registry ?? null
  let stop: number | null = null
  const stopping = new AbortController()
  // Read through a call: another command may stop the run during an await.
  const stopped = (): boolean => stop !== null
  const forked = procs !== 1 || slotVar !== null
  const taken = new Set<number>()
  const stdin = opts.stdin == null ? new Uint8Array() : new SharedStdin(opts.stdin)
  // xargs execs its command, so a builtin that is also a program answers
  // as the program.
  const active = new Map<Promise<unknown>, [IOResult, PipeConsole]>()
  const run = async (
    words: string[],
    output: IOResult,
    pipe: PipeConsole,
    signal: AbortSignal,
  ): Promise<void> => {
    const line = shellJoin(words)
    if (!forked) {
      await runAsProgram(session, () =>
        drainChild(
          executeFn(line, { sessionId: session.sessionId, context, stdin, signal, sink: pipe }),
          output,
          pipe,
        ),
      )
      return
    }
    let slot = 0
    while (taken.has(slot)) slot += 1
    taken.add(slot)
    const childEvaluation = context.fork()
    const child = childEvaluation.session
    if (slotVar !== null) {
      child.vars = { ...child.vars, ...varsFromEnv({ [slotVar]: String(slot) }) }
    }
    try {
      await runWithEvaluation(childEvaluation, () =>
        runAsProgram(child, () =>
          drainChild(
            executeFn(line, {
              sessionId: child.sessionId,
              context: childEvaluation,
              session: child,
              stdin,
              signal,
              sink: pipe,
            }),
            output,
            pipe,
          ),
        ),
      )
      return
    } finally {
      taken.delete(slot)
    }
  }
  interface Run {
    results: IOResult[]
    task?: Promise<unknown>
  }
  const invoke = (event: XargsEvent, signal: AbortSignal): Promise<Run> => {
    const slot: IOResult[] = []
    if (typeof event === 'string')
      return Promise.resolve({ results: [new IOResult({ stderr: encodeText(event) })] })
    const words = event.map(decodeText)
    const name = words[0] ?? ''
    if (opts.trace === true) slot.push(new IOResult({ stderr: encodeText(trace(event)) }))
    if (registry !== null && !execs(name, session, registry)) {
      slot.push(
        new IOResult({ stderr: encodeText(xargsMissing(name)), exitCode: NOT_FOUND_STATUS }),
      )
      stop = NOT_FOUND_STATUS
      stopping.abort()
      return Promise.resolve({ results: slot })
    }
    const pipe = new PipeConsole()
    const io = new IOResult({ stdout: pipe.stream() })
    slot.push(io)
    const task = (async (): Promise<unknown> => {
      try {
        await run(words, io, pipe, signal)
        if (io.exitCode === 255 && !stopped()) {
          io.stderr = (
            await io.merge(
              new IOResult({
                stderr: encodeText('xargs: ' + name + ': exited with status 255; aborting\n'),
              }),
            )
          ).stderr
          stop = TIMEOUT_STATUS
          stopping.abort()
        }
      } catch (error) {
        stop ??= 1
        pipe.end(error)
        return error
      } finally {
        pipe.end()
      }
    })()
    active.set(task, [io, pipe])
    return Promise.resolve({ results: slot, task })
  }

  async function* admitted(signal: AbortSignal): AsyncGenerator<XargsEvent> {
    const source = events(mergeSignals(signal, stopping.signal) ?? signal)
    try {
      while (!stopped()) {
        const next = await source.next()
        if (next.done === true) return
        if (!stopped()) yield next.value
      }
    } catch (error) {
      if (!stopped()) throw error
    } finally {
      await source.return(undefined)
    }
  }
  const width = procs !== 1 && asyncContextIsolatesTasks ? procs : 1
  try {
    for await (const job of boundedMapStream(
      admitted,
      invoke,
      width,
      context.frame.abortSignal ?? undefined,
    )) {
      yield [job.results, stop]
      if (job.task !== undefined) {
        await job.task
        active.delete(job.task)
      }
    }
  } finally {
    for (const [, pipe] of active.values()) pipe.closeReader()
    for (const error of await Promise.all(active.keys())) {
      if (error === undefined || error instanceof PipeClosed) continue
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        console.debug('xargs command raised at teardown:', error)
    }
    for (const [io] of active.values()) opts.torn.push(io)
  }
}

export interface XargsOptions {
  /** The op dispatcher, which reads -a's file. */
  dispatch?: DispatchFn | null
  /** Where command names are looked up; absent runs every name. */
  registry?: MountRegistry | null
}

/**
 * Run a command with words read from stdin (GNU xargs).
 *
 * The words are appended to the initial arguments, or with -I each input
 * line takes the place of the string in them. Options act in the order
 * given: -I, -L and -n cancel each other with GNU's warning, and --help or
 * --version answers where it stands. The spec declares every option GNU's
 * table has, so an abbreviated long option resolves exactly as GNU's does.
 *
 * The limits are GNU's on a Linux system with an 8 MiB stack: the
 * environment counts against ARG_MAX (2 MiB) as GNU measures it, and a
 * command line holds 128 KiB unless -s says otherwise. There is no
 * terminal, so -p and -o fail the way GNU does without one.
 *
 * GNU xargs execs the command directly, so every input word must reach it
 * as exactly one argv token. The inner line is built with shellJoin: a
 * plain join would be re-parsed by the shell, splitting words with
 * whitespace and executing $(...) found in input.
 */
export async function handleXargs(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  options: XargsOptions = {},
): Promise<Result> {
  const session = context.session
  const parse = parseShellOptions(SHELL_SPECS.xargs, args)
  let environment = 0
  for (const [name, value] of Object.entries(envSnapshot(session))) {
    environment += encodeText(`${name}=${value}`).length + 1
  }
  const room = EXEC_BYTES - environment - UNUSED_BYTES
  const plan = new Plan(room, UNUSED_BYTES + environment >= EXEC_BYTES)
  plan.width = Math.min(STANDARD_WIDTH, room)
  try {
    for (const [name, value] of parse.given) {
      if (name === 'help' || name === 'version') return answer(name, plan.notes)
      plan.take(name, typeof value === 'string' ? value : null)
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    return refusal(plan.notes + error.text, error.code)
  }
  const notes = encodeText(plan.notes)
  if (parse.invalid !== null) {
    const [stderr, code] =
      parse.candidates.length > 0
        ? ambiguousOptionError('xargs', parse.invalid, parse.candidates)
        : unknownOptionError('xargs', parse.invalid)
    return refusal(concat([notes, stderr]), code)
  }
  if (parse.unexpectedValue !== null) {
    const [stderr, code] = unexpectedValueError('xargs', parse.unexpectedValue)
    return refusal(concat([notes, stderr]), code)
  }
  if (parse.needsValue !== null) {
    const [stderr, code] = missingValueError('xargs', parse.needsValue)
    return refusal(concat([notes, stderr]), code)
  }
  if (plan.endWord !== null && plan.separator !== null) {
    plan.notes += 'xargs: warning: the -E option has no effect if -0 or -d is used.\n\n'
  }
  if (plan.crowded) return refusal(plan.notes + CROWDED)

  let data: ByteSource
  let childStdin: ByteSource | null = null
  if (plan.source === '-') {
    data = stdin ?? new Uint8Array()
  } else {
    try {
      if (options.dispatch === undefined || options.dispatch === null) {
        throw enoent(plan.source)
      }
      data = await readScriptBytes(options.dispatch, plan.source, session.cwd)
    } catch (err) {
      const strerror = fsStrerror(err)
      if (strerror === null) throw err
      return refusal(
        `${plan.notes}xargs: Cannot open input file '${quoteText(plan.source)}': ${strerror}\n`,
      )
    }
    childStdin = stdin
  }
  if (plan.flags.has('show-limits')) plan.notes += limitsReport(environment, room, plan.width)

  const command = parse.operands.length > 0 ? parse.operands : ['echo']
  const [sink, reader] = assemble(
    plan,
    command.map((word) => encodeText(word)),
    room,
  )
  async function* events(signal: AbortSignal): AsyncGenerator<XargsEvent> {
    const source = chunks(data, signal)
    try {
      sink.begin()
      while (!sink.halted()) {
        const part = await source.next()
        // Each command goes to the runner as soon as it is built, before the
        // rest of the chunk is read.
        if (part.done === true) {
          let finished = false
          while (!finished) {
            finished = reader.end()
            yield* sink.drain()
          }
          break
        }
        let at = 0
        for (;;) {
          at = reader.feed(part.value, at)
          yield* sink.drain()
          if (at >= part.value.length || sink.halted()) break
        }
      }
    } finally {
      await source.return?.(undefined)
    }
  }
  const merged = new IOResult(plan.notes === '' ? {} : { stderr: encodeText(plan.notes) })
  const node = new ExecutionNode({ command: 'xargs' })
  async function* output(): AsyncGenerator<Uint8Array> {
    let stopped: number | null = null
    let failed = false
    const torn: IOResult[] = []
    async function record(io: IOResult): Promise<boolean> {
      if (io.exitCode === 255 && stopped === null) stopped = TIMEOUT_STATUS
      merged.stderr = (await merged.merge(new IOResult({ stderr: io.stderr }))).stderr
      return io.exitCode !== 0
    }
    try {
      for await (const [ios, stop] of runLines(executeFn, events, context, plan.jobs, {
        trace: plan.flags.has('t'),
        slotVar: plan.slotVar,
        registry: options.registry ?? null,
        stdin: childStdin,
        torn,
      })) {
        stopped = stop
        for (const io of ios) {
          yield* chunks(io.stdout ?? new Uint8Array())
          failed = (await record(io)) || failed
        }
      }
    } finally {
      for (const io of torn) failed = (await record(io)) || failed
      // A reader that stops early still sees the runs it reached.
      if (stopped !== null) merged.exitCode = stopped
      else if (sink.failure !== null) {
        const [text, code] = sink.failure
        merged.stderr = (await merged.merge(new IOResult({ stderr: encodeText(text) }))).stderr
        // A command that failed outranks xargs's own error: GNU 4.10 exits
        // 123 on `X1 'c` when X1 fails.
        merged.exitCode = failed ? 123 : code
      } else merged.exitCode = failed ? 123 : 0
      node.exitCode = merged.exitCode
    }
  }
  return [output(), merged, node]
}

/** The `xargs` arm. */
export async function xargsBuiltin(call: BuiltinCall): Promise<Result> {
  return handleXargs(call.executeFn, [...call.argv.args], call.context, call.stdin, {
    dispatch: call.dispatch,
    registry: call.registry,
  })
}

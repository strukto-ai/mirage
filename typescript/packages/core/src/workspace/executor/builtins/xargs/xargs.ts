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
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { SharedStdin, asyncChain, yieldBytes } from '../../../../io/stream.ts'
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
import { concat } from '../../../../io/cachable_iterator.ts'

const SYNOPSIS = 'xargs [OPTION]... COMMAND [INITIAL-ARGS]...'
const PROCS_MAX = 2147483647
const ARG_MAX = 2097152
const HEADROOM = 2048
const POSIX_ARG_MIN = 4096
const DEFAULT_ARG_SIZE = 131072
const BLANKS = new Set([0x20, 0x09])
const SPACES = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d])
const QUOTES = new Map([
  [0x27, 'single'],
  [0x22, 'double'],
])
const NUMBER = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/
const ESCAPES: Readonly<Record<string, number>> = Object.freeze({
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
})
const NUL_WARNING =
  'xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n'

const enum ReadState {
  NORM,
  SPACE,
  QUOTE,
  BACKSLASH,
}

type XargsEvent = string | Uint8Array[]

/** GNU's `error (EXIT_FAILURE, ...)`: the message ends xargs. */
class Fatal extends Error {
  constructor(
    readonly text: string,
    readonly code = 1,
  ) {
    super(text)
  }
}

function refuse(stderr: string | Uint8Array, exitCode = 1): Result {
  const data = typeof stderr === 'string' ? encodeText(stderr) : stderr
  return [
    null,
    new IOResult({ exitCode, stderr: data }),
    new ExecutionNode({ command: 'xargs', exitCode }),
  ]
}

/** GNU's parse_num refusal of a count, null for a valid one. */
function countError(
  raw: string,
  name: string,
  least = 1,
  most: number | null = null,
): string | null {
  let message: string
  if (!NUMBER.test(raw)) message = `invalid number "${raw}" for -${name} option`
  else if (Number(raw.trim()) < least)
    message = `value ${raw} for -${name} option should be >= ${String(least)}`
  else if (most !== null && Number(raw.trim()) > most) {
    message = `value ${raw} for -${name} option should be <= ${String(most)}`
  } else return null
  return `xargs: ${message}\n${usageHint('xargs')}\n`
}

/** xargs's answer to --help or --version: stdout, exit 0. */
function standardResponse(option: string, warnings: string): Result {
  const text =
    option === 'help'
      ? renderHelp('xargs', SHELL_SPECS.xargs, [], undefined, SYNOPSIS)
      : versionLine('xargs')
  return [
    yieldBytes(encodeText(text)),
    new IOResult(warnings === '' ? {} : { stderr: encodeText(warnings) }),
    new ExecutionNode({ command: 'xargs', exitCode: 0 }),
  ]
}

function exclusive(option: string, offending: string): string {
  return `xargs: warning: options ${offending} and ${option} are mutually exclusive, ignoring previous ${offending} value\n`
}

/**
 * GNU's get_input_delimiter: the byte, or its refusal.
 *
 * One byte stands for itself; otherwise the value is a C escape (a letter,
 * `\\` or an octal or `\x` hex code) and anything else is refused, the
 * empty value included.
 */
function delimiter(spec: string): [number, string] {
  const raw = encodeText(spec)
  if (raw.length === 1) return [raw[0] ?? 0, '']
  if (!spec.startsWith('\\')) {
    return [
      0,
      `xargs: Invalid input delimiter specification ${spec}: the delimiter must be either a single character or an escape sequence starting with \\.\n`,
    ]
  }
  const letter = spec[1] ?? ''
  const named = ESCAPES[letter]
  if (named !== undefined) return [named, '']
  if (letter !== 'x' && !/^[0-9]$/.test(letter)) {
    return [0, `xargs: Invalid escape sequence ${spec} in input delimiter specification.\n`]
  }
  const hex = letter === 'x'
  const body = hex ? spec.slice(2) : spec.slice(1)
  const digits = (hex ? /^[0-9a-fA-F]*/ : /^[0-7]*/).exec(body)?.[0] ?? ''
  const value = digits === '' ? 0 : parseInt(digits, hex ? 16 : 8)
  if (value > 255) {
    return [
      0,
      `xargs: Invalid escape sequence ${spec} in input delimiter specification; character values must not exceed ${hex ? 'ff' : '377'}.\n`,
    ]
  }
  const tail = body.slice(digits.length)
  if (tail !== '') {
    return [
      0,
      `xargs: Invalid escape sequence ${spec} in input delimiter specification; trailing characters ${tail} not recognised.\n`,
    ]
  }
  return [value, '']
}

function unmatched(quote: number): string {
  return `xargs: unmatched ${QUOTES.get(quote) ?? ''} quote; by default quotes are special to xargs unless you use the -0 option\n`
}

function cString(word: Uint8Array): Uint8Array {
  const at = word.indexOf(0)
  return at < 0 ? word : word.subarray(0, at)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function limits(envSize: number, posixMax: number, argMax: number): string {
  return (
    `Your environment variables take up ${String(envSize)} bytes\n` +
    `POSIX upper limit on argument length (this system): ${String(posixMax)}\n` +
    `POSIX smallest allowable upper limit on argument length (all systems): ${String(POSIX_ARG_MIN)}\n` +
    `Maximum length of command we could actually use: ${String(posixMax - envSize)}\n` +
    `Size of command buffer we are actually using: ${String(argMax)}\n` +
    `Maximum parallelism (--max-procs must be no greater): ${String(PROCS_MAX)}\n`
  )
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

interface BuilderOptions {
  delim: number | null
  eof: Uint8Array | null
  replace: Uint8Array | null
  maxArgs: number
  maxLines: number
  argMax: number
  maxArgc: number
  exitIfExceeded: boolean
  alwaysRun: boolean
  query: boolean
  openTty: boolean
}

/**
 * GNU xargs's input reader and command builder over one input.
 *
 * A port of `read_line`, `read_string` and buildcmd.c: words are pushed onto
 * the pending command line until a -n, -L or size limit runs it, and every
 * limit, logical EOF and refusal lands where GNU's does. `events` records
 * what GNU does in order, a message or a command line to run; a refusal
 * throws `Fatal` after the events before it.
 */
class Builder {
  readonly events: XargsEvent[] = []
  private pos = 0
  private args: Uint8Array[] = []
  private chars = 0
  private initialChars = 0
  private initialArgc = 0
  private initial = true
  private runs = 0
  private lineno = 0
  private eof = false
  private nulWarned = false
  private line: Uint8Array = new Uint8Array()
  private readonly exitIfExceeded: boolean

  constructor(
    private readonly data: Uint8Array,
    private readonly command: Uint8Array[],
    private readonly opts: BuilderOptions,
  ) {
    this.exitIfExceeded = opts.exitIfExceeded || opts.replace !== null || opts.maxLines > 0
  }

  /** Read the whole input into `events`; throws `Fatal`. */
  build(): void {
    if (this.opts.replace === null) {
      for (const word of this.command) this.push(word, word.length + 1)
      this.initial = false
      this.initialArgc = this.args.length
      this.initialChars = this.chars
      while (this.read() !== -1) {
        if (this.opts.maxLines > 0 && this.lineno >= this.opts.maxLines) {
          this.exec()
          this.lineno = 0
        }
      }
      if (this.args.length !== this.initialArgc || (this.opts.alwaysRun && this.runs === 0)) {
        this.exec()
      }
      return
    }
    const [head = new Uint8Array(), ...rest] = this.command
    for (let length = this.read(); length !== -1; length = this.read()) {
      const line = cString(this.line)
      this.args = []
      this.chars = 0
      this.push(head, head.length + 1)
      this.initial = false
      for (const arg of rest) this.insert(arg, line, length - 1)
      this.exec()
    }
  }

  private read(): number {
    return this.opts.delim === null ? this.readLine() : this.readItem()
  }

  private take(word: Uint8Array): number {
    this.line = word
    if (this.opts.replace === null) this.push(cString(word), word.length + 1)
    return word.length + 1
  }

  private isEof(word: Uint8Array): boolean {
    return this.opts.eof !== null && sameBytes(cString(word), this.opts.eof)
  }

  private readLine(): number {
    if (this.eof) return -1
    let state = ReadState.SPACE
    let quote = 0
    let c = -1
    let first = true
    let seen = false
    let buf: number[] = []
    const room = this.opts.argMax - this.initialChars - 1
    for (;;) {
      const prev = c
      if (this.pos >= this.data.length) {
        this.eof = true
        if (buf.length === 0) return -1
        if (state === ReadState.QUOTE) {
          this.execIfPossible()
          throw new Fatal(unmatched(quote))
        }
        if (first && this.isEof(Uint8Array.from(buf))) return -1
        return this.take(Uint8Array.from(buf))
      }
      c = this.data[this.pos] ?? 0
      this.pos += 1
      if (state === ReadState.SPACE) {
        if (SPACES.has(c)) continue
        state = ReadState.NORM
      }
      if (state === ReadState.NORM) {
        if (c === 0x0a) {
          if (!BLANKS.has(prev)) this.lineno += 1
          if (buf.length === 0 && !seen) {
            state = ReadState.SPACE
            continue
          }
          const word = Uint8Array.from(buf)
          if (this.isEof(word)) {
            this.eof = true
            return first ? -1 : word.length + 1
          }
          return this.take(word)
        }
        seen = true
        if (this.opts.replace === null && BLANKS.has(c)) {
          const word = Uint8Array.from(buf)
          if (this.isEof(word)) {
            this.eof = true
            return first ? -1 : word.length + 1
          }
          this.take(word)
          buf = []
          state = ReadState.SPACE
          first = false
          continue
        }
        if (c === 0x5c) {
          state = ReadState.BACKSLASH
          continue
        }
        if (QUOTES.has(c)) {
          state = ReadState.QUOTE
          quote = c
          continue
        }
      } else if (state === ReadState.QUOTE) {
        if (c === 0x0a) {
          this.execIfPossible()
          throw new Fatal(unmatched(quote))
        }
        if (c === quote) {
          state = ReadState.NORM
          seen = true
          continue
        }
      } else {
        state = ReadState.NORM
      }
      if (c === 0 && !this.nulWarned) {
        this.events.push(NUL_WARNING)
        this.nulWarned = true
      }
      if (buf.length >= room) {
        this.execIfPossible()
        throw new Fatal('xargs: argument line too long\n')
      }
      buf.push(c)
    }
  }

  private readItem(): number {
    if (this.eof) return -1
    const buf: number[] = []
    const room = this.opts.argMax - this.initialChars - 1
    for (;;) {
      if (this.pos >= this.data.length) {
        this.eof = true
        return buf.length > 0 ? this.take(Uint8Array.from(buf)) : -1
      }
      const c = this.data[this.pos] ?? 0
      this.pos += 1
      if (c === this.opts.delim) {
        this.lineno += 1
        return this.take(Uint8Array.from(buf))
      }
      if (buf.length >= room) {
        this.execIfPossible()
        throw new Fatal('xargs: argument line too long\n')
      }
      buf.push(c)
    }
  }

  private full(): boolean {
    if (
      !this.initial &&
      this.opts.maxArgs > 0 &&
      this.args.length - this.initialArgc === this.opts.maxArgs
    ) {
      return true
    }
    return this.args.length === this.opts.maxArgc
  }

  private push(arg: Uint8Array, length: number): void {
    if (this.chars + length > this.opts.argMax) {
      if (this.initial || this.args.length === this.initialArgc) {
        throw new Fatal('xargs: cannot fit single argument within argument list size limit\n')
      }
      if (
        this.opts.replace !== null ||
        (this.exitIfExceeded && (this.opts.maxLines > 0 || this.opts.maxArgs > 0))
      ) {
        throw new Fatal('xargs: argument list too long\n')
      }
      this.exec()
    }
    if (this.full()) this.exec()
    this.args.push(arg)
    this.chars += length
    if (this.full()) this.exec()
    if (this.initial) this.initialChars = this.chars
  }

  /** GNU's bc_do_insert: one initial argument with -I applied. */
  private insert(arg: Uint8Array, line: Uint8Array, size: number): void {
    const replace = this.opts.replace ?? new Uint8Array()
    let room = this.opts.argMax - 1
    const out: Uint8Array[] = []
    let length = 0
    let rest = arg
    let once = true
    while (once || rest.length > 0) {
      once = false
      const at = findBytes(rest, replace)
      const span = at >= 0 ? at : rest.length
      if (room <= span) break
      room -= span
      out.push(rest.subarray(0, span))
      length += span
      rest = rest.subarray(span)
      if (at < 0) continue
      if (room <= size || (replace.length === 0 && size === 0)) break
      room -= size
      out.push(line, new Uint8Array(size - line.length))
      length += size
      rest = rest.subarray(replace.length)
    }
    if (rest.length > 0) throw new Fatal('xargs: command too long\n')
    this.push(cString(concat(out)), length + 1)
  }

  private execIfPossible(): void {
    if (
      this.opts.replace !== null ||
      this.initial ||
      this.args.length === this.initialArgc ||
      this.exitIfExceeded
    ) {
      return
    }
    this.exec()
  }

  private exec(): void {
    const line = [...this.args]
    if (this.opts.query) {
      this.events.push(trace(line).slice(0, -1))
      throw new Fatal('xargs: failed to open /dev/tty for reading: No such device or address\n')
    }
    if (this.opts.openTty) {
      const name = decode(line[0] ?? new Uint8Array())
      throw new Fatal(
        "xargs: '/dev/tty': No such device or address\n" +
          "xargs: xargs.c:1648: wait_for_proc_all: Assertion `getpid () == parent' failed.\n" +
          `xargs: ${name}: terminated by signal 6\n`,
        125,
      )
    }
    this.events.push(line)
    this.runs += 1
    this.args.length = this.initialArgc
    this.chars = this.initialChars
  }
}

interface RunOptions {
  trace?: boolean
  slotVar?: string | null
  registry?: MountRegistry | null
  stdin?: ByteSource | null
}

/**
 * Run the builder's command lines, at most `procs` at a time.
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
async function runLines(
  executeFn: ExecuteStringFn,
  events: readonly XargsEvent[],
  context: EvaluationContext,
  procs: number,
  opts: RunOptions = {},
): Promise<[IOResult[], number | null]> {
  const session = context.session
  const results: IOResult[][] = events.map(() => [])
  const slotVar = opts.slotVar ?? null
  const registry = opts.registry ?? null
  let next = 0
  let stop: number | null = null
  // Read through a call: another worker may stop the run during an await.
  const stopped = (): boolean => stop !== null
  const forked = procs !== 1 || slotVar !== null
  const taken = new Set<number>()
  const stdin = opts.stdin == null ? new Uint8Array() : new SharedStdin(opts.stdin)
  // xargs execs its command, so a builtin that is also a program answers
  // as the program.
  const run = async (words: string[]): Promise<IOResult> => {
    const line = shellJoin(words)
    if (!forked) {
      const io = await runAsProgram(session, () =>
        executeFn(line, { sessionId: session.sessionId, context, stdin }),
      )
      await io.materializeStdout()
      await io.materializeStderr()
      return io
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
      return await runWithEvaluation(childEvaluation, async () => {
        const io = await runAsProgram(child, () =>
          executeFn(line, {
            sessionId: child.sessionId,
            context: childEvaluation,
            session: child,
            stdin,
          }),
        )
        await io.materializeStdout()
        await io.materializeStderr()
        return io
      })
    } finally {
      taken.delete(slot)
    }
  }
  const worker = async (): Promise<void> => {
    while (stop === null && next < events.length) {
      const index = next
      next += 1
      const event = events[index] ?? ''
      const slot = results[index] ?? []
      if (typeof event === 'string') {
        slot.push(new IOResult({ stderr: encodeText(event) }))
        continue
      }
      const words = event.map(decodeText)
      const name = words[0] ?? ''
      if (opts.trace === true) slot.push(new IOResult({ stderr: encodeText(trace(event)) }))
      if (registry !== null && !execs(name, session, registry)) {
        slot.push(new IOResult({ stderr: encodeText(xargsMissing(name)), exitCode: 127 }))
        stop = 127
        return
      }
      let io: IOResult
      try {
        io = await run(words)
      } catch (err) {
        stop ??= 1
        throw err
      }
      slot.push(io)
      if (io.exitCode === 255 && !stopped()) {
        slot.push(
          new IOResult({
            stderr: encodeText(`xargs: ${name}: exited with status 255; aborting\n`),
            exitCode: 255,
          }),
        )
        stop = 124
      }
    }
  }
  const runs = events.filter((event) => typeof event !== 'string').length
  const parallel = procs !== 1 && asyncContextIsolatesTasks
  const width = parallel ? (procs === 0 ? runs : Math.min(procs, runs)) : 1
  await Promise.all(Array.from({ length: Math.max(width, 1) }, worker))
  return [results.flat(), stop]
}

export interface XargsDoors {
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
 * given, as GNU's getopt loop reads them: -I, -L and -n cancel each other
 * with GNU's warning, and --help or --version answers where it stands. The
 * spec declares every option GNU's table has, so an abbreviated long option
 * resolves exactly as GNU's does.
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
  doors: XargsDoors = {},
): Promise<Result> {
  const session = context.session
  const parse = parseShellOptions(SHELL_SPECS.xargs, args)
  let envSize = 0
  for (const [name, value] of Object.entries(envSnapshot(session))) {
    envSize += encodeText(`${name}=${value}`).length + 1
  }
  const posixMax = ARG_MAX - envSize - HEADROOM
  const oversized = HEADROOM + envSize >= ARG_MAX
  let argMax = Math.min(DEFAULT_ARG_SIZE, posixMax)
  let replace: string | null = null
  let maxLines = 0
  let maxArgs = 0
  let procs = 1
  let warnings = ''
  let delim: number | null = null
  let eof: string | null = null
  let argFile = '-'
  let slotVar: string | null = null
  const toggles = new Set<string>()
  for (const [name, value] of parse.given) {
    if (name === 'help' || name === 'version') return standardResponse(name, warnings)
    if (name === '0') delim = 0
    if (name === 'd' && typeof value === 'string') {
      const [byte, refusal] = delimiter(value)
      if (refusal !== '') return refuse(warnings + refusal)
      delim = byte
    }
    if (name === 'E' || name === 'e') eof = typeof value === 'string' && value !== '' ? value : null
    if (['t', 'p', 'x', 'o', 'r', 'show-limits'].includes(name)) toggles.add(name)
    if (name === 'a' && typeof value === 'string') argFile = value
    if (name === 'process-slot-var' && typeof value === 'string') {
      if (value.includes('=')) {
        return refuse(
          `${warnings}xargs: option --process-slot-var may not be set to a value which includes \`='\n`,
        )
      }
      if (value === '') {
        return refuse(`${warnings}xargs: failed to unset environment variable : Invalid argument\n`)
      }
      slotVar = value
    }
    if (name === 's' && typeof value === 'string') {
      if (oversized) return refuse(`${warnings}xargs: environment is too large for exec\n`)
      if (!NUMBER.test(value)) {
        return refuse(
          `${warnings}xargs: invalid number "${value}" for -s option\n${usageHint('xargs')}\n`,
        )
      }
      argMax = Number(value.trim())
      if (argMax < 1) {
        warnings += `xargs: value ${value} for -s option should be >= 1\n`
        argMax = 1
      } else if (argMax > posixMax) {
        warnings += `xargs: value ${value} for -s option should be <= ${String(posixMax)}\n`
        argMax = posixMax
      }
    }
    if (name === 'I' || name === 'i') {
      if (maxArgs > 0) warnings += exclusive('--replace/-I/-i', '--max-args')
      if (maxLines > 0) warnings += exclusive('--replace/-I/-i', '--max-lines')
      replace = typeof value === 'string' ? value : '{}'
      maxLines = 0
      maxArgs = 0
      continue
    }
    if (!['L', 'l', 'n', 'P'].includes(name)) continue
    const raw = typeof value === 'string' ? value : '1'
    const error = name === 'P' ? countError(raw, name, 0, PROCS_MAX) : countError(raw, name)
    if (error !== null) return refuse(warnings + error)
    const count = Number(raw.trim())
    if (name === 'P') {
      procs = count
      continue
    }
    if (name === 'L' || name === 'l') {
      const option = name === 'L' ? '-L' : '--max-lines/-l'
      if (maxArgs > 0) warnings += exclusive(option, '--max-args')
      if (replace !== null) warnings += exclusive(option, '--replace')
      replace = null
      maxLines = count
      maxArgs = 0
      continue
    }
    if (maxLines > 0) warnings += exclusive('--max-args/-n', '--max-lines')
    maxLines = 0
    // GNU reads `-I {} -n1` as plain -I.
    if (replace !== null && count === 1) continue
    if (replace !== null) warnings += exclusive('--max-args/-n', '--replace')
    replace = null
    maxArgs = count
  }
  if (parse.invalid !== null) {
    const [stderr, code] =
      parse.candidates.length > 0
        ? ambiguousOptionError('xargs', parse.invalid, parse.candidates)
        : unknownOptionError('xargs', parse.invalid)
    return refuse(concat([encodeText(warnings), stderr]), code)
  }
  if (parse.unexpectedValue !== null) {
    const [stderr, code] = unexpectedValueError('xargs', parse.unexpectedValue)
    return refuse(concat([encodeText(warnings), stderr]), code)
  }
  if (parse.needsValue !== null) {
    const [stderr, code] = missingValueError('xargs', parse.needsValue)
    return refuse(concat([encodeText(warnings), stderr]), code)
  }
  if (eof !== null && delim !== null) {
    warnings += 'xargs: warning: the -E option has no effect if -0 or -d is used.\n\n'
  }
  if (oversized) return refuse(`${warnings}xargs: environment is too large for exec\n`)

  let data: Uint8Array
  let childStdin: ByteSource | null = null
  if (argFile === '-') {
    data = await materialize(stdin)
  } else {
    try {
      if (doors.dispatch === undefined || doors.dispatch === null) {
        throw enoent(argFile)
      }
      data = await readScriptBytes(doors.dispatch, argFile, session.cwd)
    } catch (err) {
      const strerror = fsStrerror(err)
      if (strerror === null) throw err
      return refuse(
        `${warnings}xargs: Cannot open input file '${quoteText(argFile)}': ${strerror}\n`,
      )
    }
    childStdin = stdin
  }
  if (toggles.has('show-limits')) warnings += limits(envSize, posixMax, argMax)

  const command = parse.operands.length > 0 ? parse.operands : ['echo']
  const builder = new Builder(
    data,
    command.map((word) => encodeText(word)),
    {
      delim,
      eof: eof !== null ? encodeText(eof) : null,
      replace: replace !== null ? encodeText(replace) : null,
      maxArgs,
      maxLines,
      argMax,
      maxArgc: Math.floor(posixMax / 8) - 2,
      exitIfExceeded: toggles.has('x'),
      alwaysRun: !toggles.has('r'),
      query: toggles.has('p'),
      openTty: toggles.has('o'),
    },
  )
  let fatal: Fatal | null = null
  try {
    builder.build()
  } catch (err) {
    if (!(err instanceof Fatal)) throw err
    fatal = err
  }

  const [ios, stop] = await runLines(executeFn, builder.events, context, procs, {
    trace: toggles.has('t'),
    slotVar,
    registry: doors.registry ?? null,
    stdin: childStdin,
  })
  const stdouts: ByteSource[] = []
  let merged = new IOResult(warnings === '' ? {} : { stderr: encodeText(warnings) })
  for (const io of ios) {
    if (io.stdout !== null) stdouts.push(io.stdout)
    merged = await merged.merge(io)
  }
  let exitCode: number
  if (stop !== null) {
    exitCode = stop
  } else if (fatal !== null) {
    merged = await merged.merge(new IOResult({ stderr: encodeText(fatal.text) }))
    exitCode = fatal.code
  } else {
    exitCode = ios.some((io) => io.exitCode !== 0) ? 123 : 0
  }
  merged.exitCode = exitCode
  const out = stdouts.length > 0 ? asyncChain(stdouts) : null
  return [out, merged, new ExecutionNode({ command: 'xargs', exitCode })]
}

/** The `xargs` arm. */
export async function xargsBuiltin(call: BuiltinCall): Promise<Result> {
  return handleXargs(call.executeFn, [...call.argv.args], call.context, call.stdin, {
    dispatch: call.dispatch,
    registry: call.registry,
  })
}

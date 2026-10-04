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

import { versionLine } from '../../../../commands/spec/standard.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { renderHelp } from '../../../../commands/spec/help.ts'
import { SHELL_SPECS, parseShellOptions } from '../../../../commands/spec/shell.ts'
import {
  ambiguousOptionError,
  missingValueError,
  unexpectedValueError,
  unknownOptionError,
  usageHint,
} from '../../../../commands/spec/usage.ts'
import { runAsProgram } from '../../../../context/session_context.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { ensureStream, yieldBytes } from '../../../../io/stream.ts'
import { shellJoin } from '../../../../shell/join.ts'
import { abortable } from '../../../abort.ts'
import { execs } from '../../../lookup/lookup.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import {
  CONTINUE_SIGNALS,
  SELF_KILLING_SIGNALS,
  SIGCHLD,
  SIGKILL,
  SIGNAL_NAMES,
  SIGRTMAX,
  SIGRTMIN,
  SIGSTOP,
  STOP_SIGNALS,
} from './constants.ts'
import { concat } from '../../../../io/cachable_iterator.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const SYNOPSIS = 'timeout [OPTION] DURATION COMMAND [ARG]...'

const FLOAT =
  /^[ \t\n\v\f\r]*([+-]?)(0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN](?:\([0-9A-Za-z_]*\))?)/

const LONG = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/

const UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  '': 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
})

const SIGNUM_BOUND = SIGRTMAX

const TIMED_OUT: unique symbol = Symbol('timed-out')

function refuse(stderr: Uint8Array, exitCode = 125): Result {
  return [
    null,
    new IOResult({ exitCode, stderr }),
    new ExecutionNode({ command: 'timeout', exitCode }),
  ]
}

function usageError(message: string): Result {
  // GNU timeout reserves 125 for its own failures; 124 means the
  // command was killed at the deadline.
  return refuse(encodeText(`timeout: ${message}\n${usageHint('timeout')}\n`))
}

/** GNU's report of a command timeout finds nothing to run for. */
export function timeoutMissing(name: string): string {
  return `timeout: failed to run command '${quoteText(name)}': No such file or directory\n`
}

function hexFloat(body: string): number {
  const match = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(body)
  const whole = match?.[1] ?? ''
  const fraction = match?.[2] ?? ''
  const mantissa = parseInt(`${whole}${fraction}` || '0', 16)
  return mantissa * 2 ** (Number(match?.[3] ?? '0') - 4 * fraction.length)
}

/**
 * GNU timeout's parse_duration: a C float plus an optional s/m/h/d.
 *
 * cl_strtod reads the longest number at the front of the word, leading
 * whitespace, an exponent, a hex float and inf included; at most one
 * suffix letter may follow, and a negative or NaN interval is refused.
 */
export function parseDuration(raw: string): number | null {
  const match = FLOAT.exec(raw)
  if (match === null) return null
  const sign = match[1] ?? ''
  const body = match[2] ?? ''
  const multiplier = UNIT_SECONDS[raw.slice(match[0].length)]
  if (multiplier === undefined) return null
  const lowered = body.toLowerCase()
  if (lowered.startsWith('nan')) return null
  let value = lowered.startsWith('0x')
    ? hexFloat(body)
    : lowered.startsWith('inf')
      ? Infinity
      : Number(body)
  if (sign === '-') value = -value
  if (!(value >= 0)) return null
  return (value === 0 ? 0 : value) * multiplier
}

function strtol(text: string): number | null {
  if (text === '') return 0
  return LONG.test(text) ? Number(text.trim()) : null
}

function str2sig(name: string): number | null {
  if (/^[0-9]/.test(name)) {
    if (!/^[0-9]+$/.test(name)) return null
    return Number(name) <= SIGNUM_BOUND ? Number(name) : null
  }
  for (const [known, number] of SIGNAL_NAMES) if (known === name) return number
  const span = SIGRTMAX - SIGRTMIN
  if (name.startsWith('RTMIN')) {
    const delta = strtol(name.slice(5))
    if (delta !== null && delta >= 0 && delta <= span) return SIGRTMIN + delta
  } else if (name.startsWith('RTMAX')) {
    const delta = strtol(name.slice(5))
    if (delta !== null && delta >= -span && delta <= 0) return SIGRTMAX + delta
  }
  return null
}

/**
 * GNU's operand2sig: the signal a -s value names, null if none.
 *
 * A number may carry a shell's 128 or 256 offset, as in `$?`; a name is
 * read in any case, with or without its SIG prefix.
 */
export function parseSignal(operand: string): number | null {
  let number: number | null
  if (/^[0-9]/.test(operand)) {
    if (!/^[0-9]+$/.test(operand) || Number(operand) > 2 ** 31 - 1) return null
    const typed = Number(operand)
    number = typed & (typed >= 0xff ? 0xff : 0x7f)
  } else {
    const upper = operand.replace(/[a-z]/g, (c) => c.toUpperCase())
    number = str2sig(upper)
    if (number === null && upper.startsWith('SIG')) number = str2sig(upper.slice(3))
  }
  if (number === null || number < 0 || number > SIGNUM_BOUND) return null
  return number
}

/**
 * gnulib's sig2str: a signal's name, or its number when it has none.
 * The table follows glibc on x86-64 Linux: the first matching name wins
 * (6 is ABRT, 29 is POLL), independently of the host's signal numbers.
 */
export function signalName(number: number): string {
  for (const [name, known] of SIGNAL_NAMES) if (known === number) return name
  if (number < SIGRTMIN || number > SIGRTMAX) return String(number)
  const low = number <= SIGRTMIN + Math.floor((SIGRTMAX - SIGRTMIN) / 2)
  const delta = number - (low ? SIGRTMIN : SIGRTMAX)
  const suffix = delta === 0 ? '' : delta > 0 ? `+${String(delta)}` : String(delta)
  return `${low ? 'RTMIN' : 'RTMAX'}${suffix}`
}

// Run the inner line and drain its stdout under the same deadline. A lazy
// inner pipeline produces bytes only when consumed; draining inside the
// deadline keeps the whole run under the limit, and draining chunk by
// chunk into `drained` is what lets a run that overruns keep what it had
// printed.
async function executeDrained(
  executeFn: ExecuteStringFn,
  inner: string,
  sessionId: string,
  stdin: ByteSource | null,
  drained: Uint8Array[],
  held: IOResult[],
  signal: AbortSignal,
): Promise<IOResult> {
  const io = await executeFn(inner, { sessionId, signal, ...(stdin !== null ? { stdin } : {}) })
  held.push(io)
  if (io.stdout !== null) {
    for await (const chunk of ensureStream(io.stdout)) drained.push(chunk)
  }
  return io
}

async function raceDeadline<T>(run: Promise<T>, seconds: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT)
    }, seconds * 1000)
  })
  try {
    return await Promise.race([run, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

interface Supervision {
  signal: number
  killAfter: number
  foreground: boolean
  preserve: boolean
  verbose: boolean
  name: string
}

/**
 * Run `timeout [OPTION] DURATION COMMAND [ARG...]` (GNU timeout).
 *
 * The inner line is built with shellJoin so already-expanded words survive
 * re-parsing as one token each (GNU timeout execs the command without a
 * shell). The command reads timeout's stdin. At the deadline the command
 * gets -s's signal (TERM by default), and a command here is a promise, not a
 * process, so the signal's default action decides: one that terminates
 * aborts the run, and 124 reports it, or the status a shell would show with
 * --preserve-status; one that is ignored (0, CHLD, CONT, URG, WINCH) lets
 * the run carry on, and -k's KILL ends it later with 137; a stop halts it
 * until that KILL. timeout signals its own process group unless
 * --foreground, so it dies of what it cannot ignore (KILL, 32, 33), stops
 * itself on STOP, and never wakes after CHLD; each ends as GNU's does. -v
 * says each signal on stderr. The deadline aborts the inner run, not just
 * the wait for it: a promise cannot be cancelled, so the signal is what
 * stops a `tail -f` from polling on after 124 was already returned.
 */
export async function handleTimeout(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: SessionState,
  stdin: ByteSource | null = null,
  registry: MountRegistry | null = null,
  lineSignal?: AbortSignal,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.timeout, args)
  let signal = 15
  let killAfter = 0
  for (const [name, value] of parse.given) {
    if (name === 'help') {
      const text = renderHelp('timeout', SHELL_SPECS.timeout, [], undefined, SYNOPSIS)
      return [
        yieldBytes(encodeText(text)),
        new IOResult(),
        new ExecutionNode({ command: 'timeout', exitCode: 0 }),
      ]
    }
    if (name === 'version') {
      return [
        yieldBytes(encodeText(versionLine('timeout'))),
        new IOResult(),
        new ExecutionNode({ command: 'timeout', exitCode: 0 }),
      ]
    }
    if (name === 'k' && typeof value === 'string') {
      const after = parseDuration(value)
      if (after === null) return usageError(`invalid time interval '${quoteText(value)}'`)
      killAfter = after < Infinity ? after : 0
    }
    if (name === 's' && typeof value === 'string') {
      const number = parseSignal(value)
      if (number === null) return usageError(`'${quoteText(value)}': invalid signal`)
      signal = number
    }
  }
  if (parse.invalid !== null) {
    const [stderr, code] =
      parse.candidates.length > 0
        ? ambiguousOptionError('timeout', parse.invalid, parse.candidates)
        : unknownOptionError('timeout', parse.invalid)
    return refuse(stderr, code)
  }
  if (parse.unexpectedValue !== null) {
    return refuse(...unexpectedValueError('timeout', parse.unexpectedValue))
  }
  if (parse.needsValue !== null) return refuse(...missingValueError('timeout', parse.needsValue))
  const [raw, ...command] = parse.operands
  if (raw === undefined || command.length === 0) {
    return refuse(encodeText(`${usageHint('timeout')}\n`))
  }
  const seconds = parseDuration(raw)
  if (seconds === null) return usageError(`invalid time interval '${quoteText(raw)}'`)
  const name = command[0] ?? ''
  if (registry !== null && !execs(name, session, registry)) {
    return refuse(encodeText(timeoutMissing(name)), 127)
  }

  const drained: Uint8Array[] = []
  // The inner result lands here as soon as it exists, so its stderr
  // survives the deadline the way the drained stdout does.
  const held: IOResult[] = []
  const abort = new AbortController()
  // timeout execs its command, so a builtin that is also a program answers
  // as the program.
  const run = runAsProgram(session, () =>
    executeDrained(
      executeFn,
      shellJoin(command),
      session.sessionId,
      stdin,
      drained,
      held,
      abort.signal,
    ),
  )
  // The run may be abandoned and reject later; without a handler that
  // becomes an unhandled rejection and can crash the process.
  run.catch(() => undefined)
  try {
    return await supervise(run, abort, drained, held, seconds, lineSignal, {
      signal,
      killAfter,
      foreground: parse.flags.f === true,
      preserve: parse.flags.p === true,
      verbose: parse.flags.v === true,
      name,
    })
  } finally {
    abort.abort()
  }
}

/** Wait for the run, and at the deadline do what the signal does. */
async function supervise(
  run: Promise<IOResult>,
  abort: AbortController,
  drained: Uint8Array[],
  held: IOResult[],
  seconds: number,
  lineSignal: AbortSignal | undefined,
  how: Supervision,
): Promise<Result> {
  const result = seconds > 0 && seconds < Infinity ? await raceDeadline(run, seconds) : await run
  if (result !== TIMED_OUT) {
    return [
      concat(drained),
      result,
      new ExecutionNode({ command: 'timeout', exitCode: result.exitCode }),
    ]
  }
  const said: string[] = []
  const say = (number: number): void => {
    if (how.verbose) {
      said.push(
        `timeout: sending signal ${signalName(number)} to command '${quoteText(how.name)}'\n`,
      )
    }
  }
  const { signal, killAfter, foreground } = how
  say(signal)
  const stops = STOP_SIGNALS.has(signal) && (foreground || signal === SIGSTOP)
  if (stops || (signal === SIGCHLD && !foreground)) {
    // The command stops, or timeout never wakes: only -k's KILL ends the
    // wait, and not even that once timeout stopped itself.
    if (stops) abort.abort()
    if (killAfter === 0 || (signal === SIGSTOP && !foreground)) {
      await abortable(new Promise<never>(() => undefined), lineSignal)
    }
    await sleep(killAfter)
    abort.abort()
    say(SIGKILL)
    return ended(drained, held, said, 137)
  }
  if (CONTINUE_SIGNALS.has(signal) || STOP_SIGNALS.has(signal)) {
    const late = killAfter > 0 ? await raceDeadline(run, killAfter) : await run
    if (late === TIMED_OUT) {
      abort.abort()
      say(SIGKILL)
      return ended(drained, held, said, 137)
    }
    return ended(drained, held, said, how.preserve ? late.exitCode : 124, true)
  }
  abort.abort()
  if (SELF_KILLING_SIGNALS.has(signal) && (!foreground || signal === SIGKILL)) {
    return ended(drained, held, said, 128 + signal)
  }
  return ended(drained, held, said, how.preserve ? 128 + signal : 124)
}

/**
 * What a run the deadline reached leaves behind.
 *
 * What the command printed before it ended is its output, as GNU leaves it
 * on the terminal; only the run past that is lost. That goes for stderr
 * too: a `tail -F missing` has already said it cannot open the file by the
 * time the deadline kills it. timeout's own -v lines follow it. A run that
 * ended on its own has its whole stderr, so that is read in full.
 */
async function ended(
  drained: readonly Uint8Array[],
  held: readonly IOResult[],
  said: readonly string[],
  exitCode: number,
  finished = false,
): Promise<Result> {
  const source = held[0]?.stderr ?? null
  const head = finished
    ? await materialize(source)
    : source instanceof Uint8Array
      ? source
      : new Uint8Array()
  const tail = encodeText(said.join(''))
  const stderr = concat([head, tail])
  const partial = concat(drained)
  return [
    partial.byteLength > 0 ? partial : null,
    new IOResult({ exitCode, stderr: stderr.byteLength > 0 ? stderr : null }),
    new ExecutionNode({ command: 'timeout', exitCode }),
  ]
}

/** The `timeout` arm. */
export async function timeoutBuiltin(call: BuiltinCall): Promise<Result> {
  return handleTimeout(
    call.executeFn,
    [...call.argv.args],
    call.session,
    call.stdin,
    call.registry,
    call.signal,
  )
}

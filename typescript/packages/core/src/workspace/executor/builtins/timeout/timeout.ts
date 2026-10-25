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
import { STRTOD, strtodDouble } from '../../../../commands/builtin/utils/strtod.ts'
import { INT_MAX, boundedDecimal } from '../../../../commands/builtin/utils/strtol.ts'
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
import { Channel, JobConsole } from '../../../../shell/console/index.ts'
import { shellJoin } from '../../../../shell/join.ts'
import { abortable, atDeadline, joinOrAbort } from '../../../../utils/abort.ts'
import { STOP_WAIT_SECONDS } from '../../../../shell/job_table/constants.ts'
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
  SIGNAL_ALIASES,
  SIGNALS,
  SIGRTMAX,
  SIGRTMIN,
  SIGSTOP,
  STOP_SIGNALS,
  TIMEOUT_NAMES,
} from './constants.ts'
import { concat } from '../../../../utils/bytes.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const SYNOPSIS = 'timeout [OPTION] DURATION COMMAND [ARG]...'

const UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  '': 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
})

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

/**
 * A timeout DURATION in seconds: a C float plus an optional s/m/h/d.
 *
 * GNU timeout 9.7 takes the longest C-locale floating-point number at the
 * front of the word, leading whitespace, an exponent, a hex float and inf
 * included; at most one suffix letter may follow, and a negative or NaN
 * interval is refused.
 */
export function durationSeconds(raw: string): number | null {
  const match = STRTOD.exec(raw)
  if (match === null) return null
  const multiplier = UNIT_SECONDS[raw.slice(match[0].length)]
  if (multiplier === undefined) return null
  const value = strtodDouble(match)
  if (!(value >= 0)) return null
  return (value === 0 ? 0 : value) * multiplier
}

// The offset after RTMIN or RTMAX: C blanks, then an optional sign, then
// decimal digits and nothing more (`RTMIN 2`, `RTMAX-01`; not `RTMIN+ 2`).
const RT_OFFSET = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/

function decimal(digits: string): number | null {
  if (!/^[0-9]+$/.test(digits)) return null
  const value = boundedDecimal(digits, INT_MAX + 1n)
  return value === null ? null : Number(value)
}

/**
 * The signal a bare number names, as GNU timeout 9.7 reads one: 0 to 64
 * name themselves; 128 to 192 are a `$?` of 128 plus the signal, and from
 * 256 on only the low byte counts, which must then be 0 to 64 (`265` is
 * KILL, `384` nothing). Mirrors Python's _status_signal.
 */
function statusSignal(value: number): number | null {
  if (value <= SIGRTMAX) return value
  if (value < 256) return value >= 128 && value <= 128 + SIGRTMAX ? value - 128 : null
  const low = value % 256
  return low <= SIGRTMAX ? low : null
}

function realtime(name: string): number | null {
  for (const [base, start] of [
    ['RTMIN', SIGRTMIN],
    ['RTMAX', SIGRTMAX],
  ] as const) {
    if (!name.startsWith(base)) continue
    const rest = name.slice(base.length)
    if (rest === '') return start
    const match = RT_OFFSET.exec(rest)
    const offset = match === null ? null : decimal(match[2] ?? '')
    if (match === null || offset === null) return null
    const value = match[1] === '-' ? start - offset : start + offset
    return value >= SIGRTMIN && value <= SIGRTMAX ? value : null
  }
  return null
}

/**
 * The signal a `-s` value names, null if it names none. Measured on GNU
 * timeout 9.7: a number (decimal digits only, no sign or blank) may carry a
 * shell's 128 or 256 offset, as `$?` does; a name is read in any case, with
 * or without `SIG`, and `SIG` before digits takes only 0 to 64. `RTMIN+n`
 * and `RTMAX-n` stay inside the realtime range. Mirrors Python's
 * parse_signal.
 */
export function parseSignal(operand: string): number | null {
  for (let i = 0; i < operand.length; i += 1) if (operand.charCodeAt(i) > 0x7f) return null
  if (/^[0-9]+$/.test(operand)) {
    const value = decimal(operand)
    return value === null ? null : statusSignal(value)
  }
  const upper = operand.toUpperCase()
  const name = upper.startsWith('SIG') ? upper.slice(3) : upper
  if (/^[0-9]+$/.test(name)) {
    const value = decimal(name)
    return value !== null && value <= SIGRTMAX ? value : null
  }
  const alias = SIGNAL_ALIASES.get(name)
  if (alias !== undefined) return alias
  for (const [number, known] of SIGNALS) if (known === name) return number
  return realtime(name)
}

/**
 * A signal's name as `timeout -v` prints it, or its number. The realtime
 * range is named from RTMIN up to its middle (RTMIN+15 is 49) and from RTMAX
 * above it (50 is RTMAX-14), as GNU 9.7 and bash do. Mirrors Python's
 * signal_name.
 */
export function signalName(number: number): string {
  const named = TIMEOUT_NAMES.get(number) ?? SIGNALS.get(number)
  if (named !== undefined) return named
  if (number < SIGRTMIN || number > SIGRTMAX) return String(number)
  if (number === SIGRTMIN) return 'RTMIN'
  if (number === SIGRTMAX) return 'RTMAX'
  if (number - SIGRTMIN <= Math.floor((SIGRTMAX - SIGRTMIN) / 2)) {
    return `RTMIN+${String(number - SIGRTMIN)}`
  }
  return `RTMAX-${String(SIGRTMAX - number)}`
}

// Run the inner line and drain its output under the same deadline. The line
// writes into `sink` as it runs, a program as it prints and a list
// statement by statement, so a run the deadline cuts short keeps what it had
// printed, as GNU's leaves it on the terminal. A lazy stdout it still
// returns drains inside the deadline too.
async function executeDrained(
  executeFn: ExecuteStringFn,
  inner: string,
  sessionId: string,
  stdin: ByteSource | null,
  sink: JobConsole,
  held: IOResult[],
  signal: AbortSignal,
): Promise<IOResult> {
  const io = await executeFn(inner, {
    sessionId,
    signal,
    sink,
    ...(stdin !== null ? { stdin } : {}),
  })
  held.push(io)
  if (io.stdout !== null) {
    for await (const chunk of ensureStream(io.stdout)) await sink.emit(Channel.STDOUT, chunk)
  }
  const stderr = concat([await sink.snapshot(Channel.STDERR), await io.materializeStderr()])
  io.stderr = stderr.byteLength > 0 ? stderr : null
  return io
}

// `reached` runs at the deadline itself: a guest that holds the event loop
// (QuickJS) meets it there, where nothing waiting on the race can run.
async function raceDeadline<T>(
  run: Promise<T>,
  seconds: number,
  reached: () => void,
): Promise<T | typeof TIMED_OUT> {
  let cancel = (): void => undefined
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    cancel = atDeadline(seconds, () => {
      resolve(TIMED_OUT)
      reached()
    })
  })
  try {
    return await Promise.race([run, deadline])
  } finally {
    cancel()
  }
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
      const after = durationSeconds(value)
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
  const seconds = durationSeconds(raw)
  if (seconds === null) return usageError(`invalid time interval '${quoteText(raw)}'`)
  const name = command[0] ?? ''
  if (registry !== null && !execs(name, session, registry)) {
    return refuse(encodeText(timeoutMissing(name)), 127)
  }

  const sink = new JobConsole()
  // The inner result lands here as soon as it exists.
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
      sink,
      held,
      abort.signal,
    ),
  )
  // The run may be abandoned and reject later; without a handler that
  // becomes an unhandled rejection and can crash the process.
  run.catch(() => undefined)
  try {
    return await supervise(run, abort, sink, held, seconds, lineSignal, {
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
  sink: JobConsole,
  held: IOResult[],
  seconds: number,
  lineSignal: AbortSignal | undefined,
  how: Supervision,
): Promise<Result> {
  const { signal, killAfter, foreground } = how
  const stops = STOP_SIGNALS.has(signal) && (foreground || signal === SIGSTOP)
  const carriesOn =
    (signal === SIGCHLD && !foreground) || CONTINUE_SIGNALS.has(signal) || STOP_SIGNALS.has(signal)
  // -k's KILL, armed at the deadline itself for a run the signal leaves
  // going, which may hold the event loop past it.
  const kill: { at: Promise<typeof TIMED_OUT> | null; cancel: () => void } = {
    at: null,
    cancel: () => undefined,
  }
  const reached = (): void => {
    if (stops || !carriesOn) abort.abort()
    if (!carriesOn || killAfter === 0) return
    kill.at = new Promise((resolve) => {
      kill.cancel = atDeadline(killAfter, () => {
        resolve(TIMED_OUT)
        abort.abort()
      })
    })
  }
  // What the stopped run still does as it ends (a guest landing what it
  // wrote) is done before timeout answers, as Python joins the cancelled
  // run; one that will not end is let go after a stop's grace.
  const stopped = async (): Promise<void> => {
    try {
      await joinOrAbort(run, abort.signal, STOP_WAIT_SECONDS * 1000)
    } catch (err) {
      console.debug(`timeout: the stopped run ended: ${String(err)}`)
    }
  }
  try {
    const result =
      seconds > 0 && seconds < Infinity ? await raceDeadline(run, seconds, reached) : await run
    if (result !== TIMED_OUT) {
      return [
        await sink.snapshot(Channel.STDOUT),
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
    say(signal)
    if (stops || (signal === SIGCHLD && !foreground)) {
      // The command stops, or timeout never wakes: only -k's KILL ends the
      // wait, and not even that once timeout stopped itself.
      if (kill.at === null || (signal === SIGSTOP && !foreground)) {
        await abortable(new Promise<never>(() => undefined), lineSignal)
      }
      await kill.at
      say(SIGKILL)
      await stopped()
      return await ended(sink, held, said, 137)
    }
    if (carriesOn) {
      const late = kill.at === null ? await run : await Promise.race([run, kill.at])
      if (late === TIMED_OUT) {
        say(SIGKILL)
        await stopped()
        return await ended(sink, held, said, 137)
      }
      return await ended(sink, held, said, how.preserve ? late.exitCode : 124, true)
    }
    await stopped()
    if (SELF_KILLING_SIGNALS.has(signal) && (!foreground || signal === SIGKILL)) {
      return await ended(sink, held, said, 128 + signal)
    }
    return await ended(sink, held, said, how.preserve ? 128 + signal : 124)
  } finally {
    kill.cancel()
  }
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
  sink: JobConsole,
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
  // A run that ended on its own holds what it wrote into the console too.
  const early = finished ? new Uint8Array() : await sink.snapshot(Channel.STDERR)
  const stderr = concat([early, head, tail])
  const partial = await sink.snapshot(Channel.STDOUT)
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
    call.context.session,
    call.stdin,
    call.registry,
    call.signal,
  )
}

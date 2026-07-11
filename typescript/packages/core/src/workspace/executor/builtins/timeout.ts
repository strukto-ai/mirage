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

import { SHELL_SPECS, parseShellOptions } from '../../../commands/spec/shell.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

const DURATION = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/

const UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  '': 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
})

const UNSUPPORTED = ['s', 'k', 'preserve-status']

const TIMED_OUT: unique symbol = Symbol('timed-out')

function usageError(message: string): Result {
  // GNU timeout reserves 125 for its own failures; 124 means the
  // command was killed at the deadline.
  const stderr = new TextEncoder().encode(`timeout: ${message}\n`)
  return [
    null,
    new IOResult({ exitCode: 125, stderr }),
    new ExecutionNode({ command: 'timeout', exitCode: 125 }),
  ]
}

/** Parse a GNU timeout duration (float plus optional s/m/h/d). */
export function parseDuration(raw: string): number | null {
  const match = DURATION.exec(raw)
  if (match === null) return null
  return Number(match[1]) * (UNIT_SECONDS[match[2] ?? ''] ?? 1)
}

async function executeDrained(
  executeFn: ExecuteStringFn,
  inner: string,
  sessionId: string,
): Promise<[Uint8Array, IOResult]> {
  const io = await executeFn(inner, { sessionId })
  const stdout = await materialize(io.stdout)
  return [stdout, io]
}

async function raceDeadline(
  run: Promise<[Uint8Array, IOResult]>,
  seconds: number,
): Promise<[Uint8Array, IOResult] | typeof TIMED_OUT> {
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

/**
 * Run `timeout DURATION COMMAND [ARG...]`, killing at the deadline.
 *
 * The inner line is built with shellJoin so already-expanded words
 * survive re-parsing as one token each (GNU timeout execs the command
 * without a shell). On overrun the exit code is 124 like GNU; the
 * inner run's result is abandoned. The inner stdout is drained inside
 * the race so a lazy pipeline cannot run past the deadline. Signal
 * options (-s, -k, --preserve-status) are parsed but rejected: the
 * inner run is a promise, not a process, so there is nothing to
 * signal.
 */
export async function handleTimeout(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.timeout, args)
  if (parse.invalid !== null) {
    if (parse.invalid.startsWith('--')) return usageError(`unrecognized option '${parse.invalid}'`)
    return usageError(`invalid option -- '${parse.invalid}'`)
  }
  if (parse.needsValue !== null) {
    return usageError(`option requires an argument -- '${parse.needsValue}'`)
  }
  for (const name of UNSUPPORTED) {
    if (name in parse.flags) {
      const dashes = name.length > 1 ? '--' : '-'
      return usageError(`unsupported option -- '${dashes}${name}'`)
    }
  }
  const [raw, ...rest] = parse.operands
  if (raw === undefined || rest.length === 0) return usageError('missing operand')
  const seconds = parseDuration(raw)
  if (seconds === null) return usageError(`invalid time interval '${raw}'`)

  const inner = shellJoin(rest)
  const run = executeDrained(executeFn, inner, session.sessionId)
  const result = seconds > 0 ? await raceDeadline(run, seconds) : await run
  if (result === TIMED_OUT) {
    // The abandoned run may still reject later; without a handler that
    // becomes an unhandled rejection and can crash the process.
    run.catch(() => undefined)
    return [
      null,
      new IOResult({ exitCode: 124 }),
      new ExecutionNode({ command: 'timeout', exitCode: 124 }),
    ]
  }
  const [stdout, io] = result
  return [stdout, io, new ExecutionNode({ command: 'timeout', exitCode: io.exitCode })]
}

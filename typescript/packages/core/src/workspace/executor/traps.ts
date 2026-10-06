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

import { concat } from '../../io/cachable_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal, ReturnSignal } from '../../shell/errors.ts'
import type { ExecuteStringFn } from './builtins/types.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecutionNode } from '../types.ts'
import { recordStatus } from './statement.ts'

/**
 * Start a child shell: `( )`, a pipeline stage, a job, `$( )`.
 *
 * The session's `exitTrap` is the `trap ... EXIT` action, '' for an
 * ignored EXIT. A child shell keeps its parent's with `exitTrapInherited`
 * set: it lists it, as bash's `trap -p` does there, and runs none of it
 * until it registers its own. It is live shell state, which a session
 * store keeps none of.
 */
export function inheritExitTrap(session: SessionState): void {
  session.exitTrapInherited = session.exitTrap !== null
  session.trapStatus = null
}

/** Start a new shell (`bash -c`, a script): it has no EXIT action. */
export function clearExitTrap(session: SessionState): void {
  session.exitTrap = null
  session.exitTrapInherited = false
  session.trapStatus = null
}

/**
 * Run the shell's EXIT action as the shell ends with `status`.
 *
 * bash clears the action before it runs it, and an `exit` in it, or one
 * it registers there, does not run again. `$?` starts at `status`, and a
 * bare `exit` keeps it. The status the shell ends with stays `status`
 * unless the action exits, or fails under `set -e`, which exits too. Hard
 * stops (cancellation, a killed job, a closed workspace) are not an end the
 * shell reaches, and never get here. `callStack` holds the frames the
 * action runs in: the function that called `exit` is still on them.
 * Returns null when no action of this shell's own is set.
 */
export async function runExitTrap(
  executeFn: ExecuteStringFn | null,
  session: SessionState,
  status: number,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<IOResult | null> {
  const action = session.exitTrap
  if (
    executeFn === null ||
    action === null ||
    session.exitTrapInherited ||
    session.trapStatus !== null
  ) {
    return null
  }
  session.exitTrap = null
  if (action === '') return null
  recordStatus(session, status)
  // The status the shell is ending with, while the action runs: a bare
  // `exit` in it keeps it, as bash's does.
  const saved = session.trapStatus
  session.trapStatus = status
  let final = status
  let stdout: Uint8Array
  let stderr: Uint8Array
  try {
    const io = await executeFn(action, {
      sessionId: session.sessionId,
      session,
      stdin,
      callStack: callStack ?? new CallStack(),
    })
    stdout = await materialize(io.stdout)
    stderr = await io.materializeStderr()
    // Only a failure `set -e` acts on ends the shell: one in a test, the
    // left of `&&`/`||` or after `!` leaves the status alone.
    if (io.exitCode !== 0 && session.shellOptions.errexit === true && !session.errexitImmune)
      final = io.exitCode
  } catch (err) {
    if (err instanceof ExitSignal) {
      stdout = err.stdout ?? new Uint8Array()
      stderr = err.stderr
      final = err.exitCode
    } else if (err instanceof ReturnSignal) {
      stdout = await materialize(err.stdout)
      stderr = err.stderr
    } else {
      throw err
    }
  } finally {
    session.trapStatus = saved
    session.exitTrap = null
    session.exitTrapInherited = false
  }
  recordStatus(session, final)
  return new IOResult({ stdout, stderr: stderr.byteLength > 0 ? stderr : null, exitCode: final })
}

/**
 * End a child shell whose line returned `io`: a `bash -c`, a script, a
 * `$( )`. Its EXIT action runs after what it wrote.
 */
export async function finishShell(
  executeFn: ExecuteStringFn | null,
  session: SessionState,
  io: IOResult,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<IOResult> {
  const cleanup = await runExitTrap(executeFn, session, io.exitCode, stdin, callStack)
  if (cleanup === null) return io
  const stderr = concat([await io.materializeStderr(), await cleanup.materializeStderr()])
  return new IOResult({
    stdout: asyncChain([io.stdout, cleanup.stdout]),
    stderr: stderr.byteLength > 0 ? stderr : null,
    exitCode: cleanup.exitCode,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
    refusal: io.refusal,
  })
}

/**
 * Run the whole of a child shell, a pipeline stage or a job, then its EXIT
 * action. An `exit` or a fatal error that ends it carries the action's
 * output and status on out to the boundary containing it.
 */
export async function endShell(
  executeFn: ExecuteStringFn | null,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  body: Promise<[ByteSource | null, IOResult, ExecutionNode]>,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  let stdout: ByteSource | null
  let io: IOResult
  let execNode: ExecutionNode
  try {
    ;[stdout, io, execNode] = await body
  } catch (err) {
    if (err instanceof ExitSignal) {
      const cleanup = await runExitTrap(executeFn, session, err.containedCode, stdin, callStack)
      if (cleanup === null) throw err
      throw new ExitSignal(
        cleanup.exitCode,
        concat([err.stderr, await cleanup.materializeStderr()]),
        concat([err.stdout ?? new Uint8Array(), await cleanup.materializeStdout()]),
      )
    }
    if (err instanceof ReturnSignal) {
      const cleanup = await runExitTrap(executeFn, session, err.exitCode, stdin, callStack)
      if (cleanup === null) throw err
      throw new ReturnSignal(
        cleanup.exitCode,
        concat([err.stderr, await cleanup.materializeStderr()]),
        asyncChain([err.stdout, cleanup.stdout]),
      )
    }
    throw err
  }
  if (session.exitTrap === null || session.exitTrapInherited) return [stdout, io, execNode]
  stdout = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  const cleanup = await runExitTrap(executeFn, session, io.exitCode, stdin, callStack)
  if (cleanup === null) return [stdout, io, execNode]
  io = await io.merge(new IOResult({ stderr: cleanup.stderr }))
  io.exitCode = cleanup.exitCode
  execNode.exitCode = cleanup.exitCode
  return [asyncChain([stdout, cleanup.stdout]), io, execNode]
}

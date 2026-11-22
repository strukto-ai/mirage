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

import { concat } from '../../utils/bytes.ts'
import { asyncChain } from '../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal, ReturnSignal } from '../../shell/errors.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { currentCaller, isProgramInvocation, voiceName } from '../../context/session_context.ts'
import { IGNORED_SIGNALS } from '../../execution/job/constants.ts'
import type { ExecuteFn } from '../expand/types.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecutionNode } from '../types.ts'
import {
  asWritten,
  recordStatus,
  restoreStatus,
  snapshotStatus,
  type Written,
} from './statement.ts'
import { ERR_TRAP_EXEMPT_TYPES, SHELL_IGNORED_SIGNALS, SIGINT } from '../../shell/constants.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'

/**
 * Start a child shell: `( )`, a pipeline stage, a job, `$( )`.
 *
 * The session's `exitTrap` is the `trap ... EXIT` action, '' for an
 * ignored EXIT. A child shell keeps its parent's with `exitTrapInherited`
 * set: it lists it, as bash's `trap -p` does there, and runs none of it
 * until it registers its own. Its signal actions likewise, while a signal its
 * parent ignores stays ignored. It keeps the ERR action hidden unless
 * `set -E` and the RETURN action unless `set -T`, and lists them all the
 * same. It is live shell state, which a session store keeps none of. A
 * background job's ignore (`jobIgnored`) stays only while the child runs in
 * the job's own process (`( trap -p ) &`).
 */
export function inheritTraps(session: SessionState): void {
  const ignores = currentCaller().process?.ignores ?? new Set<number>()
  dropJobIgnores(session, new Set([...session.jobIgnored].filter((signal) => !ignores.has(signal))))
  session.exitTrapInherited = session.exitTrap !== null
  session.signalTrapsInherited = [...session.signalTraps.values()].some((action) => action !== '')
  session.trapStatus = null
  if (session.shellOptions.errtrace !== true) session.errTrapHidden = true
  if (session.shellOptions.functrace !== true) session.returnTrapHidden = true
}

/**
 * Start a background job's shell, or a stage of a background pipeline: with
 * job control off, one that runs commands of its own (`{ trap -p; } &`) lists
 * the INT it ignores, as bash's does, and may trap or reset it; one that runs
 * a single command lists nothing, as bash ignores it only in the program that
 * command runs. Mirrors Python's start_job_traps.
 *
 * @param session the job's shell.
 * @param lists it runs commands of its own.
 */
export function startJobTraps(session: SessionState, lists: boolean): void {
  dropJobIgnores(session, session.jobIgnored)
  if (lists && session.shellOptions.monitor !== true) {
    session.signalTraps = new Map([...session.signalTraps, [SIGINT, '']])
    session.jobIgnored = new Set([SIGINT])
  }
}

/**
 * Stop listing a background job's ignore of `signals`.
 *
 * @param session the shell.
 * @param signals the signals.
 */
function dropJobIgnores(session: SessionState, signals: ReadonlySet<number>): void {
  if (signals.size === 0) return
  session.signalTraps = new Map([...session.signalTraps].filter(([signal]) => !signals.has(signal)))
  session.jobIgnored = new Set([...session.jobIgnored].filter((signal) => !signals.has(signal)))
}

/**
 * Make the shell the one that answers a signal its process gets, as it runs
 * a statement there: one it traps or ignores, it takes
 * (`SessionState.catchSignal`), any other does what it does. A process hosts
 * each shell that runs in place in it in turn (a script, a job's own
 * subshell), so the innermost shell running answers. Mirrors Python's
 * arm_signals.
 */
export function armSignals(session: SessionState): void {
  const process = currentCaller().process
  if (process !== null)
    process.catcher =
      session.signalTraps.size > 0 ? (signal, pid) => session.catchSignal(signal, pid) : null
}

/**
 * Start a new shell (`bash -c`, a script): it has no actions, and ignores for
 * good the signals ignored as it starts: its parent's, and a background job's
 * INT and QUIT (`entryIgnored`).
 */
export function clearTraps(session: SessionState): void {
  session.exitTrap = null
  session.exitTrapInherited = false
  const entry = new Set(
    [...session.signalTraps]
      .filter(([signal, action]) => action === '' && !session.jobIgnored.has(signal))
      .map(([signal]) => signal),
  )
  session.jobIgnored = new Set()
  const process = currentCaller().process
  if (process !== null) {
    const ignored = [...process.ignores].filter((signal) => !SHELL_IGNORED_SIGNALS.has(signal))
    for (const signal of ignored) entry.add(signal)
    if (ignored.some((signal) => IGNORED_SIGNALS.has(signal)))
      for (const signal of IGNORED_SIGNALS) entry.add(signal)
  }
  session.signalTraps = new Map([...entry].sort((a, b) => a - b).map((signal) => [signal, '']))
  session.entryIgnored = entry
  session.signalTrapsInherited = false
  session.pendingSignals = new Set()
  session.trapStatus = null
  session.errTrap = null
  session.returnTrap = null
  session.errTrapHidden = false
  session.returnTrapHidden = false
  session.errTrapRunning = false
  session.returnTrapRunning = false
}

/**
 * Take the caller's ERR and RETURN actions from a function's body unless
 * `set -E` / `set -T`: the body neither runs nor lists them. Returns the
 * actions taken, for `restoreFunctionTraps`.
 */
export function liftFunctionTraps(session: SessionState): [string | null, string | null] {
  let errTrap: string | null = null
  let returnTrap: string | null = null
  if (
    session.errTrap !== null &&
    session.errTrap !== '' &&
    !session.errTrapHidden &&
    session.shellOptions.errtrace !== true
  ) {
    errTrap = session.errTrap
    session.errTrap = null
  }
  if (
    session.returnTrap !== null &&
    session.returnTrap !== '' &&
    !session.returnTrapHidden &&
    session.shellOptions.functrace !== true
  ) {
    returnTrap = session.returnTrap
    session.returnTrap = null
  }
  return [errTrap, returnTrap]
}

/**
 * Give the actions `liftFunctionTraps` took back as the function returns,
 * each unless the body set one of its own, as bash does.
 */
export function restoreFunctionTraps(
  session: SessionState,
  lifted: readonly [string | null, string | null],
): void {
  const [errTrap, returnTrap] = lifted
  if (errTrap !== null && session.errTrap === null) session.errTrap = errTrap
  if (returnTrap !== null && session.returnTrap === null) session.returnTrap = returnTrap
}

/**
 * Whether the ERR action is set and seen here, taken as a statement starts:
 * bash answers a failure only when the action was armed before the command
 * ran, so a function that sets one is not answered for. A line run as a
 * program (`env`, `timeout`, `find -exec`, a `/usr/bin` path) is no shell,
 * so its statements arm nothing: the shell's statement running it answers
 * its failure once.
 */
export function errTrapArmed(session: SessionState): boolean {
  return (
    session.errTrap !== null &&
    session.errTrap !== '' &&
    !session.errTrapHidden &&
    !isProgramInvocation(session)
  )
}

/**
 * Run the ERR action after a statement finished with `status`.
 *
 * It runs where `set -e` would act: not in a test, the left of `&&`/`||`
 * or after `!`, and not again for a group, `if`, a loop, `case` or
 * `&&`/`||` list, whose own failing command ran it already, unless the
 * statement failed to open a redirect and never ran (`execNode.unopened`,
 * which this consumes, so a group returning the same node does not answer
 * the failure again). `$?` is
 * `status` while it runs and again after it, whatever the action returns,
 * and the action does not run while it is running, nor once `set -e` is
 * ending the shell. An `exit` or `return` in it leaves as the statement's
 * would. Hidden in a function or a child shell unless `set -E`, as bash's
 * is. `armed` is `errTrapArmed` as the statement started. Returns what the
 * action wrote, for the caller to land; empty when none runs. Mirrors
 * Python.
 */
export async function runErrTrap(
  executeFn: ExecuteFn | null,
  node: TSNodeLike,
  status: number,
  session: SessionState,
  armed: boolean,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  execNode: ExecutionNode | null = null,
): Promise<Written[]> {
  const action = session.errTrap
  const unopened = execNode?.unopened === true
  if (execNode !== null) execNode.unopened = false
  const statement =
    node.type === NT.REDIRECTED_STATEMENT && node.children[0] !== undefined
      ? node.children[0]
      : node
  if (
    !armed ||
    status === 0 ||
    executeFn === null ||
    action === null ||
    action === '' ||
    session.errTrapHidden ||
    session.errTrapRunning ||
    session.errexitExiting ||
    session.errexitImmune ||
    session.errexitIgnored ||
    (ERR_TRAP_EXEMPT_TYPES.has(statement.type) &&
      !unopened &&
      nodeKind(statement) !== NodeKind.ARITH)
  )
    return []
  session.errTrapRunning = true
  try {
    return await runAction(executeFn, action, 'error trap', session, stdin, callStack)
  } finally {
    session.errTrapRunning = false
  }
}

/**
 * Run the RETURN action as a function or a sourced file returns. It runs in
 * the frames of what is returning, with `$?` as the last command left it;
 * what returns keeps its own status. Hidden in a function or a child shell
 * unless `set -T` or it set its own, and it does not run while it is
 * running, nor once `set -e` is ending the shell. Returns what the action
 * wrote, for the caller to land; empty when none runs. Mirrors Python.
 */
export async function runReturnTrap(
  executeFn: ExecuteFn | null,
  session: SessionState,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Written[]> {
  const action = session.returnTrap
  if (
    executeFn === null ||
    action === null ||
    action === '' ||
    session.returnTrapHidden ||
    session.returnTrapRunning ||
    session.errexitExiting
  )
    return []
  session.returnTrapRunning = true
  try {
    return await runAction(executeFn, action, 'return trap', session, stdin, callStack)
  } finally {
    session.returnTrapRunning = false
  }
}

/**
 * Run the action of each trapped signal that arrived while the last command
 * ran, in signal order, as bash does once that command ends. `$?` is the
 * command's status while each runs and again after it; an `exit` in one ends
 * the shell, a `return` the function it runs in. One that arrives while an
 * action runs waits for the next command boundary after it. Returns what the
 * actions wrote, for the caller to land. Mirrors Python's run_signal_traps.
 */
export async function runSignalTraps(
  executeFn: ExecuteFn | null,
  session: SessionState,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Written[]> {
  if (executeFn === null || session.pendingSignals.size === 0 || session.signalTrapRunning)
    return []
  const written: Written[] = []
  session.signalTrapRunning = true
  try {
    while (session.pendingSignals.size > 0) {
      const signal = Math.min(...session.pendingSignals)
      session.pendingSignals.delete(signal)
      const action = session.signalTraps.get(signal)
      if (action === undefined || action === '' || session.signalTrapsInherited) continue
      written.push(...(await runAction(executeFn, action, 'trap', session, stdin, callStack)))
    }
  } finally {
    session.signalTrapRunning = false
  }
  return written
}

/**
 * Run a trap action as a line of the shell and collect its output. `$?` and
 * `${PIPESTATUS[@]}` are as they were again after it, whatever the action
 * returns, and what the action runs in a test or after `!` leaves the
 * `set -e` answer for the statement it answers as it was. A failure `set -e`
 * acts on in it ends the shell with its status, and an `exit` or `return` in
 * it leaves with what it wrote, for the redirects of its statement to route.
 * A syntax error in it leads with `bash: <name>: `, `name` being `error
 * trap`, `return trap` or `trap` for a signal's.
 */
async function runAction(
  executeFn: ExecuteFn,
  action: string,
  name: string,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Written[]> {
  const held = snapshotStatus(session)
  const immune = session.errexitImmune
  const outerHead = session.parseHead
  session.parseHead = `${voiceName(session)}: ${name}: `
  let io: IOResult
  try {
    io = await executeFn(action, {
      sessionId: session.sessionId,
      session,
      stdin,
      callStack: callStack ?? new CallStack(session.shellNesting),
    })
  } catch (err) {
    if (err instanceof ExitSignal || err instanceof ReturnSignal) err.unrouted = true
    throw err
  } finally {
    session.errexitImmune = immune
    session.parseHead = outerHead
  }
  const stdout = await materialize(io.stdout)
  const stderr = await io.materializeStderr()
  if (session.errexitExiting) {
    const ended = new ExitSignal(io.exitCode, stderr, stdout)
    ended.unrouted = true
    throw ended
  }
  restoreStatus(session, held, session.statusWriter)
  return asWritten(stdout, stderr)
}

/**
 * Run the shell's EXIT action as the shell ends with `status`.
 *
 * bash clears the action before it runs it, and an `exit` in it, or one
 * it registers there, does not run again. `$?` starts at `status`, and a
 * bare `exit` keeps it. The status the shell ends with stays `status`
 * unless the action exits, or fails where `set -e` acts (not in a test,
 * the left of `&&`/`||` or after `!`), which exits too; its commands
 * answer ERR and RETURN afresh. Hard stops (cancellation, a killed job, a
 * closed workspace) are not an end the shell reaches, and never get here.
 * `callStack` holds the frames the action runs in: the function that
 * called `exit` is still on them. Returns null when no action of this
 * shell's own is set.
 */
export async function runExitTrap(
  executeFn: ExecuteFn | null,
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
  const saved = session.trapStatus
  session.trapStatus = status
  const outerHead = session.parseHead
  session.parseHead = `${voiceName(session)}: exit trap: `
  const exiting = session.errexitExiting
  session.errexitExiting = false
  let final = status
  let stdout: Uint8Array
  let stderr: Uint8Array
  try {
    const io = await executeFn(action, {
      sessionId: session.sessionId,
      session,
      stdin,
      callStack: callStack ?? new CallStack(session.shellNesting),
    })
    stdout = await materialize(io.stdout)
    stderr = await io.materializeStderr()
    if (io.exitCode !== 0 && session.shellOptions.errexit === true && !session.errexitImmune)
      final = io.exitCode
  } catch (err) {
    if (err instanceof ExitSignal) {
      stdout = await materialize(err.stdout)
      stderr = err.stderr
      // A substitution bash cannot parse ends the action, not the status.
      final = err.refused ? status : err.exitCode
    } else if (err instanceof ReturnSignal) {
      stdout = await materialize(err.stdout)
      stderr = err.stderr
    } else {
      throw err
    }
  } finally {
    session.trapStatus = saved
    session.parseHead = outerHead
    session.errexitExiting = exiting
    session.exitTrap = null
    session.exitTrapInherited = false
  }
  recordStatus(session, final)
  return new IOResult({ stdout, stderr: stderr.byteLength > 0 ? stderr : null, exitCode: final })
}

/**
 * End a child shell whose line returned `io`: a `bash -c`, a script, a
 * `$( )`. Its EXIT action runs after what it wrote, then the process
 * substitutions it kept run out, as its descriptors close.
 */
export async function finishShell(
  executeFn: ExecuteFn | null,
  session: SessionState,
  io: IOResult,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<IOResult> {
  const cleanup = await runExitTrap(executeFn, session, io.exitCode, stdin, callStack)
  await session.endSubstitutions()
  if (cleanup === null) return io
  const stderr = concat([await io.materializeStderr(), await cleanup.materializeStderr()])
  return new IOResult({
    stdout: asyncChain([io.stdout, cleanup.stdout]),
    stderr: stderr.byteLength > 0 ? stderr : null,
    exitCode: cleanup.exitCode,
    decision: io.decision,
  })
}

/**
 * Run the whole of a child shell, a pipeline stage or a job, then its EXIT
 * action, then let the process substitutions it kept run out. An `exit` or a
 * fatal error that ends it carries the action's
 * output and status on out to the boundary containing it.
 */
export async function endShell(
  executeFn: ExecuteFn | null,
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
      await session.endSubstitutions()
      if (cleanup !== null) {
        err.stdout = asyncChain([err.stdout, cleanup.stdout])
        err.stderr = concat([err.stderr, await cleanup.materializeStderr()])
        err.exitCode = err.containedCode = cleanup.exitCode
      }
    } else if (err instanceof ReturnSignal) {
      const cleanup = await runExitTrap(executeFn, session, err.exitCode, stdin, callStack)
      await session.endSubstitutions()
      if (cleanup !== null)
        throw new ReturnSignal(
          cleanup.exitCode,
          concat([err.stderr, await cleanup.materializeStderr()]),
          asyncChain([err.stdout, cleanup.stdout]),
        )
    }
    throw err
  }
  if (
    (session.exitTrap === null || session.exitTrapInherited) &&
    session.substitutions.length === 0
  )
    return [stdout, io, execNode]
  stdout = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  const cleanup = await runExitTrap(executeFn, session, io.exitCode, stdin, callStack)
  await session.endSubstitutions()
  if (cleanup === null) return [stdout, io, execNode]
  io = await io.merge(new IOResult({ stderr: cleanup.stderr }))
  io.exitCode = cleanup.exitCode
  execNode.exitCode = cleanup.exitCode
  return [asyncChain([stdout, cleanup.stdout]), io, execNode]
}

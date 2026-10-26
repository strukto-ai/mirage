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

import { YieldBudget } from '../io/yield_budget.ts'
import { makeAbortError } from '../utils/abort.ts'
import {
  type CallerDispatchFn,
  currentCaller,
  lineFrames,
  runWithCaller,
} from '../context/session_context.ts'
import type { StatusWriter } from './types.ts'
import type { SessionState } from './session/session.ts'

/**
 * Run `fn` as the body of the line `signal` belongs to. Everything the
 * body awaits, down to the status write, can then ask `abortedLine`
 * whether its caller is still waiting, without the signal being threaded
 * through every handler. `shell` is the only caller.
 */
export function runWithLineAbort<T>(
  signal: AbortSignal | undefined,
  sessions: readonly SessionState[],
  writer: StatusWriter,
  fn: () => Promise<T>,
  stop?: AbortSignal,
): Promise<T> {
  return runWithCaller(
    {
      ...currentCaller(),
      lineAbort: { signal, sessions, writer, ...(stop === undefined ? {} : { stop }) },
    },
    fn,
  )
}

/**
 * The identity of the line stamping on `session`, for `recordStatus` to
 * record and an aborted line to compare its snapshot against.
 *
 * Null when no line is running (a background job, a test driving a
 * handler directly) and null when more than one line is live on this
 * session, which is the case the comparison exists to refuse: with two
 * writers in play nothing can attribute the last stamp, so an aborted
 * line declines to restore rather than guess.
 */
export function lineStatusWriter(session: SessionState): StatusWriter | null {
  const frames = lineFrames().filter((f) => f.sessions.includes(session))
  return frames.length === 1 ? (frames[0]?.writer ?? null) : null
}

/**
 * The aborted signal of the line stamping on `session`, or undefined
 * when that line is still wanted, or when no line is running at all (a
 * background job, a test driving a handler directly): nobody is
 * waiting there and nothing is an orphan.
 *
 * Read from every live frame for the session rather than the newest
 * frame. On an isolating runtime the live frames are the current task's
 * alone, so the answer is exact. On the browser fallback the newest
 * frame may belong to another line that happens to overlap, so the status write
 * refuses only when every live line on this session has aborted: one
 * line's abort never reaches a concurrent line's statement, and the one
 * case left open is two aborted-or-not lines overlapping on one session
 * without task isolation, where the fallback cannot tell them apart.
 */
export function abortedLine(session: SessionState): AbortSignal | undefined {
  const frames = lineFrames().filter((f) => f.sessions.includes(session))
  if (frames.length === 0) return undefined
  const aborted = frames.filter((f) => f.signal?.aborted === true)
  return aborted.length === frames.length ? aborted[0]?.signal : undefined
}

/**
 * A dispatch that refuses to start an op once `signal` has fired. A
 * cancelled asyncio task unwinds at its next await, so a Python handler
 * that loops over operands (`rm link1 link2`, `chmod`, `touch`) never
 * reaches the next one. A JS handler resumes after the await that was in
 * flight when the caller was released and would begin the next write.
 * Refusing at the dispatcher, the one seam every handler's I/O goes through,
 * stops it there without threading the signal through each handler. An
 * op already in flight settles on its own.
 *
 * The command's ops also share one yield budget: a walk the index answers
 * resolves each op in a microtask, which no timer or abort ever runs between,
 * so the budget hands the loop a task-queue turn every few milliseconds and
 * the abort or timeout that fired there refuses the next op. Python's
 * dispatcher spends the running task's budget, `task_turn`, the same way.
 * The ops a command issues at once (the patterns of one grep) take the first
 * one's answer, a turn or none, and go on together, as the tasks Python
 * gathers start on budgets of their own: a turn each would let one op finish
 * all it resolves without I/O before the next starts, and share nothing in
 * flight with it.
 */
export function guardDispatch(
  dispatch: CallerDispatchFn,
  signal: AbortSignal | undefined,
): CallerDispatchFn {
  const budget = new YieldBudget()
  let together: Promise<void> | undefined | null = null
  return (op, path, args, kwargs, report, caller) => {
    if (signal?.aborted === true) return Promise.reject(makeAbortError(signal))
    if (together === null) {
      together = budget.run()
      queueMicrotask(() => {
        together = null
      })
    }
    const pending = together
    if (pending === undefined) return dispatch(op, path, args, kwargs, report, caller)
    return pending.then(() => {
      if (signal?.aborted === true) throw makeAbortError(signal)
      return dispatch(op, path, args, kwargs, report, caller)
    })
  }
}

/** A fresh line identity. */
export function newStatusWriter(): StatusWriter {
  return Symbol('line')
}

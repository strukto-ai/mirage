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

import { makeAbortError } from '../utils/abort.ts'
import type { StatusWriter } from './types.ts'
import type { DispatchFn } from '../runtime/types.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import type { SessionState } from './session/session.ts'

/**
 * One running line: its signal and the sessions its statements stamp
 * on (the target session and the per-call fork, one object when the
 * call named no cwd or env). Bound by `shell` for the line's duration
 * and read at the status door. It rides the async context rather than
 * the session, so two lines on one session each see their own, and a
 * statement that settles after its caller was released still reads the
 * signal of the line that produced it.
 */
interface LineAbortFrame {
  signal: AbortSignal | undefined
  sessions: readonly SessionState[]
  writer: StatusWriter
}

const lineAbortContext = createAsyncContext<LineAbortFrame>()

/**
 * Run `fn` as the body of the line `signal` belongs to. Everything the
 * body awaits, down to the status door, can then ask `abortedLine`
 * whether its caller is still waiting, without the signal being threaded
 * through every handler. `shell` is the only caller.
 */
export function runWithLineAbort<T>(
  signal: AbortSignal | undefined,
  sessions: readonly SessionState[],
  writer: StatusWriter,
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(lineAbortContext.run({ signal, sessions, writer }, fn))
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
  const frames = lineAbortContext.liveStores().filter((f) => f.sessions.includes(session))
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
 * frame may belong to another line that happens to overlap, so the door
 * refuses only when every live line on this session has aborted: one
 * line's abort never reaches a concurrent line's statement, and the one
 * case left open is two aborted-or-not lines overlapping on one session
 * without task isolation, where the fallback cannot tell them apart.
 */
export function abortedLine(session: SessionState): AbortSignal | undefined {
  const frames = lineAbortContext.liveStores().filter((f) => f.sessions.includes(session))
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
 * Refusing at the op door, the one seam every handler's I/O goes through,
 * stops it there without threading the signal through each handler. An
 * op already in flight settles on its own.
 */
export function guardDispatch(dispatch: DispatchFn, signal: AbortSignal | undefined): DispatchFn {
  if (signal === undefined) return dispatch
  return (op, path, args, kwargs, report) => {
    if (signal.aborted) return Promise.reject(makeAbortError(signal))
    return dispatch(op, path, args, kwargs, report)
  }
}

/** A fresh line identity. */
export function newStatusWriter(): StatusWriter {
  return Symbol('line')
}

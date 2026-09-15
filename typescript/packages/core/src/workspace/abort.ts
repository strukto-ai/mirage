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

import type { DispatchFn } from '../runtime/types.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import type { Session, StatusWriter } from './session/session.ts'

/**
 * One running line: its signal and the sessions its statements stamp
 * on (the target session and the per-call fork, one object when the
 * call named no cwd or env). Bound by `execute` for the line's duration
 * and read at the status door. It rides the async context rather than
 * the session, so two lines on one session each see their own, and a
 * statement that settles after its caller was released still reads the
 * signal of the line that produced it.
 */
interface LineAbortFrame {
  signal: AbortSignal | undefined
  sessions: readonly Session[]
  writer: StatusWriter
}

const lineAbortContext = createAsyncContext<LineAbortFrame>()

/**
 * Run `fn` as the body of the line `signal` belongs to. Everything the
 * body awaits, down to the status door, can then ask `abortedLine`
 * whether its caller is still waiting, without the signal being threaded
 * through every handler. `execute` is the only caller.
 */
export function runWithLineAbort<T>(
  signal: AbortSignal | undefined,
  sessions: readonly Session[],
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
export function lineStatusWriter(session: Session): StatusWriter | null {
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
export function abortedLine(session: Session): AbortSignal | undefined {
  const frames = lineAbortContext.liveStores().filter((f) => f.sessions.includes(session))
  if (frames.length === 0) return undefined
  const aborted = frames.filter((f) => f.signal?.aborted === true)
  return aborted.length === frames.length ? aborted[0]?.signal : undefined
}

/**
 * The one error an aborted invocation rejects with. A signal's own reason
 * rides along as `cause` (a caller's `abort(x)`, a timeout's TimeoutError)
 * so every gate keys on one name and the caller still sees why.
 */
export function makeAbortError(signal?: AbortSignal): DOMException {
  const reason: unknown = signal?.aborted === true ? signal.reason : undefined
  // Always a fresh wrapper, even when the reason is itself an AbortError
  // (a plain `abort()`): the contract is one name and the reason under
  // `cause`, and a caller reading `cause` must find it on every path.
  const error = new DOMException('execute aborted', 'AbortError')
  if (reason !== undefined) {
    Object.defineProperty(error, 'cause', { value: reason, configurable: true, writable: true })
  }
  return error
}

/**
 * Whether the signal has fired. A call rather than a property read, so a
 * check that comes after an earlier one is not narrowed away as stale.
 */
export function hasAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** Fold two optional abort signals into one; either aborting aborts. */
export function mergeSignals(
  a: AbortSignal | null | undefined,
  b: AbortSignal | null | undefined,
): AbortSignal | undefined {
  if (a != null && b != null) return AbortSignal.any([a, b])
  return a ?? b ?? undefined
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(makeAbortError())
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer)
      reject(makeAbortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Settle with `promise`, or reject as an abort as soon as `signal` fires. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    // The promise is still ours to settle; a later rejection with no
    // listener would surface as an unhandled error.
    void promise.catch(() => undefined)
    return Promise.reject(makeAbortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(makeAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
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

/** How long a cancelled tree gets to unwind before the caller is released anyway. */
export const ABORT_JOIN_MS = 250

/**
 * The twin of Python's `run_cancellable`: cancel, then join. A cancelled
 * asyncio task unwinds at its next await, so Python joins it fully. A JS
 * promise cannot be cancelled, so once `signal` fires the tree is given
 * `graceMs` to reach a checkpoint, close its producers and settle with
 * its own error (which keeps the caller's abort reason); a leaf that is
 * blocked past that is left running and the caller is released.
 */
export async function joinOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  graceMs = ABORT_JOIN_MS,
): Promise<T> {
  if (signal === undefined) return promise
  try {
    return await abortable(promise, signal)
  } catch (error) {
    if (!signal.aborted) throw error
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(makeAbortError(signal))
      }, graceMs)
    })
    try {
      return await Promise.race([promise, grace])
    } finally {
      clearTimeout(timer)
    }
  }
}

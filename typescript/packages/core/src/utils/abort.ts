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

// `setTimeout` holds a 32-bit signed delay, so anything longer is not merely
// imprecise: node warns (`TimeoutOverflowWarning`) and clamps it to 1ms, which
// turns a long wait into an immediate return. 2147483647ms is just under 25
// days, which python's `asyncio.sleep` reaches without a word, so a delay past
// it is served by re-arming rather than by one timer. `tail`'s own pause
// (commands/builtin/generic/tail.ts) documents the infinite case of the same
// trap.
const MAX_TIMEOUT_MS = 2_147_483_647

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(makeAbortError())
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let left = ms
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer)
      reject(makeAbortError())
    }
    const arm = (): void => {
      const step = Math.min(left, MAX_TIMEOUT_MS)
      left -= step
      timer = setTimeout(() => {
        if (left > 0) {
          arm()
          return
        }
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, step)
    }
    arm()
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

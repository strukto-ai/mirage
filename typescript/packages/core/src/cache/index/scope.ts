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

import { type ContextCall, createAsyncContext } from '../../utils/async_context.ts'

let sequence = 0
const started = createAsyncContext<number>()

/**
 * The next point in the one order commands and listing writes share.
 *
 * A sequence rather than a clock: two events in the same clock tick still
 * come out ordered, so "written after this command started" is exact.
 */
export function tick(): number {
  sequence += 1
  return sequence
}

/**
 * When the running command started, or null outside any command.
 *
 * On an isolating runtime that is the current task's stamp. On the
 * fallback storage another command's frame can sit on top, so this
 * answers the latest live stamp: a later stamp trusts fewer listings,
 * which fails toward a re-list rather than toward a stale one.
 */
export function commandStarted(): number | null {
  const stamps = started.liveStores()
  return stamps.length === 0 ? null : Math.max(...stamps)
}

/**
 * The running command's own stamp, for a check that it fetched a listing.
 *
 * On an isolating runtime that is `commandStarted`. On the fallback storage
 * the latest live stamp may be another command's, so with more than one
 * command live this answers null: no listing is proven the caller's own. A
 * replayed scope (a command's output drained later) repeats its own stamp,
 * so stamps are counted once each. Mirrors Python's `sole_command_started`.
 */
export function soleCommandStarted(): number | null {
  const stamps = new Set(started.liveStores())
  return stamps.size === 1 ? (stamps.values().next().value ?? null) : null
}

/**
 * Mark one command's run, so a fresh listing it writes can be trusted.
 *
 * Entered before the command's words expand, so its own globs count. A
 * nested command (a `$(...)`, a function body) gets its own later stamp,
 * and the outer one comes back when it ends.
 */
export function runInCommandScope<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(started.run(tick(), fn))
}

/**
 * Keep the running command's stamp while its lazy output is read.
 *
 * Python's stream wrapper copies the whole context, stamp included; here
 * each storage is captured by name, so a stream a command hands back
 * would otherwise drain as an unscoped read, trusting only listings from
 * the last second rather than the ones its own command wrote.
 */
export function captureCommandScope(): ContextCall {
  return started.capture()
}

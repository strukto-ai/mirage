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

import {
  RANDOM_A,
  RANDOM_M,
  RANDOM_MAX,
  RANDOM_MODULUS,
  RANDOM_Q,
  RANDOM_R,
  RANDOM_ZERO_SEED,
} from '../../shell/constants.ts'

/** A first seed for a session that was never assigned one: the clock,
 * stirred with the session id so two sessions born in one tick differ. */
export function initialSeed(sessionId: string): number {
  let hash = 0
  for (const ch of sessionId) hash = (Math.imul(hash, 31) + (ch.codePointAt(0) ?? 0)) >>> 0
  return ((Date.now() % RANDOM_MODULUS) ^ hash) >>> 0
}

/** One step of bash's generator (`intrand32`): Park-Miller through
 * Schrage's method, a zero state stepping from the fixed seed. */
export function stepState(state: number): number {
  const ret = state === 0 ? RANDOM_ZERO_SEED : state
  const high = Math.floor(ret / RANDOM_Q)
  const low = ret - RANDOM_Q * high
  const step = RANDOM_A * low - RANDOM_R * high
  return step < 0 ? step + RANDOM_M : step
}

/** The `$RANDOM` value a state renders as (`brand`): the two 16-bit
 * halves folded, keeping 15 bits. */
export function valueOf(state: number): number {
  return ((state >>> 16) ^ (state & 0xffff)) & RANDOM_MAX
}

/** One `$RANDOM` draw: step until the value differs from the last one,
 * as bash's `get_random` does, and return the new state with it. `last`
 * is 0 after a seed. */
export function draw(state: number, last: number): [number, number] {
  for (;;) {
    state = stepState(state)
    const value = valueOf(state)
    if (value !== last) return [state, value]
  }
}

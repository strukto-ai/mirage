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
  RANDOM_Q,
  RANDOM_R,
  RANDOM_ZERO_SEED,
} from '../../shell/constants.ts'
import type { IdSource } from '../../utils/ids.ts'

/** A first seed for a generator never assigned one, drawn from the
 * workspace's id source, so every generator starts somewhere else, as
 * bash's mixes in the time and each shell's own pid, and a seeded
 * workspace replays it. */
export function initialSeed(ids: IdSource): number {
  return ids.randomU32()
}

/** One step of bash's RANDOM generator: Park-Miller through
 * Schrage's method, a zero state stepping from the fixed seed. */
export function stepState(state: number): number {
  const ret = state === 0 ? RANDOM_ZERO_SEED : state
  const high = Math.floor(ret / RANDOM_Q)
  const low = ret - RANDOM_Q * high
  const step = RANDOM_A * low - RANDOM_R * high
  return step < 0 ? step + RANDOM_M : step
}

/** The `$RANDOM` value a state renders as in bash: the two 16-bit
 * halves folded, keeping 15 bits. */
export function valueOf(state: number): number {
  return ((state >>> 16) ^ (state & 0xffff)) & RANDOM_MAX
}

/** One `$RANDOM` draw: step until the value differs from the last one,
 * as bash does, and return the new state with it. `last`
 * is 0 after a seed. */
export function draw(state: number, last: number): [number, number] {
  for (;;) {
    state = stepState(state)
    const value = valueOf(state)
    if (value !== last) return [state, value]
  }
}

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

import { type MockInstance, vi } from 'vitest'

/**
 * Move performance.now() forward for the listing window without freezing it.
 *
 * The rate limiter and the yield budget read the same clock, so a frozen one
 * stalls them; this keeps it running and adds an offset. Restore with
 * vi.restoreAllMocks() or the returned spy.
 */
export function shiftPerformanceNow(): {
  advance: (ms: number) => void
  spy: MockInstance<() => number>
} {
  const real = performance.now.bind(performance)
  let offset = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + offset)
  return {
    advance: (ms) => {
      offset += ms
    },
    spy,
  }
}

export { SettleRecorder, settling, type Settled } from '../test-utils.ts'

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

/** Wall time for timestamps and monotonic time for durations, in seconds. */
export interface Clock {
  /** Seconds since the unix epoch. */
  now(): number
  /** Seconds from an arbitrary origin that never moves backwards. */
  monotonic(): number
}

/** Platform clock used when no clock is supplied. */
export class SystemClock implements Clock {
  /** Seconds since the unix epoch. */
  now(): number {
    return Date.now() / 1000
  }

  /** Seconds from an arbitrary origin that never moves backwards. */
  monotonic(): number {
    return performance.now() / 1000
  }
}

/** Clock advanced explicitly by the caller. Readings have no side effects. */
export class ManualClock implements Clock {
  private wall: number
  private mono = 0

  /** @param start initial wall time in seconds; monotonic starts at zero. */
  constructor(start = 0) {
    this.wall = start
  }

  /** Seconds on the virtual wall clock. */
  now(): number {
    return this.wall
  }

  /** Seconds on the virtual monotonic clock. */
  monotonic(): number {
    return this.mono
  }

  /**
   * Move the clock forward by `seconds`.
   *
   * @param seconds how far forward to move; must not be negative, since
   *   a monotonic reading may not go back.
   */
  advance(seconds: number): void {
    if (seconds < 0) throw new RangeError('cannot advance a clock backwards')
    this.wall += seconds
    this.mono += seconds
  }
}

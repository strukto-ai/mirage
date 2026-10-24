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

import type { ReadSpec } from '../types.ts'
import type { Clock } from '../utils/clock.ts'
import type { ResponseCache } from './responses.ts'

export class Accessor {
  [key: string]: unknown

  /** Release what this accessor holds, when it holds anything. */
  close?(): Promise<void>

  /** Share what a peer on the same account holds (the workspace's other accessors). */
  join?(peers: readonly Accessor[]): void

  /**
   * Whether a write through this accessor may change what `peer` reads. One
   * that does not say may reach anything.
   */
  reaches?(peer: Accessor): boolean

  /** The answers this accessor keeps of its own service. */
  caches?(): readonly ResponseCache<unknown, unknown>[]

  /** Keep this accessor's own answers under a mount's read policy. */
  govern?(read: ReadSpec): void {
    for (const cache of this.caches?.() ?? []) cache.govern(read)
  }

  /** Drop this accessor's own answers, as its mount drops its caches. */
  forget?(): void {
    for (const cache of this.caches?.() ?? []) cache.clear()
  }

  /**
   * Read time and wait on the clock of the workspace it serves; one that
   * does not say reads none.
   */
  bindClock?(clock: Clock): void
}

/** The accessor of a mount or CLI with no client of its own. */
export class NOOPAccessor extends Accessor {
  constructor(readonly config: unknown = null) {
    super()
  }
}

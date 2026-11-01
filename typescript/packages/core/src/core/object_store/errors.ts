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

import type { Measured } from '../../cache/types.ts'

/** What a refusal carries besides its keys. Mirrors Python's keyword arguments. */

/**
 * A conditional request the store refused: the object changed since the
 * version sent, so the write did not land. Mirrors Python's ConditionLostError.
 */
export class ConditionLostError extends Error {
  readonly landed: boolean
  readonly gone: boolean
  readonly versions: ReadonlyMap<string, Measured>
  readonly error: unknown
  readonly recovered: boolean | null
  readonly recoveryError: unknown
  readonly recoveryReason: string | null

  /** @param keys the raw keys whose condition did not hold, in order met */
  constructor(
    readonly keys: readonly string[],
    options: {
      /** A move's copy landed before its source delete lost; recovered records compensation. */
      readonly landed?: boolean
      /** The object no longer exists. */
      readonly gone?: boolean
      /** The version each lost key was measured on, where the op knew it; ABSENT, for one found gone, keeps what the session last saw. */
      readonly versions?: ReadonlyMap<string, Measured>
      /** A later failure that stopped a walk after these keys were lost; the caller keeps their versions and throws it. */
      readonly error?: unknown
      /** Whether the copied destination was reverted; null for other operations. */
      readonly recovered?: boolean | null
      /** A secondary cleanup failure, without replacing the source failure. */
      readonly recoveryError?: unknown
      readonly recoveryReason?: string | null
    } = {},
  ) {
    super(`condition lost on '${keys[0] ?? ''}'`)
    this.name = 'ConditionLostError'
    this.landed = options.landed ?? false
    this.gone = options.gone ?? false
    this.versions = options.versions ?? new Map()
    this.error = options.error ?? null
    this.recovered = options.recovered ?? null
    this.recoveryError = options.recoveryError ?? null
    this.recoveryReason = options.recoveryReason ?? null
  }
}

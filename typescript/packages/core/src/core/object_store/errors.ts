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
export interface LostOptions {
  /** A move's copy landed and only its source's delete lost, so the destination holds the copy. */
  readonly landed?: boolean
  /** The object no longer exists, so no newer bytes are there for a retry to overwrite. */
  readonly gone?: boolean
  /** The version each lost key was measured on, where the op knew it; ABSENT keeps none. */
  readonly versions?: ReadonlyMap<string, Measured>
  /** A later failure that stopped a walk after these keys were lost; the caller keeps their versions and throws it. */
  readonly error?: unknown
}

/**
 * A conditional request the store refused: the object changed since the
 * version sent, so the write did not land. Mirrors Python's ConditionLostError.
 */
export class ConditionLostError extends Error {
  readonly landed: boolean
  readonly gone: boolean
  readonly versions: ReadonlyMap<string, Measured>
  readonly error: unknown

  /** @param keys the raw keys whose condition did not hold, in order met */
  constructor(
    readonly keys: readonly string[],
    options: LostOptions = {},
  ) {
    super(`condition lost on '${keys[0] ?? ''}'`)
    this.name = 'ConditionLostError'
    this.landed = options.landed ?? false
    this.gone = options.gone ?? false
    this.versions = options.versions ?? new Map()
    this.error = options.error ?? null
  }
}

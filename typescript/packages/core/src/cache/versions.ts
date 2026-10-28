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

import type { OpRecord } from '../observe/record.ts'
import {
  CONTENT_CHANGING_OPS,
  RETRACT_FINGERPRINT_OPS,
  STAMP_FINGERPRINT_OPS,
  SUBTREE_RETRACT_OPS,
} from '../observe/record.ts'
import { underPath } from '../utils/key_prefix.ts'

/** Identity of one live mount; never persisted. */
export class VersionScope {
  readonly pins = new Map<string, string>()
}

/** A live session's observations, independent of shared cache eviction. */
export class VersionHistory {
  private readonly scopes = new WeakMap<
    VersionScope,
    Map<string, [OpRecord, string | null] | string | null>
  >()

  /** Return the token observed for this mount-relative key. */
  read(scope: VersionScope, key: string): string | null {
    const entries = this.scopes.get(scope)
    const held = entries?.has(key) === true ? entries.get(key) : scope.pins.get(key)
    if (!Array.isArray(held)) return held ?? null
    const [rec, previous] = held
    if (rec.op === 'read' && rec.bytes === 0 && rec.fingerprint === null) return previous
    return rec.fingerprint
  }

  /** Retain a refused condition until this session reads again. */
  keep(scope: VersionScope, key: string, version: string | null): void {
    const held =
      this.scopes.get(scope) ?? new Map<string, [OpRecord, string | null] | string | null>()
    held.set(key, version)
    this.scopes.set(scope, held)
  }

  /** Keep the exact record, including a stream's later token stamp. */
  observe(scope: VersionScope, key: string, rec: OpRecord): void {
    if (
      !STAMP_FINGERPRINT_OPS.has(rec.op) &&
      !RETRACT_FINGERPRINT_OPS.has(rec.op) &&
      !CONTENT_CHANGING_OPS.has(rec.op)
    )
      return
    const held =
      this.scopes.get(scope) ?? new Map<string, [OpRecord, string | null] | string | null>()
    if (SUBTREE_RETRACT_OPS.has(rec.op)) {
      for (const name of new Set([...held.keys(), ...scope.pins.keys()]))
        if (underPath(name, key)) held.set(name, null)
    }
    if (STAMP_FINGERPRINT_OPS.has(rec.op)) {
      // An unopened or failed stream has observed neither bytes nor a token.
      // Keep the prior condition until its record proves a read.
      held.set(key, [rec, this.read(scope, key)])
    } else held.set(key, null)
    this.scopes.set(scope, held)
  }
}

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

import { CONTENT_CHANGING_OPS, RETRACT_FINGERPRINT_OPS, STAMP_FINGERPRINT_OPS, SUBTREE_RETRACT_OPS, OpRecord } from '../observe/record.ts'
import { underPath } from '../utils/key_prefix.ts'

/** Identity shared by live mounts of one VFS; never persisted. */
export class VersionScope {
  readonly pins = new Map<string, string>()
}

/** A live session's observations, independent of shared cache eviction. */
export class VersionHistory {
  private readonly scopes = new WeakMap<VersionScope, Map<string, OpRecord | string | null>>()

  /** Return the token observed for this mount-relative key. */
  read(scope: VersionScope, key: string): string | null {
    const entries = this.scopes.get(scope)
    const held = entries?.has(key) === true ? entries.get(key) : scope.pins.get(key)
    return held instanceof OpRecord ? held.fingerprint : (held ?? null)
  }

  /** Retain a refused condition until this session reads again. */
  keep(scope: VersionScope, key: string, version: string | null): void {
    const held = this.scopes.get(scope) ?? new Map<string, OpRecord | string | null>()
    held.set(key, version)
    this.scopes.set(scope, held)
  }

  /** Keep the exact record, including a stream's later token stamp. */
  observe(scope: VersionScope, key: string, rec: OpRecord): void {
    if (!STAMP_FINGERPRINT_OPS.has(rec.op) && !RETRACT_FINGERPRINT_OPS.has(rec.op) && !CONTENT_CHANGING_OPS.has(rec.op)) return
    const held = this.scopes.get(scope) ?? new Map<string, OpRecord | string | null>()
    if (SUBTREE_RETRACT_OPS.has(rec.op)) {
      for (const name of new Set([...held.keys(), ...scope.pins.keys()])) if (underPath(name, key)) held.set(name, null)
    }
    if (STAMP_FINGERPRINT_OPS.has(rec.op)) held.set(key, rec)
    else held.set(key, null)
    this.scopes.set(scope, held)
  }
}

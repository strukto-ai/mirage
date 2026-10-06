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

import type { Refusal } from '../types.ts'

/**
 * A policy returned something a hook may not return. Raised loudly at
 * the seam (never silently dropped): an illegal Action kind for the
 * hook, or a value that is not an Action at all, is a programming
 * error in the policy, not a refusal.
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

/**
 * A dry run reached the op gate: the door stops there, before any backend
 * or cache is touched, with what the gate would answer noted for
 * `session.explain.vfs`. Mirrors the Python `Explained`.
 */
export class Explained extends Error {
  constructor() {
    super('explained')
    this.name = 'Explained'
  }
}

/**
 * An op or a session write refused by an admission policy at a door.
 * Shaped like the FsError stamps (`code` EACCES plus the virtual path)
 * so every fs chokepoint renders GNU's "Permission denied" and the FUSE
 * bridge classifies it to -EACCES; the distinct class lets handlers that
 * special-case mount-mode refusals (the read-only wording) tell a
 * policy deny apart.
 *
 * The message says what the terminal would (`Permission denied` at an
 * op door, `<name>: permission denied` at the session door), and the
 * policy's own words ride `refusal`, never the message, so a door that
 * renders the error stays byte-identical to a plain EACCES and a door
 * that hands the agent text appends the record's line. `refusal` is
 * null for a door that refuses on no policy's behalf (a hidden
 * variable).
 *
 * It carries no accounting: a postOps refusal suppresses the result,
 * not the effect, and the door reports the completed op through the
 * caller's `OpReport`, which covers this error and any foreign one the
 * same way.
 */
export class PolicyDenied extends Error {
  readonly code = 'EACCES'
  readonly virtualPath: string
  readonly refusal: Refusal | null

  constructor(message: string, virtualPath: string, refusal: Refusal | null = null) {
    super(message)
    this.name = 'PolicyDenied'
    this.virtualPath = virtualPath
    this.refusal = refusal
  }
}

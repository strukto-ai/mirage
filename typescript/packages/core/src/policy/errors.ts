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

/**
 * A policy is misconfigured or answered with an illegal shape.
 *
 * The programming-error class, never a refusal: an illegal Action
 * kind for the hook, a value that is not an Action at all, an unknown
 * runtime name from a Route, or a routing script that does not parse.
 * Raised loud at the seam and propagated to the caller instead of
 * folding into the line's result like a command failure; a hook that
 * throws it is reporting a caller-fixable mistake, so the fail-closed
 * conversion does not apply.
 */
export class PolicyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PolicyError'
  }
}

/**
 * The policy refused the line before anything ran.
 *
 * A legitimate policy outcome, not a mistake: execute() folds it into
 * the line's result (exit 126, the reason on stderr) instead of
 * propagating like PolicyError.
 */
export class PolicyDeny extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PolicyDeny'
  }
}

/**
 * An op refused by an admission policy at the op door. Shaped like the
 * FsError stamps (`code` EACCES plus the virtual path) so every fs
 * chokepoint renders GNU's "Permission denied" and the FUSE bridge
 * classifies it to -EACCES; the distinct class lets handlers that
 * special-case mount-mode refusals (the read-only wording) tell a
 * policy deny apart.
 */
export class PolicyDenied extends Error {
  readonly code = 'EACCES'
  readonly virtualPath: string

  constructor(message: string, virtualPath: string) {
    super(message)
    this.name = 'PolicyDenied'
    this.virtualPath = virtualPath
  }
}

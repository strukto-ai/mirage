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

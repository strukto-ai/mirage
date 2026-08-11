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
 *
 * `completed` says whether the refused op had already run against the
 * backend: a postOps deny suppresses the result, not the effect, so
 * the door's caller must still account for the op (the fs facade
 * records it). A preOps deny leaves it false, the constructed default.
 *
 * `fromCache` says the completed op was answered from the file cache,
 * because the caller cannot tell afterwards: without it a denied warm
 * read is recorded against the backend and counted as network traffic
 * that never happened.
 *
 * `completedBytes` carries how many bytes that completed op moved,
 * because the caller cannot recover it: the result is suppressed, and
 * a read's byte count lives nowhere else (a write's is still in its
 * own arguments). Without it a denied read records zero and
 * `networkBytes` under-reports traffic that actually happened.
 */
export class PolicyDenied extends Error {
  readonly code = 'EACCES'
  readonly virtualPath: string
  completed = false
  completedBytes = 0
  fromCache = false

  constructor(message: string, virtualPath: string) {
    super(message)
    this.name = 'PolicyDenied'
    this.virtualPath = virtualPath
  }
}

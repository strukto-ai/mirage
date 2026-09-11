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

import type { Policy } from './base.ts'
import type { PolicyHook } from './types.ts'

/**
 * The nominal session-scoped brand (python's SessionScopedMixin
 * inheritance). Detection is by this marker, never by probing for a
 * `wantsFor` method. `Symbol.for` keeps the brand stable even when two
 * copies of the package are loaded.
 */
export const SESSION_SCOPED: unique symbol = Symbol.for('mirage.policy.sessionScoped')

/**
 * A policy whose hooks speak for some sessions and not others. A Policy
 * that also implements this defines a hook on behalf of the sessions
 * that carry a rule for it (a profile's policy program speaks only for
 * the sessions under that profile), and says so through `wantsFor`.
 * `Policies.wants` is the static answer, true as soon as any policy
 * defines the hook, and every door keeps gating on it; a seam that pays
 * ahead for a hook (the secret fill drops its masks under a
 * session-write gate) asks `Policies.wantsFor` instead, which consults
 * this brand so one profile's door does not charge every session.
 */
export interface SessionScoped {
  readonly [SESSION_SCOPED]: true

  /** Whether this policy's `hook` will speak for one session. */
  wantsFor(hook: PolicyHook, sessionId: string): Promise<boolean>
}

/** Whether this policy speaks per session. */
export function isSessionScoped(policy: Policy): policy is Policy & SessionScoped {
  return (policy as Partial<SessionScoped>)[SESSION_SCOPED] === true
}

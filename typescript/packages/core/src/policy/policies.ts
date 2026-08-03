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
import { PolicyError } from './errors.ts'
import { SpecPolicy, type GuardSpec } from './spec.ts'
import { VALIDITY, type CommandContext, type Deny } from './types.ts'

/**
 * Ordered policies; on a pre hook the first Deny wins.
 *
 * Built-ins are seeded first (MountRegistry registers
 * MountRootPolicy), then user policies in registration order:
 * `Workspace({guards, policies})`, then anything added later through
 * `add`. There is no allow arm, so adding a policy can only tighten
 * the workspace, never loosen it; order decides which refusal message
 * is shown, never whether a refusal holds.
 *
 * A policy that throws fails closed: the command is refused with a
 * Deny naming the policy. A policy that returns something the hook may
 * not return (VALIDITY) throws PolicyError: that is a programming
 * error, not a refusal.
 */
export class Policies {
  private readonly policies: Policy[]

  constructor(policies?: readonly Policy[]) {
    this.policies = [...(policies ?? [])]
  }

  /** Register a policy (or a declarative spec) after the existing ones. */
  add(entry: Policy | GuardSpec): void {
    this.policies.push('reason' in entry ? new SpecPolicy(entry) : entry)
  }

  /** Fire preCommand across the policies; the first Deny wins. */
  async preCommand(ctx: CommandContext): Promise<Deny | null> {
    for (const policy of this.policies) {
      if (policy.preCommand === undefined) continue
      const name = policy.constructor.name || 'policy'
      let action
      try {
        action = await policy.preCommand(ctx)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return {
          kind: 'deny',
          message: `${ctx.command}: policy ${name} failed: ${detail}\n`,
          exitCode: 1,
        }
      }
      if (action === null) continue
      const kind: unknown = typeof action === 'object' ? action.kind : undefined
      if (typeof kind !== 'string' || !VALIDITY.preCommand.has(kind)) {
        throw new PolicyError(
          `preCommand of ${name} returned ${JSON.stringify(action)}; ` +
            `legal kinds here: ${[...VALIDITY.preCommand].join(', ')}`,
        )
      }
      return action
    }
    return null
  }
}

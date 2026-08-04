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

import { Limit } from '../types.ts'
import type { Policy } from './base.ts'
import { PolicyError } from './errors.ts'
import { SpecPolicy } from './spec.ts'
import {
  VALIDITY,
  type CommandContext,
  type Deny,
  type ExecuteContext,
  type ExecuteResultContext,
  type GuardSpec,
  type OpsContext,
  type OpsResultContext,
  type Route,
} from './types.ts'

type Hook = keyof typeof VALIDITY

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
  private wanted: ReadonlySet<Hook> = new Set()

  constructor(policies?: readonly Policy[]) {
    this.policies = [...(policies ?? [])]
    this.rescan()
  }

  /**
   * True when any policy defines `hook`. O(1); the op seam gates on it
   * so a workspace with no op policies pays nothing per VFS op.
   */
  wants(hook: Hook): boolean {
    return this.wanted.has(hook)
  }

  private rescan(): void {
    const wanted = new Set<Hook>()
    for (const hook of Object.keys(VALIDITY) as Hook[]) {
      if (this.policies.some((p) => p[hook] !== undefined)) wanted.add(hook)
    }
    this.wanted = wanted
  }

  /**
   * Register a policy (or a declarative spec) after the existing ones.
   * The discriminator is the hook surface, not the `reason` field: an
   * entry defining any hook is a Policy even if it also carries a
   * `reason` property (Python distinguishes with isinstance; this is
   * the structural equivalent).
   */
  add(entry: Policy | GuardSpec): void {
    const candidate = entry as Policy
    const hooked =
      typeof candidate.preCommand === 'function' ||
      typeof candidate.preExecute === 'function' ||
      typeof candidate.preOps === 'function' ||
      typeof candidate.postOps === 'function' ||
      typeof candidate.postExecute === 'function'
    if (!hooked && 'reason' in entry) {
      this.policies.push(new SpecPolicy(entry))
    } else {
      this.policies.push(entry as Policy)
    }
    this.rescan()
  }

  /**
   * One loop for every hook: the first Deny wins (limits and routes
   * are moot once the line is refused), Limit actions accumulate and
   * merge to the tightest value per field, the first Route is kept and
   * later Routes ignored (a later policy can still Deny over it).
   *
   * A throwing policy fails closed into a Deny naming it, except a
   * PolicyError, which is a programming error reporting a
   * caller-fixable mistake and propagates instead.
   */
  private async fire(
    hook: Hook,
    ctx: CommandContext | ExecuteContext | OpsContext | OpsResultContext | ExecuteResultContext,
    subject: string,
  ): Promise<[Deny | null, Limit | null, Route | null]> {
    const limits: Limit[] = []
    let route: Route | null = null
    for (const policy of this.policies) {
      const fn = policy[hook]
      if (fn === undefined) continue
      const name = policy.constructor.name || 'policy'
      let action
      try {
        action = await fn.call(
          policy,
          ctx as CommandContext &
            ExecuteContext &
            OpsContext &
            OpsResultContext &
            ExecuteResultContext,
        )
      } catch (err) {
        if (err instanceof PolicyError) throw err
        const detail = err instanceof Error ? err.message : String(err)
        return [
          {
            kind: 'deny',
            message: `${subject}: policy ${name} failed: ${detail}\n`,
            exitCode: 1,
          },
          null,
          null,
        ]
      }
      if (action === null) continue
      const kind: unknown = typeof action === 'object' ? action.kind : undefined
      if (typeof kind !== 'string' || !VALIDITY[hook].has(kind)) {
        throw new PolicyError(
          `${hook} of ${name} returned ${JSON.stringify(action)}; ` +
            `legal kinds here: ${[...VALIDITY[hook]].join(', ')}`,
        )
      }
      if (action.kind === 'deny') return [action, null, null]
      if (action.kind === 'route') {
        route ??= action
        continue
      }
      limits.push(action)
    }
    return [null, Limit.aggr(limits), route]
  }

  /** Fire preCommand across the policies; the first Deny wins. */
  async preCommand(ctx: CommandContext): Promise<Deny | null> {
    const [deny] = await this.fire('preCommand', ctx, ctx.command)
    return deny
  }

  /** Fire preExecute; the first Deny wins, the first Route places the line. */
  async preExecute(ctx: ExecuteContext): Promise<[Deny | null, Route | null]> {
    const [deny, , route] = await this.fire('preExecute', ctx, ctx.command || 'line')
    return [deny, route]
  }

  /** Fire preOps across the policies; the first Deny wins. */
  async preOps(ctx: OpsContext): Promise<Deny | null> {
    const [deny] = await this.fire('preOps', ctx, ctx.op)
    return deny
  }

  /** Fire postOps; a Deny suppresses the result, Limits merge. */
  async postOps(ctx: OpsResultContext): Promise<[Deny | null, Limit | null]> {
    const [deny, bound] = await this.fire('postOps', ctx, ctx.op)
    return [deny, bound]
  }

  /** Fire postExecute; Limits merge to the boundary bound. */
  async postExecute(ctx: ExecuteResultContext): Promise<[Deny | null, Limit | null]> {
    const [deny, bound] = await this.fire('postExecute', ctx, ctx.producer.command || 'line')
    return [deny, bound]
  }
}

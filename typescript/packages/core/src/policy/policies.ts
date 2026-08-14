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

import { Limit, type PathSpec } from '../types.ts'
import type { Policy } from './base.ts'
import { PolicyDenied, PolicyError } from './errors.ts'
import { SpecPolicy } from './spec.ts'
import {
  VALIDITY,
  type CommandContext,
  type Deny,
  type ExecuteResultContext,
  type GuardSpec,
  type OpsContext,
  type OpsResultContext,
  type SessionContext,
} from './types.ts'

type Hook = keyof typeof VALIDITY

/**
 * Fire preOps at the op door; a Deny becomes a PolicyDenied (EACCES).
 * The one seam helper the dispatcher calls, so a refusal is identical
 * however the mount is reached: shell internals, programmatic access,
 * FUSE, and the warm cache all pass through it.
 */
export async function preOpsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
): Promise<void> {
  if (!policies.wants('preOps')) return
  const deny = await policies.preOps({ op, path, write, prefix })
  if (deny !== null) {
    throw new PolicyDenied(deny.message.replace(/\n$/, ''), path.virtual)
  }
}

/**
 * Fire postOps at the op door; a Deny suppresses the result. Returns
 * the merged Limit bound (tightest per field across every opining
 * policy) for the door to apply to a byte-producing result, or null
 * when no policy bounds this op.
 */
export async function postOpsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
  result: unknown,
): Promise<Limit | null> {
  if (!policies.wants('postOps')) return null
  const [deny, bound] = await policies.postOps({ op, path, write, prefix, result })
  if (deny !== null) {
    throw new PolicyDenied(deny.message.replace(/\n$/, ''), path.virtual)
  }
  return bound
}

/**
 * Fire postExecute at the workspace boundary. Returns the fail-closed
 * Deny (a throwing policy) if any, and the merged Limit bound for the
 * boundary to enforce on the line's output stream.
 */
export async function postExecuteGate(
  policies: Policies,
  ctx: ExecuteResultContext,
): Promise<[Deny | null, Limit | null]> {
  if (!policies.wants('postExecute')) return [null, null]
  return policies.postExecute(ctx)
}

/**
 * Fire preSession on the session plane; a Deny becomes a PolicyDenied.
 * The one seam helper the session plane's writers call, so a refusal
 * is identical however the state is reached: shell builtin, command
 * view, or a later tier. Null policies (a view constructed outside a
 * workspace) gate nothing.
 */
export async function preSessionGate(
  policies: Policies | null,
  ctx: SessionContext,
): Promise<void> {
  if (!policies?.wants('preSession')) return
  const deny = await policies.preSession(ctx)
  if (deny !== null) {
    throw new PolicyDenied(deny.message.replace(/\n$/, ''), ctx.key)
  }
}

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
      typeof candidate.preOps === 'function' ||
      typeof candidate.postOps === 'function' ||
      typeof candidate.postExecute === 'function' ||
      typeof candidate.preSession === 'function'
    if (!hooked && 'reason' in entry) {
      this.policies.push(new SpecPolicy(entry))
    } else {
      this.policies.push(entry as Policy)
    }
    this.rescan()
  }

  /**
   * One loop for every hook: the first Deny wins (limits are moot once
   * the result is suppressed), Limit actions accumulate and merge
   * to the tightest value per field.
   */
  private async fire(
    hook: Hook,
    ctx: CommandContext | OpsContext | OpsResultContext | ExecuteResultContext | SessionContext,
    subject: string,
  ): Promise<[Deny | null, Limit | null]> {
    const limits: Limit[] = []
    for (const policy of this.policies) {
      const fn = policy[hook]
      if (fn === undefined) continue
      const name = policy.constructor.name || 'policy'
      let action
      try {
        action = await fn.call(
          policy,
          ctx as CommandContext &
            OpsContext &
            OpsResultContext &
            ExecuteResultContext &
            SessionContext,
        )
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return [
          {
            kind: 'deny',
            message: `${subject}: policy ${name} failed: ${detail}\n`,
            exitCode: 1,
          },
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
      if (action.kind === 'deny') return [action, null]
      limits.push(action)
    }
    return [null, Limit.aggr(limits)]
  }

  /** Fire preCommand across the policies; the first Deny wins. */
  async preCommand(ctx: CommandContext): Promise<Deny | null> {
    const [deny] = await this.fire('preCommand', ctx, ctx.command)
    return deny
  }

  /** Fire preOps across the policies; the first Deny wins. */
  async preOps(ctx: OpsContext): Promise<Deny | null> {
    const [deny] = await this.fire('preOps', ctx, ctx.op)
    return deny
  }

  /** Fire postOps; a Deny suppresses the result, Limits merge. */
  async postOps(ctx: OpsResultContext): Promise<[Deny | null, Limit | null]> {
    return this.fire('postOps', ctx, ctx.op)
  }

  /** Fire postExecute; Limits merge to the boundary bound. */
  async postExecute(ctx: ExecuteResultContext): Promise<[Deny | null, Limit | null]> {
    return this.fire('postExecute', ctx, ctx.producer.command || 'line')
  }

  /** Fire preSession across the policies; the first Deny wins. */
  async preSession(ctx: SessionContext): Promise<Deny | null> {
    const [deny] = await this.fire('preSession', ctx, ctx.key)
    return deny
  }
}

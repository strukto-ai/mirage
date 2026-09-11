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

import { operandExitCode } from '../commands/spec/usage.ts'
import { Limit, type PathSpec, type Refusal } from '../types.ts'
import type { Policy } from './base.ts'
import { POLICY_DENIED_EXIT } from './constants.ts'
import { PolicyDenied, PolicyError } from './errors.ts'
import { isSessionScoped } from './mixin.ts'
import {
  VALIDITY,
  type Ask,
  type CommandContext,
  type Deny,
  type ExecuteResultContext,
  type OpsContext,
  type OpsResultContext,
  type Pending,
  type SessionContext,
} from './types.ts'

type Hook = keyof typeof VALIDITY

/**
 * The command plane's rendering of a refusal: stderr and exit code. The
 * one place the outcome table for that plane is written down, so a
 * document rule and a coded policy print alike: a whole-command Deny is
 * bash's own `<subject>: Permission denied` at 126, with the reason on
 * the result's `refusal` record rather than on stderr; an operand Deny
 * keeps the GNU voice `<subject>: <reason>` at the command's
 * operand-refusal code (1, tar 2), because there the reason is the
 * diagnostic.
 */
export function renderDeny(subject: string, deny: Deny): [Uint8Array, number] {
  if (deny.scope === 'operand') {
    return [new TextEncoder().encode(`${subject}: ${deny.reason}\n`), operandExitCode(subject)]
  }
  return [new TextEncoder().encode(`${subject}: Permission denied\n`), POLICY_DENIED_EXIT]
}

/**
 * The command plane's rendering of an unanswered ask: refused for now
 * at 126 in the same words as a deny, so stderr never tells an agent
 * whether a retry might pass; the ask id it should quote rides the
 * `refusal` record.
 */
export function renderPending(subject: string, pending: Pending): [Uint8Array, number] {
  void pending
  return [new TextEncoder().encode(`${subject}: Permission denied\n`), POLICY_DENIED_EXIT]
}

/** The record a refused result carries beside its bash-voiced stderr. */
export function refusalOf(action: Deny | Pending): Refusal {
  if (action.kind === 'pending') {
    return {
      kind: 'pending',
      reason: action.reason,
      policy: '',
      scope: 'command',
      askId: action.id,
    }
  }
  return {
    kind: action.failed === true ? 'failed' : 'deny',
    reason: action.reason,
    policy: action.policy ?? '',
    scope: action.scope ?? 'command',
    askId: null,
  }
}

/**
 * One line saying why, for a surface that hands the agent text rather
 * than a record; the agent adapters append it after stderr.
 */
export function describeRefusal(refusal: Refusal): string {
  if (refusal.kind === 'pending') {
    return `requires approval: ${refusal.reason} (ask ${refusal.askId ?? ''})`
  }
  if (refusal.kind === 'failed') return `policy ${refusal.policy} failed`
  return `policy denied: ${refusal.reason}`
}

/**
 * Whether `text` already carries the line that says why the command was
 * refused. Only an operand-scoped denial has one: its GNU diagnostic
 * `<command>: <reason>` is the reason, wherever a redirect landed it, so
 * a surface that describes the record after the text looks for that
 * line rather than for the scope (`2>/dev/null` takes the line away and
 * the record is the only reason left, `2>&1` moves it onto stdout and
 * nothing needs repeating) and rather than for the reason as a
 * substring, since output that happens to quote the words has refused
 * nothing. A command-scoped refusal's stderr is bash's bare
 * `Permission denied`, which never says why. An empty reason says
 * nothing, so no text can already have said it.
 */
export function saysWhy(text: string, refusal: Refusal): boolean {
  if (refusal.scope !== 'operand' || refusal.reason === '') return false
  const tail = `: ${refusal.reason}`
  return text.split('\n').some((line) => line.endsWith(tail))
}

/**
 * Narrow a hook's answer where VALIDITY admits no Ask, which the loop
 * already refuses inside; reaching one here is a programming error.
 */
function denyOnly(hook: Hook, action: Deny | Ask | null): Deny | null {
  if (action !== null && action.kind === 'ask') {
    throw new PolicyError(`${hook} cannot answer with an Ask: ${JSON.stringify(action)}`)
  }
  return action
}

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
  sessionId = '',
  issuer?: symbol,
): Promise<void> {
  if (!policies.wants('preOps')) return
  const deny = await policies.preOps({
    op,
    path,
    write,
    prefix,
    sessionId,
    ...(issuer !== undefined ? { issuer } : {}),
  })
  if (deny !== null) {
    throw new PolicyDenied(deny.reason, path.virtual)
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
    throw new PolicyDenied(deny.reason, path.virtual)
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
    throw new PolicyDenied(deny.reason, ctx.key)
  }
}

/**
 * Ordered policies; on a pre hook the first Deny wins.
 *
 * Built-ins are seeded first (MountRegistry registers
 * MountRootPolicy), then the document's deny rules compiled by the
 * workspace, then user policies in registration order
 * (`Workspace({policies})`, then anything added later through
 * `add`). There is no allow arm, so adding a policy can only tighten
 * the workspace, never loosen it; order decides which refusal message
 * is shown, never whether a refusal holds.
 *
 * A policy that throws fails closed: the command is refused with a
 * whole-command Deny naming the policy. A policy that returns something the hook may
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

  /**
   * True when some policy will speak at `hook` for this session. The
   * per-session refinement of `wants`: a policy that defines the hook
   * counts, unless it speaks per session (`SessionScoped`) and says this
   * is not one of its. For a seam that pays ahead for a hook rather than
   * gating on it: the secret fill drops its masks under a session-write
   * gate, and a profile's policy at that door is one profile's, not
   * every session's.
   */
  async wantsFor(hook: Hook, sessionId: string): Promise<boolean> {
    for (const policy of [...this.policies]) {
      if (policy[hook] === undefined) continue
      if (!isSessionScoped(policy)) return true
      if (await policy.wantsFor(hook, sessionId)) return true
    }
    return false
  }

  private rescan(): void {
    const wanted = new Set<Hook>()
    for (const hook of Object.keys(VALIDITY) as Hook[]) {
      if (this.policies.some((p) => p[hook] !== undefined)) wanted.add(hook)
    }
    this.wanted = wanted
  }

  /**
   * Register a policy after the existing ones. Code only: a
   * declarative rule belongs in the permissions document
   * (`commands.deny`), which the workspace compiles.
   */
  add(entry: Policy): void {
    this.policies.push(entry)
    this.rescan()
  }

  /** Remove one registration by identity, preserving the other policies' order. Host-side only. */
  remove(entry: Policy): boolean {
    const index = this.policies.indexOf(entry)
    if (index === -1) return false
    this.policies.splice(index, 1)
    this.rescan()
    return true
  }

  /**
   * One loop for every hook: the first Deny wins (limits are moot once
   * the result is suppressed), Limit actions accumulate and merge
   * to the tightest value per field. An Ask is remembered and the
   * loop goes on looking for a Deny, so a later policy's refusal
   * outranks an earlier policy's question and an approval can never
   * re-open a deny; the first Ask is returned when nothing refused.
   */
  private async fire(
    hook: Hook,
    ctx: CommandContext | OpsContext | OpsResultContext | ExecuteResultContext | SessionContext,
  ): Promise<[Deny | Ask | null, Limit | null]> {
    const limits: Limit[] = []
    let asked: Ask | null = null
    // Keep this gate's order stable if the host edits registrations
    // while a hook awaits. Changes take effect at the next gate.
    for (const policy of [...this.policies]) {
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
        // The agent reads which policy broke, never what it threw: the
        // error text is the deployment's to debug, in the log.
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`${hook} policy ${name} raised: ${detail}`)
        return [{ kind: 'deny', reason: `${name} failed`, policy: name, failed: true }, null]
      }
      if (action === null) continue
      const kind: unknown = typeof action === 'object' ? action.kind : undefined
      if (typeof kind !== 'string' || !VALIDITY[hook].has(kind)) {
        throw new PolicyError(
          `${hook} of ${name} returned ${JSON.stringify(action)}; ` +
            `legal kinds here: ${[...VALIDITY[hook]].join(', ')}`,
        )
      }
      if (action.kind === 'deny') {
        return [
          action.policy === undefined || action.policy === ''
            ? { ...action, policy: name }
            : action,
          null,
        ]
      }
      if (action.kind === 'ask') {
        asked ??= action
        continue
      }
      limits.push(action)
    }
    return [asked, Limit.aggr(limits)]
  }

  /** Fire preCommand across the policies; the first Deny wins, else the first Ask. */
  async preCommand(ctx: CommandContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('preCommand', ctx)
    return action
  }

  /** Fire preOps across the policies; the first Deny wins. */
  async preOps(ctx: OpsContext): Promise<Deny | null> {
    const [action] = await this.fire('preOps', ctx)
    return denyOnly('preOps', action)
  }

  /** Fire postOps; a Deny suppresses the result, Limits merge. */
  async postOps(ctx: OpsResultContext): Promise<[Deny | null, Limit | null]> {
    const [action, limit] = await this.fire('postOps', ctx)
    return [denyOnly('postOps', action), limit]
  }

  /** Fire postExecute; Limits merge to the boundary bound. */
  async postExecute(ctx: ExecuteResultContext): Promise<[Deny | null, Limit | null]> {
    const [action, limit] = await this.fire('postExecute', ctx)
    return [denyOnly('postExecute', action), limit]
  }

  /** Fire preSession across the policies; the first Deny wins. */
  async preSession(ctx: SessionContext): Promise<Deny | null> {
    const [action] = await this.fire('preSession', ctx)
    return denyOnly('preSession', action)
  }
}

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

import { PermissionsPolicy } from './builtin/permissions.ts'
import type { IOContext } from '../context/types.ts'
import { operandExitCode } from '../commands/spec/usage.ts'
import { explaining, lineRunning, noteRefusal, runExplaining } from '../context/session_context.ts'
import { eacces, erofs } from '../errors/fs.ts'
import { fsErrorLine } from '../errors/render.ts'
import { Limit, type PathSpec, type Refusal } from '../types.ts'
import type { Policy } from './base.ts'
import { HiddenPathsPolicy } from './builtin/hidden_paths.ts'
import { MountModePolicy } from './builtin/mount_mode.ts'
import { POLICY_DENIED_EXIT } from './constants.ts'
import { Explained, PolicyDenied, PolicyError } from './errors.ts'
import { sourceOf } from './match/decide.ts'
import { isSessionScoped } from './mixin.ts'
import type { Decisions } from './decisions.ts'
import {
  DryRun,
  Outcome,
  VALIDITY,
  type Ask,
  type CommandContext,
  type Deny,
  type ExecuteResultContext,
  type Hide,
  type VfsContext,
  type VfsResultContext,
  type Pending,
  type Route,
  type SessionContext,
  type VfsExplanation,
} from './types.ts'
import type { RouteContext } from '../runtime/routing/types.ts'
import { posixPhrase } from '../errors/posix.ts'

type Hook = keyof typeof VALIDITY

/**
 * The command plane's rendering of a refusal: stderr and exit code. The
 * one place the outcome table for that plane is written down, so a
 * document rule and a coded policy print alike, and the policy's reason
 * is never mixed into what the terminal says: a whole-command Deny is
 * bash's own `<subject>: Permission denied` at 126; an operand Deny
 * about a path is the command's own GNU line for that operand and
 * EACCES; both leave the reason on the result's `refusal` record. An
 * operand Deny that names no path keeps `<subject>: <reason>`, because
 * there the reason is the diagnostic a built-in worded in POSIX's
 * terms. Operand refusals exit at the command's operand-refusal code
 * (1, tar 2).
 */
export function renderDeny(subject: string, deny: Deny): [Uint8Array, number] {
  if (deny.scope === 'operand') {
    const line =
      deny.path !== undefined
        ? fsErrorLine(subject, deny.path, eacces(deny.path))
        : `${subject}: ${deny.reason}\n`
    return [new TextEncoder().encode(line), operandExitCode(subject)]
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
 * refused. Only an operand-scoped denial that names no path has one: its
 * diagnostic `<command>: <reason>` is the reason, wherever a redirect landed it, so
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
 * The placement the policies agree on: their one runtime, null when none
 * placed the line, and a Deny when two disagree. Mirrors the Python
 * `agreed`.
 */
export function agreed(routes: readonly Route[]): Deny | Route | null {
  const runtimes = new Set(routes.map((route) => route.runtime))
  if (runtimes.size < 2) return routes[0] ?? null
  const said = routes.map((r) => `${r.policy ?? ''} on ${r.runtime}`).join(', ')
  return {
    kind: 'deny',
    reason: `policies place the line on different runtimes: ${said}`,
    policy: [...new Set(routes.map((r) => r.policy ?? ''))].join(', '),
  }
}

/**
 * What a stage's answers come to, by kind: the first Deny, else the first
 * Ask, else the Route every placing answer agrees on. Mirrors the Python
 * `settled`.
 */
export function settled(answers: readonly (Deny | Ask | Route)[]): Deny | Ask | Route | null {
  const deny = answers.find((a): a is Deny => a.kind === 'deny')
  if (deny !== undefined) return deny
  const ask = answers.find((a): a is Ask => a.kind === 'ask')
  if (ask !== undefined) return ask
  return agreed(answers.filter((a): a is Route => a.kind === 'route'))
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
 * The error a door throws for a policy's Deny, or for a question the host
 * has not answered, its record noted for the line running it. The message
 * says what the terminal would (`Permission denied` unless the door words
 * its own); the reason (or the ask id the agent quotes) rides the record,
 * on the error for a caller that catches it and on the line's result for
 * one that only reads what a command printed.
 */
export function policyDenied(
  action: Deny | Pending,
  filename: string,
  message = posixPhrase('EACCES'),
): PolicyDenied {
  const refusal = refusalOf(action)
  noteRefusal(refusal)
  return new PolicyDenied(message, filename, refusal)
}

/**
 * What the gate would answer one VFS call, as `preVfsGate` decides it and
 * without its consequences: every policy's answer, the one that wins,
 * and the error the door would throw. A question reads the ledger's
 * settled records and records nothing. Mirrors the Python `_explained_op`.
 */
async function explainedOp(
  policies: Policies,
  ctx: VfsContext,
  decisions: Decisions | null,
  io?: IOContext,
): Promise<VfsExplanation> {
  const answers = (await policies.answers('preVfs', ctx, true, io)).filter(
    (a): a is Deny | Ask => a.kind !== 'route',
  )
  const winner = answers.find((a) => a.kind === 'deny') ?? answers[0] ?? null
  const base: VfsExplanation = {
    call: ctx.op,
    paths: [ctx.path.virtual],
    outcome: Outcome.ALLOW,
    reason: '',
    source: '',
    answers,
    refusal: null,
    error: '',
  }
  if (winner === null) return base
  let action: Deny | Pending | null = winner.kind === 'deny' ? winner : null
  if (winner.kind === 'ask') {
    action =
      decisions === null || lineRunning()
        ? {
            kind: 'deny',
            reason: winner.reason,
            ...(winner.policy ? { policy: winner.policy } : {}),
          }
        : await decisions.heldOp(ctx, winner)
  }
  const decided: VfsExplanation = {
    ...base,
    outcome: winner.kind === 'ask' ? Outcome.ASK : Outcome.DENY,
    reason: winner.reason,
    source: winner.rule === undefined ? '' : sourceOf(winner.rule),
  }
  if (action === null) return decided
  const error = action.kind === 'deny' ? action.error : undefined
  const code: unknown = (error as { code?: unknown } | undefined)?.code
  return {
    ...decided,
    refusal: error !== undefined ? null : refusalOf(action),
    error: typeof code === 'string' && code !== '' ? code : 'EACCES',
  }
}

/**
 * Fire preVfs at the op door; a Deny becomes a PolicyDenied (EACCES),
 * or the built-in's own error (ENOENT for a hide, EROFS for a mode).
 * The one seam helper the dispatcher calls, so a refusal is identical
 * however the mount is reached: shell internals, programmatic access,
 * FUSE, and the warm cache all pass through it. `access` carries the
 * owning mount's mode (unset at a door that judges it itself), whether
 * the op creates the path or mutates below it, `checkHidden` false only
 * for a door that has already answered the hides itself, and the
 * approval ledger. An Ask is a question only where no line is running and
 * the door holds the ledger (a file tool, the host's facade): the ledger
 * answers it from a standing grant or records it, and an unanswered one
 * refuses with the ask id on the record. Inside a line an Ask refuses
 * like a deny, since the line was admitted without it. `final` is false
 * only for a rename's source, whose destination is gated next. In a dry
 * run (`explaining`) the gate notes its answer and throws `Explained`
 * once the op would refuse or has no gate left, so the door stops before
 * any backend or cache is touched; a write a policy makes while it
 * decides that op throws EROFS, since the dry run may change nothing, and
 * an ask its read meets reads the ledger and records nothing.
 */
export async function preVfsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
  sessionId = '',
  issuer?: symbol,
  access: Pick<VfsContext, 'mode' | 'create' | 'subtree'> & {
    checkHidden?: boolean
    decisions?: Decisions | null
    final?: boolean
    io?: IOContext
  } = {},
): Promise<void> {
  const { checkHidden = true, decisions = null, final = true, io, ...context } = access
  const ctx: VfsContext = {
    op,
    path,
    write,
    prefix,
    sessionId,
    ...(issuer !== undefined ? { issuer } : {}),
    ...context,
  }
  const trace = explaining()
  if (Array.isArray(trace)) {
    const noted = await runExplaining(DryRun.DECIDING, async () =>
      checkHidden && (await policies.hides(ctx, io))
        ? null
        : explainedOp(policies, ctx, decisions, io),
    )
    if (noted === null) throw new Explained()
    trace.push(noted)
    if (final || noted.error !== '') throw new Explained()
    return
  }
  const deciding = trace === DryRun.DECIDING
  if (deciding && write) throw erofs(path)
  if (!(policies.wants('preVfs') || checkHidden || (write && context.mode !== undefined))) {
    return
  }
  let answer: Hide | Deny | Ask | null = await policies.preVfs(ctx, checkHidden, io)
  if (answer === null) return
  if (answer.kind === 'hide') throw answer.error
  if (answer.kind === 'ask') {
    if (decisions === null || lineRunning()) {
      throw policyDenied({ kind: 'deny', reason: answer.reason }, path.virtual)
    }
    const settled = deciding
      ? await decisions.heldOp(ctx, answer)
      : await decisions.resolveOp(ctx, answer)
    if (settled === null) return
    if (settled.kind === 'pending') throw policyDenied(settled, path.virtual)
    answer = settled
  }
  if (answer.error !== undefined) throw answer.error
  throw policyDenied(answer, path.virtual)
}

/**
 * Fire postVfs at the op door; a Deny suppresses the result. Returns
 * the merged Limit bound (tightest per field across every opining
 * policy) for the door to apply to a byte-producing result, or null
 * when no policy bounds this op.
 */
export async function postVfsGate(
  policies: Policies,
  op: string,
  path: PathSpec,
  write: boolean,
  prefix: string,
  result: unknown,
): Promise<Limit | null> {
  if (!policies.wants('postVfs')) return null
  const [deny, bound] = await policies.postVfs({ op, path, write, prefix, result })
  if (deny !== null) {
    if (deny.error !== undefined) throw deny.error
    throw policyDenied(deny, path.virtual)
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
    throw policyDenied(deny, ctx.key, `${ctx.key}: permission denied`)
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
  private readonly hidden = new HiddenPathsPolicy()
  private readonly mode: Policy = new MountModePolicy()
  private placement: Policy | null = null
  private wanted: ReadonlySet<Hook> = new Set()

  constructor(policies?: readonly Policy[]) {
    this.policies = [...(policies ?? [])]
    this.rescan()
  }

  /**
   * Install the built-in placement, the workspace's `routePolicy`
   * compiled as a policy, which answers `preExecute` ahead of every
   * registered one. It sits outside the fail-closed fold: a misconfigured
   * route policy throws `RouteError` to the caller rather than refusing
   * the line, since the mistake is the deployment's to fix.
   */
  place(placement: Policy | null): void {
    this.placement = placement
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
    const policies = this.placement === null ? this.policies : [...this.policies, this.placement]
    for (const hook of Object.keys(VALIDITY) as Hook[]) {
      if (policies.some((p) => p[hook] !== undefined)) wanted.add(hook)
    }
    this.wanted = wanted
  }

  /**
   * The policies a stage asks, in order: the built-in placement first at
   * `preExecute` (unless the caller placed the line), the registered
   * ones, and the built-in mount mode last at `preVfs`, after every
   * policy that could explain the refusal in its own words. A snapshot,
   * so the order holds if the host edits registrations while a hook
   * awaits; changes take effect at the next gate.
   */
  private chain(hook: Hook, placed: boolean, io?: IOContext): Policy[] {
    let chain = this.policies.map((policy) =>
      hook === 'preVfs' && io !== undefined && policy instanceof PermissionsPolicy
        ? policy.withContext(io)
        : policy,
    )
    if (hook === 'preExecute' && this.placement !== null && !placed) {
      chain = [this.placement, ...chain]
    }
    if (hook === 'preVfs')
      chain = [...chain, io === undefined ? this.mode : new MountModePolicy(io)]
    return chain
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
   * The one loop every stage runs: each policy's answer, named and checked
   * against what the hook may carry. The door stops at the first Deny,
   * since nothing after it can change the outcome; `every` goes on, so
   * `explain` shows the answers a Deny would hide. A policy that throws
   * answers with a Deny naming it (fail closed), except the built-in
   * placement, which throws to the caller. A kind the hook cannot carry
   * (VALIDITY) throws PolicyError: a programming error, not a refusal, and
   * as loud in a dry run as at the door. Mirrors the Python `_said`.
   */
  private async said(
    hook: Hook,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    every: boolean,
    placed = false,
    io?: IOContext,
  ): Promise<[(Deny | Ask | Route)[], Limit[]]> {
    const said: (Deny | Ask | Route)[] = []
    const limits: Limit[] = []
    for (const policy of this.chain(hook, placed, io)) {
      const fn = policy[hook]
      if (fn === undefined) continue
      const name = policy.constructor.name || 'policy'
      let action
      try {
        action = await fn.call(
          policy,
          ctx as CommandContext &
            RouteContext &
            VfsContext &
            VfsResultContext &
            ExecuteResultContext &
            SessionContext,
        )
      } catch (err) {
        if (policy === this.placement) throw err
        // The agent reads which policy broke, never what it threw: the
        // error text is the deployment's to debug, in the log.
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`${hook} policy ${name} raised: ${detail}`)
        said.push({ kind: 'deny', reason: `${name} failed`, policy: name, failed: true })
        if (!every) return [said, []]
        continue
      }
      if (action === null) continue
      const kind: unknown = typeof action === 'object' ? action.kind : undefined
      if (typeof kind !== 'string' || !VALIDITY[hook].has(kind)) {
        throw new PolicyError(
          `${hook} of ${name} returned ${JSON.stringify(action)}; ` +
            `legal kinds here: ${[...VALIDITY[hook]].join(', ')}`,
        )
      }
      if (action instanceof Limit) {
        limits.push(action)
        continue
      }
      if (action.kind === 'hide') continue
      said.push(
        action.policy === undefined || action.policy === '' ? { ...action, policy: name } : action,
      )
      if (action.kind === 'deny' && !every) return [said, []]
    }
    return [said, limits]
  }

  /**
   * One stage at a door: the first Deny wins (limits are moot once the
   * result is suppressed), Limit actions merge to the tightest value per
   * field, and Routes are collected for the caller to reconcile. An Ask is
   * remembered and the loop goes on looking for a Deny, so a later
   * policy's refusal outranks an earlier policy's question and an approval
   * can never re-open a deny; the first Ask is returned when nothing
   * refused.
   */
  private async fire(
    hook: Hook,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    placed = false,
    io?: IOContext,
  ): Promise<[Deny | Ask | null, Limit | null, Route[]]> {
    const [said, limits] = await this.said(hook, ctx, false, placed, io)
    const deny = said.find((a): a is Deny => a.kind === 'deny')
    if (deny !== undefined) return [deny, null, []]
    const asked = said.find((a): a is Ask => a.kind === 'ask') ?? null
    return [asked, Limit.aggr(limits), said.filter((a): a is Route => a.kind === 'route')]
  }

  /**
   * The policies' answers at one stage, in the order the stage asks them,
   * each naming its policy: what `explain` shows, from the same loop the
   * door runs. With `every` no answer stops the loop, so a Deny does not
   * hide the answers after it; without it the answers end at the first
   * Deny, as the door's do. The built-in hides never answer here, since a
   * hide never surfaces; the built-in placement answers first at
   * `preExecute` and the built-in mount mode last at `preVfs`, as they do
   * at the door. Mirrors the Python `answers`.
   */
  async answers(
    hook: Hook,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    every = true,
    io?: IOContext,
  ): Promise<(Deny | Ask | Route)[]> {
    const [said] = await this.said(hook, ctx, every, false, io)
    return said
  }

  /** Fire preCommand across the policies; the first Deny wins, else the first Ask. */
  async preCommand(ctx: CommandContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('preCommand', ctx)
    return action
  }

  /**
   * Fire preExecute: a Deny wins, else the Route every placing policy
   * agrees on; two placing the line on different runtimes refuse it.
   * `placed` says the caller placed the line (the runtime argument), so
   * the built-in placement is not asked and a Route is moot; a Deny still
   * refuses the line.
   */
  async preExecute(ctx: RouteContext, placed = false): Promise<Deny | Route | null> {
    const [action, , routes] = await this.fire('preExecute', ctx, placed)
    if (action?.kind === 'deny') return action
    return placed ? null : agreed(routes)
  }

  /** Whether the built-in hides answer the op as absent, before any policy is asked. */
  async hides(ctx: VfsContext, io?: IOContext): Promise<boolean> {
    const hidden = io === undefined ? this.hidden : new HiddenPathsPolicy(io)
    return (await hidden.preVfs(ctx)) !== null
  }

  /**
   * Fire preVfs across the policies; the first Deny wins, else the first
   * Ask, which the door decides how to put. The built-in
   * hides answer before every policy, with a Hide that outranks whatever
   * a policy would say, so a refusal never tells a session a hidden name
   * exists; the built-in mount mode answers after them. Both hold
   * whether or not any policy overrides the hook; `checkHidden` false
   * only for a door that has already answered the hides itself.
   */
  async preVfs(
    ctx: VfsContext,
    checkHidden = true,
    io?: IOContext,
  ): Promise<Hide | Deny | Ask | null> {
    if (checkHidden) {
      const hidden = await (io === undefined ? this.hidden : new HiddenPathsPolicy(io)).preVfs(ctx)
      if (hidden !== null) return hidden
    }
    const [action] = await this.fire('preVfs', ctx, false, io)
    return action
  }

  /** Fire postVfs; a Deny suppresses the result, Limits merge. */
  async postVfs(ctx: VfsResultContext): Promise<[Deny | null, Limit | null]> {
    const [action, limit] = await this.fire('postVfs', ctx)
    return [denyOnly('postVfs', action), limit]
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

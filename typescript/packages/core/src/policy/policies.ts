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
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import {
  type Caller,
  currentCaller,
  explaining,
  lineRunning,
  noteRefusal,
  runExplaining,
} from '../context/session_context.ts'
import { eacces, erofs } from '../errors/fs.ts'
import { commandRecords } from '../observe/context.ts'
import { fsErrorLine } from '../errors/render.ts'
import { Limit, type PathSpec, type Refusal } from '../types.ts'
import type { Policy } from './base.ts'
import { MountModePolicy } from './builtin/mount_mode.ts'
import { PermissionsPolicy } from './builtin/permissions.ts'
import { POLICY_DENIED_EXIT } from './constants.ts'
import { Explained, PolicyDenied, PolicyError } from './errors.ts'
import { sourceOf } from './match/decide.ts'
import { isSessionScoped } from './mixin.ts'
import { Decisions, askRule, opQuestion, sameRule } from './decisions.ts'
import {
  DryRun,
  Outcome,
  VALIDITY,
  policyCaller,
  type Ask,
  type Claimant,
  type CommandContext,
  type CommandResultContext,
  type Deny,
  type ExecuteResultContext,
  type VfsContext,
  type VfsResultContext,
  type Pending,
  type Route,
  type SessionContext,
  type SessionResultContext,
  type VfsExplanation,
} from './types.ts'
import { makeAbortError } from '../utils/abort.ts'
import type { VfsCall } from '../vfs/types.ts'
import type { RouteContext } from './types.ts'
import type { SessionState } from '../workspace/session/session.ts'
import { posixPhrase } from '../errors/posix.ts'

type Method = keyof typeof VALIDITY

/**
 * The command plane's rendering of a refusal: stderr and exit code. The
 * one place the outcome table for that plane is written down, so a
 * document rule and a coded policy print alike, and the policy's reason
 * is never mixed into what the terminal says: a Deny, or an unanswered
 * ask, is bash's own `<subject>: Permission denied` at 126, so stderr
 * never tells an agent whether a retry might pass; a Deny about a path
 * is the command's own GNU line for that path and EACCES; each leaves
 * the reason (and an ask's id) on the result's `refusal` record. A Deny
 * carrying an error keeps `<subject>: <reason>`, because there the
 * reason is the diagnostic a built-in worded in POSIX's terms. A path or
 * an error exits at the command's operand-refusal code (1, tar 2).
 */
export function renderDeny(subject: string, deny: Deny | Pending): [Uint8Array, number] {
  if (deny.kind === 'deny' && deny.path !== undefined) {
    const line = fsErrorLine(subject, deny.path, eacces(deny.path))
    return [new TextEncoder().encode(line), operandExitCode(subject)]
  }
  if (deny.kind === 'deny' && deny.error !== undefined) {
    return [new TextEncoder().encode(`${subject}: ${deny.reason}\n`), operandExitCode(subject)]
  }
  return [new TextEncoder().encode(`${subject}: Permission denied\n`), POLICY_DENIED_EXIT]
}

/**
 * The record a refused result carries beside its bash-voiced stderr. null
 * for a Deny carrying an error: that is the filesystem's own failure (a
 * busy mount root, a name that exists), whose stderr line already says
 * everything, so no policy refusal is recorded.
 */
export function refusalOf(action: Deny | Pending): Refusal | null {
  if (action.kind === 'pending') {
    return { kind: 'pending', reason: action.reason, policy: '', askId: action.id }
  }
  if (action.error !== undefined) return null
  return {
    kind: action.failed === true ? 'failed' : 'deny',
    reason: action.reason,
    policy: action.policy ?? '',
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
 * The error an entry point throws for a policy's Deny, or for a question the host
 * has not answered, its record noted for the line running it. The message
 * says what the terminal would (`Permission denied` unless the entry point words
 * its own); the reason (or the ask id the agent quotes) rides the record,
 * on the error for a caller that catches it and on the line's result for
 * one that only reads what a command printed. `caller` is who was refused,
 * whose line notes the record; without one, the async context's line.
 */
export function policyDenied(
  action: Deny | Pending,
  filename: string,
  message = posixPhrase('EACCES'),
  caller?: Caller,
): PolicyDenied {
  const refusal = refusalOf(action)
  if (refusal !== null) {
    if (caller === undefined) noteRefusal(refusal)
    else caller.refusals?.(refusal)
  }
  return new PolicyDenied(message, filename, refusal)
}

/**
 * What the gate would answer one VFS call, as `preVfsGate` decides it and
 * without its consequences: every policy's answer, the one that wins,
 * and the error the entry point would throw. A question reads the ledger's
 * settled records and records nothing. Mirrors the Python `_explained_op`.
 */
async function explainedOp(
  policies: Policies,
  ctx: VfsContext,
  decisions: Decisions | null,
  line: boolean,
): Promise<VfsExplanation> {
  const answers = (await policies.answers('preVfs', ctx)).filter(
    (a): a is Deny | Ask => a.kind !== 'route',
  )
  const winner = answers.find((a) => a.kind === 'deny') ?? answers[0] ?? null
  const base: VfsExplanation = {
    call: ctx.call.name,
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
      decisions === null || line
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
 * Fire preVfs at the dispatcher; a Deny becomes a PolicyDenied (EACCES),
 * or the built-in's own error (EROFS for a mode).
 * The one seam helper the dispatcher calls, so a refusal is identical
 * however the mount is reached: shell internals, programmatic access,
 * FUSE, and the warm cache all pass through it. A running line's own I/O,
 * and a method's own read, meet the hides, path rules and mount mode alone;
 * a method's write is refused. `access` carries the
 * owning mount's mode (unset at an entry point that judges it itself), whether
 * the op creates the path or mutates below it, and the approval ledger. An Ask is a question only where no line is running and
 * the entry point holds the ledger (a file tool, the host's facade): the ledger
 * answers it from a standing grant or records it, and an unanswered one
 * refuses with the ask id on the record. Inside a line an Ask refuses
 * like a deny, since the line was admitted without it. `final` is false
 * only for a rename's source, whose destination is gated next. In a dry
 * run (`explaining`) the gate notes its answer and throws `Explained`
 * once the op would refuse or has no gate left, so the entry point stops before
 * any backend or cache is touched; a write a policy makes while it
 * decides that op throws EROFS, since the dry run may change nothing, and
 * an ask its read meets reads the ledger and records nothing. `caller` is
 * who makes the call; without one, the gate reads the async context's.
 */
/**
 * A VFS call's policy answer, the policy's own reads recorded apart. They
 * still reach the ledger, but they are no records of the call being
 * judged: counted as its, they would pass for the call's own record (a RAM
 * unlink records none, so the facade records it) and be charged to the
 * command the call runs in. Without task isolation the binding would reach
 * other tasks' ops, and there the facade records its op itself anyway.
 * Mirrors Python's `_apart`.
 */
function apart<T>(answer: () => Promise<T>): Promise<T> {
  return asyncContextIsolatesTasks ? commandRecords(answer, true) : answer()
}

export async function preVfsGate(
  policies: Policies,
  call: VfsCall,
  path: PathSpec,
  write: boolean,
  prefix: string,
  sessionId = '',
  issuer?: symbol,
  access: Pick<VfsContext, 'mode' | 'access' | 'gate'> & {
    decisions?: Decisions | null
    final?: boolean
    caller?: Caller
  } = {},
): Promise<void> {
  const { decisions = null, final = true, caller, ...context } = access
  const ctx: VfsContext = {
    call,
    path,
    write,
    prefix,
    sessionId,
    ...(issuer !== undefined ? { issuer } : {}),
    ...context,
    caller: policyCaller((caller ?? currentCaller()).session),
  }
  const trace = caller === undefined ? explaining() : caller.explaining
  const line = caller === undefined ? lineRunning() : caller.refusals !== null
  if (Array.isArray(trace)) {
    const decide = (): Promise<VfsExplanation> =>
      apart(() => explainedOp(policies, ctx, decisions, line))
    // Without task isolation the binding would reach other tasks' ops; there
    // the mark rides a deciding method's own files and program instead.
    const noted = await (asyncContextIsolatesTasks
      ? runExplaining(DryRun.DECIDING, decide)
      : decide())
    trace.push(noted)
    if (final || noted.error !== '') throw new Explained()
    return
  }
  const deciding = trace === DryRun.DECIDING
  if (deciding && write) throw erofs(path)
  if (!(policies.wants('preVfs') || (write && context.mode !== undefined))) return
  const answer: Deny | Ask | null = await apart(() => policies.preVfs(ctx, line || deciding))
  await refuseOp(ctx, answer, line ? null : decisions, caller)
}

async function refuseOp(
  ctx: VfsContext,
  answer: Deny | Ask | null,
  decisions: Decisions | null,
  caller: Caller | undefined,
): Promise<void> {
  let refused: Deny | Pending | null
  if (answer?.kind === 'ask') {
    if (decisions === null) {
      throw policyDenied(
        { kind: 'deny', reason: answer.reason },
        ctx.path.virtual,
        undefined,
        caller,
      )
    }
    refused = await decisions.resolveOp(ctx, answer, caller)
  } else {
    refused = answer
  }
  if (refused?.kind === 'deny' && refused.error !== undefined) throw refused.error
  if (refused !== null) throw policyDenied(refused, ctx.path.virtual, undefined, caller)
}

/**
 * Fire postVfs at the dispatcher; a Deny, or an Ask the host has not
 * approved, drops the result with EACCES. Nothing cuts what a call returns:
 * a call that asks for a range, as a kernel or protocol mount does, must get
 * it whole. Not fired for a running line's own I/O or a method's own read.
 */
export async function postVfsGate(
  policies: Policies,
  call: VfsCall,
  path: PathSpec,
  write: boolean,
  prefix: string,
  result: unknown,
  sessionId = '',
  issuer?: symbol,
  access: Pick<VfsContext, 'mode' | 'access'> & {
    decisions?: Decisions | null
    caller?: Caller
  } = {},
): Promise<void> {
  const { decisions = null, caller, ...context } = access
  const line = caller === undefined ? lineRunning() : caller.refusals !== null
  const trace = caller === undefined ? explaining() : caller.explaining
  if (line || trace === DryRun.DECIDING || !(await policies.wantsFor('postVfs', sessionId))) {
    return
  }
  const ctx: VfsResultContext = {
    call,
    path,
    write,
    prefix,
    sessionId,
    ...(issuer !== undefined ? { issuer } : {}),
    ...context,
    caller: policyCaller((caller ?? currentCaller()).session),
    result,
  }
  await refuseOp(ctx, await apart(() => policies.postVfs(ctx)), decisions, caller)
}

/**
 * Fire postExecute at the workspace boundary. Returns what drops the
 * line's output (a Deny, or the ledger's answer to an Ask), else the
 * merged Limit bound for the boundary to enforce. Nothing the line did is
 * undone. A run killed while the host decides throws the abort.
 */
export async function postExecuteGate(
  policies: Policies,
  ctx: ExecuteResultContext,
  claimant: Claimant | null = null,
  signal?: AbortSignal,
): Promise<[Deny | Pending | null, Limit | null]> {
  if (!(await policies.wantsFor('postExecute', ctx.sessionId))) return [null, null]
  const [answer, bound] = await policies.postExecute(ctx)
  if (answer?.kind !== 'ask') return [answer, bound]
  const [asked, keyed] = opQuestion(ctx, answer)
  const said = await policies.decisions.resolve(asked, keyed, signal, claimant)
  if (said?.kind === 'abandoned') throw makeAbortError()
  return [said, said === null ? bound : null]
}

/**
 * Fire postCommand once a command or CLI ran and its output drained.
 * Returns what refuses it after the fact (a Deny, or the ledger's answer
 * to an Ask), which the caller turns into exit 126 and a refusal record.
 * Nothing the command did is undone. A run killed while the host decides
 * throws the abort. Mirrors the Python `post_command_gate`.
 */
export async function postCommandGate(
  policies: Policies,
  ctx: CommandResultContext,
  claimant: Claimant | null = null,
  signal?: AbortSignal,
): Promise<Deny | Pending | null> {
  if (!(await policies.wantsFor('postCommand', ctx.sessionId ?? ''))) return null
  const answer = await policies.postCommand(ctx)
  if (answer?.kind !== 'ask') return answer
  const said = await policies.decisions.resolve(ctx, answer, signal, claimant)
  if (said?.kind === 'abandoned') throw makeAbortError()
  return said
}

/**
 * Fire postSession once a session write landed; a Deny, or an Ask the
 * host has not approved, becomes a PolicyDenied, for the writer to put the
 * old value back before it reports. Mirrors the Python
 * `post_session_gate`.
 */
export async function postSessionGate(
  policies: Policies | null,
  ctx: SessionContext,
  old: string | null,
): Promise<void> {
  if (policies === null) return
  if (!(await policies.wantsFor('postSession', ctx.sessionId))) return
  const landed: SessionResultContext = { ...ctx, old }
  await sessionRefused(policies, landed, await policies.postSession(landed))
}

async function sessionRefused(
  policies: Policies,
  ctx: SessionContext,
  answer: Deny | Ask | null,
): Promise<void> {
  const refused = answer?.kind === 'ask' ? await policies.decisions.resolveOp(ctx, answer) : answer
  if (refused !== null) {
    throw policyDenied(refused, ctx.key, `${ctx.key}: permission denied`)
  }
}

/**
 * Fire preSession on the session plane; a Deny, or an Ask the host has
 * not approved, becomes a PolicyDenied. The one seam helper the session
 * plane's writers call, so a refusal is identical however the state is
 * reached: shell builtin, command view, or a later tier. Null policies (a
 * view constructed outside a workspace) gate nothing. An Ask goes to the
 * workspace's ledger (`Policies.decisions`), inside a line too. A write a
 * method makes while it decides (`ctx.session`) throws EACCES.
 */
export async function preSessionGate(
  policies: Policies | null,
  ctx: SessionContext,
): Promise<void> {
  if (explaining() === DryRun.DECIDING) throw eacces(ctx.key)
  if (!policies?.wants('preSession')) return
  await sessionRefused(policies, ctx, await policies.preSession(ctx))
}

/**
 * Ordered policies; at every method the first Deny wins, and every Ask is
 * put to the host.
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
 * whole-command Deny naming the policy. A policy that returns something the method may
 * not return (VALIDITY) throws PolicyError: that is a programming
 * error, not a refusal.
 *
 * The chain holds the decision ledger an Ask is put to (`decisions`), and
 * `views`, which the workspace sets to fill a method's read-only `session`
 * and `vfs`.
 */
export class Policies {
  private readonly policies: Policy[]
  private readonly mode: Policy = new MountModePolicy()
  private placement: Policy | null = null
  private wanted: ReadonlySet<Method> = new Set()
  decisions: Decisions = new Decisions()
  views:
    | ((
        sessionId: string,
        session?: SessionState,
      ) => (Required<Pick<RouteContext, 'session' | 'caller'>> & Pick<RouteContext, 'vfs'>) | null)
    | null = null

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
   * True when any policy defines `method`. O(1); the op seam gates on it
   * so a workspace with no op policies pays nothing per VFS op.
   */
  wants(method: Method): boolean {
    return this.wanted.has(method)
  }

  /**
   * True when some policy will speak at `method` for this session. The
   * per-session refinement of `wants`: a policy that defines the method
   * counts, unless it speaks per session (`SessionScoped`) and says this
   * is not one of its. For a seam that pays ahead for a method rather than
   * gating on it: the secret fill drops its masks under a session-write
   * gate, and a profile's policy at that entry point is one profile's, not
   * every session's. `rulesOnly` counts the profile's rules alone, as
   * `chain` takes it.
   */
  async wantsFor(method: Method, sessionId: string, rulesOnly = false): Promise<boolean> {
    const policies = this.placement === null ? this.policies : [...this.policies, this.placement]
    for (const policy of policies.filter((p) => p instanceof PermissionsPolicy || !rulesOnly)) {
      if (policy[method] === undefined) continue
      if (!isSessionScoped(policy)) return true
      if (await policy.wantsFor(method, sessionId)) return true
    }
    return false
  }

  private rescan(): void {
    const wanted = new Set<Method>()
    const policies = this.placement === null ? this.policies : [...this.policies, this.placement]
    for (const method of Object.keys(VALIDITY) as Method[]) {
      if (policies.some((p) => p[method] !== undefined)) wanted.add(method)
    }
    this.wanted = wanted
  }

  /**
   * The policies a stage asks, in order: the built-in placement first at
   * `preExecute` (unless the caller placed the line), the registered
   * ones, and the built-in mount mode last at `preVfs`, after every
   * policy that could explain the refusal in its own words. A snapshot,
   * so the order holds if the host edits registrations while a method
   * awaits; changes take effect at the next gate. `rulesOnly` asks the
   * profile's rules alone (`PermissionsPolicy`), not the policies
   * registered in code or a profile's script: the line's passes, which
   * judge a line before it runs, and a command's own I/O.
   */
  private chain(method: Method, placed: boolean, rulesOnly = false): Policy[] {
    let chain = this.policies.filter((p) => p instanceof PermissionsPolicy || !rulesOnly)
    if (method === 'preExecute' && this.placement !== null && !placed) {
      chain = [this.placement, ...chain]
    }
    if (method === 'preVfs') chain = [...chain, this.mode]
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
   * against what the method may carry; a policy answering an array has each
   * read in turn, as if its own policy had said it. The entry point stops
   * at the first Deny, since nothing after it can change the outcome;
   * `every` goes on, so `explain` shows the answers a Deny would hide. A
   * policy that throws answers with a Deny naming it (fail closed), except
   * the built-in placement, which throws to the caller. A kind the method
   * cannot carry (VALIDITY) throws PolicyError: a programming error, not a
   * refusal, and as loud in a dry run as at the entry point. A later Ask's
   * rules are appended to the first Ask's, so the first Ask carries every
   * question the stage raised and the host grants each. Each method runs as a
   * policy deciding, with its views filled unless the profile's rules alone
   * are asked. Mirrors the Python `_said`.
   */
  private async said(
    method: Method,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    every: boolean,
    placed = false,
    rulesOnly = false,
  ): Promise<[(Deny | Ask | Route)[], Limit[]]> {
    const said: (Deny | Ask | Route)[] = []
    const limits: Limit[] = []
    let seen = ctx
    for (const policy of this.chain(method, placed, rulesOnly)) {
      const fn = policy[method]
      if (fn === undefined) continue
      const name = policy.constructor.name || 'policy'
      const handles =
        !rulesOnly && this.views !== null && seen.session === undefined
          ? this.views(seen.sessionId ?? '', undefined)
          : null
      if (handles !== null) seen = { ...seen, ...handles }
      const asked = seen
      let answered
      try {
        const ask = async (): Promise<Awaited<ReturnType<typeof fn>>> =>
          fn.call(
            policy,
            asked as CommandResultContext &
              RouteContext &
              VfsResultContext &
              ExecuteResultContext &
              SessionResultContext,
          )
        // Without task isolation the binding would reach other tasks' ops,
        // so there the mark rides the method's own files and program alone.
        answered = await (asyncContextIsolatesTasks ? runExplaining(DryRun.DECIDING, ask) : ask())
      } catch (err) {
        if (policy === this.placement) throw err
        // The agent reads which policy broke, never what it threw: the
        // error text is the deployment's to debug, in the log.
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`${method} policy ${name} raised: ${detail}`)
        said.push({ kind: 'deny', reason: `${name} failed`, policy: name, failed: true })
        if (!every) return [said, []]
        continue
      }
      for (const action of Array.isArray(answered) ? answered : [answered]) {
        if (action === null) continue
        const kind: unknown = typeof action === 'object' ? action.kind : undefined
        if (typeof kind !== 'string' || !VALIDITY[method].has(kind)) {
          throw new PolicyError(
            `${method} of ${name} returned ${JSON.stringify(action)}; ` +
              `legal kinds here: ${[...VALIDITY[method]].join(', ')}`,
          )
        }
        if (action instanceof Limit) {
          limits.push(action)
          continue
        }
        if (action.kind === 'hide') continue
        said.push(
          action.policy === undefined || action.policy === ''
            ? { ...action, policy: name }
            : action,
        )
        const first = said.findIndex((a) => a.kind === 'ask')
        const held = said[first]
        if (action.kind === 'ask' && held?.kind === 'ask' && first < said.length - 1) {
          const rules = [
            ...(held.rules ?? [askRule(seen, held)]),
            ...(action.rules ?? [askRule(seen, action)]),
          ]
          said[first] = {
            ...held,
            rules: rules.filter((rule, i) => rules.findIndex((r) => sameRule(r, rule)) === i),
          }
        }
        if (action.kind === 'deny' && !every) return [said, []]
      }
    }
    return [said, limits]
  }

  /**
   * One stage at an entry point: the first Deny wins (limits are moot once the
   * result is suppressed), Limit actions merge to the tightest value per
   * field, and Routes are collected for the caller to reconcile. An Ask is
   * remembered and the loop goes on looking for a Deny, so a later
   * policy's refusal outranks an earlier policy's question and an approval
   * can never re-open a deny; the first Ask is returned, carrying every
   * Ask's rules, when nothing refused.
   */
  private async fire(
    method: Method,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    placed = false,
    rulesOnly = false,
  ): Promise<[Deny | Ask | null, Limit | null, Route[]]> {
    const [said, limits] = await this.said(method, ctx, false, placed, rulesOnly)
    const deny = said.find((a): a is Deny => a.kind === 'deny')
    if (deny !== undefined) return [deny, null, []]
    const asked = said.find((a): a is Ask => a.kind === 'ask') ?? null
    return [asked, Limit.aggr(limits), said.filter((a): a is Route => a.kind === 'route')]
  }

  /**
   * The policies' answers at one stage, in the order the stage asks them,
   * each naming its policy: what `explain` shows, from the same loop the
   * entry point runs. With `every` no answer stops the loop, so a Deny does not
   * hide the answers after it; without it the answers end at the first
   * Deny, as the entry point's do. The built-in hides never answer here, since a
   * hide never surfaces; the built-in placement answers first at
   * `preExecute` and the built-in mount mode last at `preVfs`, as they do
   * at the entry point. `rulesOnly` asks the profile's rules alone, as
   * `chain` takes it. Mirrors the Python `answers`.
   */
  async answers(
    method: Method,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext,
    every = true,
    rulesOnly = false,
  ): Promise<(Deny | Ask | Route)[]> {
    const [said] = await this.said(method, ctx, every, false, rulesOnly)
    return said
  }

  /** Fire preCommand across the policies; the first Deny wins, else the first Ask. */
  async preCommand(ctx: CommandContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('preCommand', ctx)
    return action
  }

  /** Fire postCommand across the policies; the first Deny wins, else the first Ask. */
  async postCommand(ctx: CommandResultContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('postCommand', ctx)
    return action
  }

  /**
   * Fire preExecute: a Deny wins, else the first Ask, which holds the
   * line until the host approves it; and the Route every placing policy
   * agrees on, two placing the line on different runtimes refusing it.
   * `placed` says the caller placed the line (the runtime argument), so
   * the built-in placement is not asked and a Route is moot; a Deny or an
   * Ask still holds the line.
   */
  async preExecute(ctx: RouteContext, placed = false): Promise<[Deny | Ask | null, Route | null]> {
    const [action, , routes] = await this.fire('preExecute', ctx, placed)
    if (action?.kind === 'deny' || placed) return [action, null]
    const route = agreed(routes)
    if (route?.kind === 'deny') return [route, null]
    return [action, route]
  }

  /**
   * Fire preVfs across the policies; the first Deny wins, else the first
   * Ask, which the entry point decides how to put. A hidden path never
   * gets here: the dispatcher's walk answers it as absent first (`sees`),
   * so a refusal never tells a session a hidden name exists. The built-in
   * mount mode answers after the policies, whether or not any policy
   * overrides the method; `rulesOnly` asks the profile's path rules alone,
   * for an op a running command makes.
   */
  async preVfs(ctx: VfsContext, rulesOnly = false): Promise<Deny | Ask | null> {
    const [action] = await this.fire('preVfs', ctx, false, rulesOnly)
    return action
  }

  /** Fire postVfs; a Deny or an Ask holds the result back. */
  async postVfs(ctx: VfsResultContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('postVfs', ctx)
    return action
  }

  /** Fire postExecute; a Deny or an Ask holds the output back, Limits merge to the boundary bound. */
  async postExecute(ctx: ExecuteResultContext): Promise<[Deny | Ask | null, Limit | null]> {
    const [action, limit] = await this.fire('postExecute', ctx)
    return [action, limit]
  }

  /** Fire preSession across the policies; the first Deny wins, else the first Ask. */
  async preSession(ctx: SessionContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('preSession', ctx)
    return action
  }

  /** Fire postSession across the policies; the first Deny wins, else the first Ask. */
  async postSession(ctx: SessionResultContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('postSession', ctx)
    return action
  }
}

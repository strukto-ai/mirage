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

import { FlagView, SPECS, parseCommand } from '../commands/spec/index.ts'
import { parseToKwargs } from '../commands/spec/parser.ts'
import { operandExitCode } from '../commands/spec/usage.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import {
  type Caller,
  callerSignal,
  currentCaller,
  explaining,
  lineRunning,
  noteRefusal,
  runExplaining,
  runLanding,
} from '../context/session_context.ts'
import { eacces, erofs } from '../errors/fs.ts'
import { commandRecords } from '../observe/context.ts'
import { fsErrorLine } from '../errors/render.ts'
import { FileType, Limit, type PathSpec, type Refusal } from '../types.ts'
import { rstripSlash } from '../utils/slash.ts'
import type { Policy } from './base.ts'
import { MountModePolicy } from './builtin/mount_mode.ts'
import { PermissionsPolicy } from './builtin/permissions.ts'
import { Explained, PolicyDenied } from './errors.ts'
import { Composition, composeSettled, type CompositionResult } from './composition.ts'
import { sourceOf } from './match/decide.ts'
import { operandPaths } from './match/rule.ts'
import { isSessionScoped } from './mixin.ts'
import { Decisions, opQuestion } from './decisions.ts'
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
  type NetworkContext,
  type NetworkResultContext,
  type VfsContext,
  type VfsResultContext,
  type Pending,
  type Route,
  type SessionContext,
  type SessionResultContext,
  type WorkspaceContext,
  type VfsExplanation,
} from './types.ts'
import { abortable, hasAborted, makeAbortError } from '../utils/abort.ts'
import type { VfsCall } from '../vfs/types.ts'
import type { RouteContext } from './types.ts'
import type { SessionState } from '../workspace/session/session.ts'
import { posixPhrase } from '../errors/posix.ts'
import { CANNOT_EXECUTE_STATUS } from '../shell/constants.ts'

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
  return [new TextEncoder().encode(`${subject}: Permission denied\n`), CANNOT_EXECUTE_STATUS]
}

/**
 * Opt in by assigning a debug sink, as Python's module logger is off until
 * configured.
 */
export const logger: { debug?: (message: string) => void } = {}

/**
 * `renderDeny` for a refused command whose context is at hand. A Deny about
 * a cp or mv operand says what GNU says when the step that operand's role
 * takes is refused, which the bare path line does not: the context says
 * which operand is a source and which the target, and its file view whether
 * each is a directory. Every other refusal renders as `renderDeny` renders
 * it.
 */
export async function renderCommandDeny(
  subject: string,
  deny: Deny | Pending,
  ctx: CommandContext,
): Promise<[Uint8Array, number]> {
  if (deny.kind === 'deny' && deny.path !== undefined) {
    const lines = await transferLines(subject, deny.path, ctx)
    if (lines !== null) return [new TextEncoder().encode(lines), operandExitCode(subject)]
  }
  return renderDeny(subject, deny)
}

/**
 * GNU's lines for the cp or mv operand a path deny names; null for another
 * command, or a path that is none of its operands. The deny lands before the
 * command touches a file, so each line is the one GNU prints when that
 * operand's step is refused: cp opens a source file for reading, reads a
 * source directory and creates each copy, and mv moves each source onto its
 * target, or swaps the two under `--exchange`. A target given by `-t`, after
 * more than one source or that is a directory takes each source by its base
 * name, unless `-T`. A source named `.` or `..`, or a link cp copies as a
 * link, keeps `renderDeny`'s line: GNU's there depends on what the directory
 * or the link holds. A stat still waiting when the line stops ends the
 * wording with the line's abort, so a cancel neither waits on it nor starts
 * another stat.
 */
async function transferLines(
  subject: string,
  path: string,
  ctx: CommandContext,
): Promise<string | null> {
  if (subject !== 'cp' && subject !== 'mv') return null
  const spec = SPECS[subject]
  if (spec === undefined) return null
  const parsed = parseCommand(spec, [...ctx.argv], ctx.cwd, subject)
  const flags = new FlagView(parseToKwargs(parsed), spec)
  const named = ctx.moveTarget ?? null
  const operands = operandPaths(ctx)
  const directory =
    named === null ? undefined : ctx.paths.find((p) => named === p.rawPath || named === p.virtual)
  const lastOperand = operands[operands.length - 1]
  let sources: PathSpec[]
  let target: PathSpec
  if (directory !== undefined) {
    sources = operands
    target = directory
  } else if (operands.length > 1 && lastOperand !== undefined) {
    sources = operands.slice(0, -1)
    target = lastOperand
  } else {
    return null
  }
  const namedSource = sources.find((s) => path === s.rawPath || path === s.virtual)
  let refused: PathSpec[]
  if (namedSource !== undefined) refused = [namedSource]
  else if (path === target.rawPath || path === target.virtual) refused = sources
  else return null
  const typedTarget = parsed.rawPathFlags.target_directory
  const goal =
    directory !== undefined && typeof typedTarget === 'string'
      ? typedTarget
      : target.rawPath || target.virtual
  const into =
    directory !== undefined ||
    (!flags.asBool('no_target_directory') &&
      (sources.length > 1 || (await fileType(ctx, target)) === FileType.DIRECTORY))
  const landing = (name: string): string => {
    if (!into) return goal
    const base = rstripSlash(name)
    return `${rstripSlash(goal)}/${base.slice(base.lastIndexOf('/') + 1)}`
  }
  const recursive =
    subject === 'cp' && (flags.asBool('r') || flags.asBool('recursive') || flags.asBool('archive'))
  const typed =
    subject === 'cp' ? flags.typedOrder('dereference', 'no_dereference', 'H', 'd', 'archive') : []
  const last = typed[typed.length - 1]
  const follows = last !== undefined ? last === 'dereference' || last === 'H' : !recursive
  const exchange = subject === 'mv' && flags.asBool('exchange')
  const lines: string[] = []
  for (const src of refused) {
    const shown = src.rawPath || src.virtual
    const trimmed = rstripSlash(shown)
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    if (base === '.' || base === '..') return null
    let line: string
    if (exchange) {
      line = `cannot exchange '${shown}' and '${landing(shown)}'`
    } else if (subject === 'mv') {
      line = `cannot move '${shown}' to '${landing(shown)}'`
    } else if (!follows && (await fileType(ctx, src, true)) === FileType.SYMLINK) {
      return null
    } else if ((await fileType(ctx, src)) !== FileType.DIRECTORY) {
      line =
        namedSource !== undefined
          ? `cannot open '${shown}' for reading`
          : `cannot create regular file '${landing(shown)}'`
    } else if (!recursive) {
      lines.push(`cp: -r not specified; omitting directory '${shown}'\n`)
      continue
    } else {
      line =
        namedSource !== undefined
          ? `cannot access '${shown}'`
          : `cannot create directory '${landing(shown)}'`
    }
    lines.push(`${subject}: ${line}: Permission denied\n`)
  }
  return lines.join('')
}

async function fileType(
  ctx: CommandContext,
  operand: PathSpec,
  nofollow = false,
): Promise<FileType | null> {
  if (ctx.vfs === undefined) return null
  const signal = callerSignal()
  try {
    return (await abortable(ctx.vfs.stat(operand, undefined, { nofollow }), signal)).type
  } catch (err) {
    if (hasAborted(signal)) throw err
    logger.debug?.(`no stat for refused operand ${operand.virtual}: ${String(err)}`)
    return null
  }
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
  return composeSettled(routes, 'agreed')
}

/**
 * What a stage's answers come to, by kind: the first Deny, else the first
 * Ask, else the Route every placing answer agrees on. Mirrors the Python
 * `settled`.
 */
export function settled(answers: readonly (Deny | Ask)[]): Deny | Ask | null
export function settled(answers: readonly (Deny | Ask | Route)[]): Deny | Ask | Route | null
export function settled(answers: readonly (Deny | Ask | Route)[]): Deny | Ask | Route | null {
  return composeSettled(answers, 'settled')
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
  const winner = settled(answers)
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
 * FUSE, and the warm cache all pass through it. Commands and runtimes
 * pass the same file gates. A policy method's own read meets the hides,
 * path rules and mount mode alone; its write is refused. `access` carries the
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
    caller: policyCaller((caller ?? currentCaller()).session, policies.account),
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
  const answer: Deny | Ask | null = await apart(() => policies.preVfs(ctx, deciding))
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
 * it whole. Commands and runtimes pass the same gate; a policy method's own read is exempt.
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
  if (trace === DryRun.DECIDING || !(await policies.wantsFor('postVfs', sessionId))) {
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
    caller: policyCaller((caller ?? currentCaller()).session, policies.account),
    result,
  }
  await refuseOp(ctx, await apart(() => policies.postVfs(ctx)), line ? null : decisions, caller)
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
/**
 * Fire preNetwork as a connection is about to open; a Deny, or an Ask,
 * refuses it with EACCES, the host as the name refused. A connection opens
 * under a command that was admitted without the question, so an Ask refuses
 * like a deny. A dry run's policy deciding opens nothing to judge. Only the
 * policies that let the connection through hear how it ends, so a refusal,
 * or an abort while they decide, ends it as refused for those already
 * passed. Returns them, for `postNetworkGate` (null when none was asked, so
 * every policy hears), and the tightest Limit they answered. Mirrors
 * Python's `pre_network_gate`.
 */
export async function preNetworkGate(
  policies: Policies,
  ctx: NetworkContext,
): Promise<[readonly Policy[] | null, Limit | null]> {
  if (
    explaining() === DryRun.DECIDING ||
    !(await policies.wantsFor('preNetwork', ctx.sessionId ?? ''))
  ) {
    return [null, null]
  }
  const asked = { ...ctx, caller: policyCaller(currentCaller().session, policies.account) }
  const passed: Policy[] = []
  let answer: Deny | Ask | null
  let limit: Limit | null
  try {
    ;[answer, limit] = await apart(() => policies.preNetwork(asked, passed))
  } catch (err) {
    await runLanding(() =>
      postNetworkGate(
        policies,
        { ...asked, bytesSent: 0, bytesReceived: 0, seconds: 0, ended: 'error' },
        passed,
      ),
    )
    throw err
  }
  if (answer !== null) {
    await postNetworkGate(
      policies,
      { ...asked, bytesSent: 0, bytesReceived: 0, seconds: 0, ended: 'refused' },
      passed,
    )
    const refused: Deny = answer.kind === 'deny' ? answer : { kind: 'deny', reason: answer.reason }
    throw policyDenied(refused, ctx.host === '' ? ctx.address : ctx.host)
  }
  return [passed, limit]
}

/**
 * Fire postNetwork once a connection is over, for every policy among
 * `passed` (null for every policy), each asked past another's answer.
 * Mirrors Python's `post_network_gate`.
 */
export async function postNetworkGate(
  policies: Policies,
  ctx: NetworkResultContext,
  passed: readonly Policy[] | null = null,
): Promise<void> {
  if (
    explaining() === DryRun.DECIDING ||
    !(await policies.wantsFor('postNetwork', ctx.sessionId ?? ''))
  ) {
    return
  }
  const ended = { ...ctx, caller: policyCaller(currentCaller().session, policies.account) }
  await apart(() => policies.postNetwork(ended, passed))
}

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
 * The chain holds the decision ledger an Ask is put to (`decisions`),
 * `views`, which the workspace sets to fill a method's read-only `session`
 * and `vfs`, and `account`, which a server sets to the account it holds the
 * workspace for, for every method's `caller`.
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
  account: string | null = null

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
   * every session's. `codedOnly` leaves the profile's rules out, for a
   * caller whose line's gate already answers for them.
   */
  async wantsFor(method: Method, sessionId: string, codedOnly = false): Promise<boolean> {
    const policies = this.placement === null ? this.policies : [...this.policies, this.placement]
    for (const policy of policies.filter((p) => !(codedOnly && p instanceof PermissionsPolicy))) {
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

  private async evaluate(
    method: Method,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext
      | WorkspaceContext
      | NetworkContext,
    every: boolean,
    placed = false,
    rulesOnly = false,
    projection: 'answers' | 'fire' = 'fire',
    among: readonly Policy[] | null = null,
    passed: Policy[] | null = null,
  ): Promise<CompositionResult> {
    const snapshot = [...this.policies]
    const placement = this.placement
    const policies = [...snapshot, ...(placement === null ? [] : [placement]), this.mode]
    if (policies.every((policy) => policy[method] === undefined)) {
      return { answers: [], action: null, route: null, limit: null }
    }
    const composition = new Composition()
    try {
      const hook = method.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      const descriptors = policies.map((policy, slot) => {
        const role =
          slot < snapshot.length
            ? policy instanceof PermissionsPolicy
              ? 'permissions'
              : 'registered'
            : policy === this.mode
              ? 'mount_mode'
              : 'placement'
        composition.names.set(slot, policy.constructor.name || 'policy')
        if (passed !== null && policy[method] === undefined) passed.push(policy)
        return { slot, role, hooks: among === null || among.includes(policy) ? [hook] : [] }
      })
      let seen = ctx
      const signal = callerSignal()
      composition.feed({
        op: 'evaluate',
        evaluation: composition.evaluation,
        hook,
        projection,
        every,
        placed,
        rules_only: rulesOnly,
        policies: descriptors,
      })
      composition.stream.finish()
      let pending: unknown[] = []
      let cursor = 0
      for (let effect = composition.request(); effect !== null; effect = composition.request()) {
        if (composition.respondEffect(effect, 'config' in seen ? undefined : seen)) continue
        if (effect.op !== 'run_policy' && effect.op !== 'read_action')
          throw new Error('invalid evaluation effect')
        const policy = policies[effect.slot]
        if (policy === undefined) throw new Error('invalid policy slot')
        const name = policy.constructor.name || 'policy'
        if (effect.op === 'run_policy') {
          const fn = policy[method]
          if (fn === undefined) {
            composition.respond(effect, null, name, false)
            continue
          }
          const handles =
            !rulesOnly && this.views !== null && !('config' in seen) && seen.session === undefined
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
                  SessionResultContext &
                  WorkspaceContext &
                  NetworkResultContext,
              )
            answered = await abortable(
              asyncContextIsolatesTasks ? runExplaining(DryRun.DECIDING, ask) : ask(),
              signal,
            )
          } catch (error) {
            if (hasAborted(signal)) throw makeAbortError(signal)
            if (policy === placement) throw error
            const detail = error instanceof Error ? error.message : String(error)
            console.error(`${method} policy ${name} raised: ${detail}`)
            answered = { kind: 'deny', reason: `${name} failed`, policy: name, failed: true }
          }
          const items: unknown[] = Array.isArray(answered) ? answered : [answered]
          if (items.every((item) => item === null || item instanceof Limit)) passed?.push(policy)
          pending = Array.isArray(answered) ? answered : [answered]
          cursor = 0
        }
        if (hasAborted(signal)) throw makeAbortError(signal)
        const item = cursor < pending.length ? pending[cursor] : null
        cursor += 1
        composition.respond(effect, item, name, cursor < pending.length)
      }
      return composition.result(method)
    } finally {
      composition.close()
    }
  }

  private async fire(
    method: Method,
    ctx:
      | CommandContext
      | RouteContext
      | VfsContext
      | VfsResultContext
      | ExecuteResultContext
      | SessionContext
      | WorkspaceContext
      | NetworkContext,
    placed = false,
    rulesOnly = false,
  ): Promise<[Deny | Ask | null, Limit | null, Route | null]> {
    const result = await this.evaluate(method, ctx, false, placed, rulesOnly)
    return [result.action, result.limit, result.route]
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
      | SessionContext
      | WorkspaceContext
      | NetworkContext,
    every = true,
    rulesOnly = false,
  ): Promise<(Deny | Ask | Route)[]> {
    const result = await this.evaluate(method, ctx, every, false, rulesOnly, 'answers')
    return result.answers
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
    const [action, , route] = await this.fire('preExecute', ctx, placed)
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

  /**
   * Fire preNetwork across the policies; the first Deny wins, else the first
   * Ask, and Limits merge to the tightest. `passed` fills, as they answer,
   * with the policies that let the connection through, and those with no
   * preNetwork.
   */
  async preNetwork(
    ctx: NetworkContext,
    passed: Policy[],
  ): Promise<[Deny | Ask | null, Limit | null]> {
    const result = await this.evaluate('preNetwork', ctx, false, false, false, 'fire', null, passed)
    return [result.action, result.limit]
  }

  /**
   * Fire postNetwork across the policies among `among` (null for every one),
   * every one asked; none answers, since the connection is already over.
   */
  async postNetwork(
    ctx: NetworkResultContext,
    among: readonly Policy[] | null = null,
  ): Promise<void> {
    await this.evaluate('postNetwork', ctx, true, false, false, 'fire', among)
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

  /** Fire preWorkspace across the policies; the first Deny wins. */
  async preWorkspace(ctx: WorkspaceContext): Promise<Deny | null> {
    const [action] = await this.fire('preWorkspace', ctx)
    return action?.kind === 'deny' ? action : null
  }

  /** Fire postSession across the policies; the first Deny wins, else the first Ask. */
  async postSession(ctx: SessionResultContext): Promise<Deny | Ask | null> {
    const [action] = await this.fire('postSession', ctx)
    return action
  }
}

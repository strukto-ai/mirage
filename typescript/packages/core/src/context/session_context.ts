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

import { fromUnits, units, visibilityMatcher } from '../rs/policy.ts'
import { mergeSignals } from '../utils/abort.ts'
import type { SessionAccess } from '../view/types.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import type { ByteSource, IOResult, OpReport } from '../io/types.ts'
import type { Redirect } from '../shell/types.ts'
import type { JobConsole } from '../shell/console/index.ts'
import type { ExecutionNode } from '../workspace/types.ts'
import type { EvaluationContext } from '../workspace/evaluation.ts'
import type { SessionState } from '../workspace/session/session.ts'
import type { ProcessHandle } from '../process/handle.ts'
import { rstripSlash } from '../utils/slash.ts'
import { leadsHidden, pathVisible } from '../utils/hidden.ts'
import { eacces, enoent, erofs } from '../errors/fs.ts'
import { norm, parent } from '../utils/path.ts'
import type { DecisionOwner, DryRun, EntryGate, HandOff, VfsExplanation } from '../policy/types.ts'
import type { OpRecord } from '../observe/record.ts'
import type { PathSpec, Refusal, Visibility, WalkProbe } from '../types.ts'
import { MountMode, weakerMode } from '../types.ts'

/** Whoever binds sessions: one per workspace, compared by identity. */
export abstract class SessionOwner {
  /** The session this owner holds under `sessionId`. */
  abstract get(sessionId: string): SessionState
}

/** Where a refusal an entry point raises is noted for the line running it. */
export type RefusalSink = (refusal: Refusal) => void

/** Runs a prepared command under ordered redirects, gating each target. */
export type RedirectResult = [ByteSource | null, IOResult, ExecutionNode]
export type RedirectRun = (
  stdin: ByteSource | null,
  sink: JobConsole | undefined,
  paths: readonly PathSpec[],
) => Promise<RedirectResult>
export type RedirectGuard = (
  paths: readonly PathSpec[],
  stdin: ByteSource | null,
) => Promise<RedirectResult | null>
export type RedirectRunner = (
  run: RedirectRun,
  guard: RedirectGuard | undefined,
  name: string,
  args: readonly string[],
) => Promise<RedirectResult>

/**
 * One running line: its signal and the sessions its statements stamp
 * on (the target session and the per-call fork, one object when the
 * call named no cwd or env). Bound by `shell` for the line's duration
 * and read at the status write. It rides the async context rather than
 * the session, so two lines on one session each see their own, and a
 * statement that settles after its caller was released still reads the
 * signal of the line that produced it.
 */
export interface LineAbortFrame {
  signal: AbortSignal | undefined
  sessions: readonly SessionState[]
  writer: symbol
}

/**
 * Who makes a call, and what every check on it needs to know: the
 * session, and the line, job, command and file call it runs in.
 *
 * One record per call, never shared. Each layer is a copy of the one
 * above with its own fields set, so two calls running at once each hold
 * their own, and work that runs after its command returned (a stream
 * pulled later, a runtime's callback) keeps the record it was made with.
 * `owner` is the session manager the session belongs to, one per
 * workspace; `evaluation` the evaluation running on the session, which a
 * layer bound to another session never carries. The fields whose type
 * lives in a module that reads the caller (the policies, the
 * recording and the cache bindings) are
 * added in that module, so this one imports none of them. Mirrors
 * Python's Caller.
 */
export interface Caller {
  readonly lineAbort: LineAbortFrame | null
  readonly session: SessionState | null
  readonly owner: SessionOwner | null
  readonly evaluation: EvaluationContext | null
  readonly call: readonly [DecisionOwner, HandOff, string] | null
  readonly gate: EntryGate | null
  // The gate the dispatcher judges the paths of this call by: the
  // command's own calls carry it, the shell's own I/O around them does not.
  readonly ruleGate: EntryGate | null
  readonly mount: readonly [string, MountMode] | null
  readonly refusals: RefusalSink | null
  readonly explaining: VfsExplanation[] | DryRun | null
  readonly walkProbe: readonly [string, WalkProbe] | null
  readonly redirects:
    | readonly [object, readonly PathSpec[], RedirectRunner | null, readonly Redirect[]]
    | null
  readonly program: SessionState | null
  readonly stop: AbortController | null
  readonly writeHeld: boolean
  // The running command's own records, and those of the command it runs in.
  readonly commandSink: readonly [OpRecord[] | null, OpRecord[]] | null
  // When the running command started.
  readonly started: number | null
  // The recorder of the innermost level running a command, for a level whose
  // output is a value (a substitution's) to send another level's stream
  // bytes toward it.
  readonly enclosing: JobConsole | null
  // The execution (a line, a job, a spawned process) the call runs in,
  // which its records name.
  readonly execution: string | null
  // The managed runner the call runs in, whose kill signal a native
  // program it started receives.
  readonly process: ProcessHandle | null
}

/**
 * A dispatch that takes who makes the op: the dispatcher's own, and each
 * workspace function that hands it a caller. The runtime's DispatchFn
 * leaves the caller out, as no runtime passes one; Python's carries it
 * through its keywords.
 */
export type CallerDispatchFn = (
  name: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
  report?: OpReport,
  caller?: Caller,
) => Promise<[unknown, IOResult]>

const UNBOUND: Caller = {
  session: null,
  owner: null,
  evaluation: null,
  gate: null,
  ruleGate: null,
  mount: null,
  refusals: null,
  explaining: null,
  walkProbe: null,
  redirects: null,
  program: null,
  call: null,
  stop: null,
  writeHeld: false,
  lineAbort: null,
  recording: null,
  revisions: null,
  commandSink: null,
  cache: null,
  readFacts: null,
  write: null,
  ownVersion: null,
  started: null,
  enclosing: null,
  execution: null,
  process: null,
}

const callerStorage = createAsyncContext<Caller>()

/** The caller bound to the current async context. */
export function currentCaller(): Caller {
  return callerStorage.getStore() ?? UNBOUND
}

/**
 * Every caller live in this context, oldest first: on an isolating
 * runtime the bound one alone, on the fallback storage every
 * concurrently bound one.
 */
export function liveCallers(): readonly Caller[] {
  return callerStorage.liveStores()
}

/**
 * Run `fn` with `caller` bound: a layer's own copy, or the record a
 * stream pulled or a callback run after its command returned was made
 * with.
 */
export function runWithCaller<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(callerStorage.run(caller, fn))
}

/**
 * `fn` run as `caller` wherever it is called from: a runtime's guest asks
 * its questions from a callback of its own, which carries no caller.
 */
export function callsAs<A extends unknown[], R>(
  caller: Caller,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args) => callerStorage.run(caller, () => fn(...args)) as R
}

/** `fn` run as `caller` whoever awaits it. */
export function awaitsAs<A extends unknown[], R>(
  caller: Caller,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args) => runWithCaller(caller, () => fn(...args))
}

/**
 * `source` pulled and closed as `caller`. A stream keeps the caller it was
 * made with: whoever pulls it and however late (a reader further down a
 * pipeline, a host draining a line's output), what each pull runs (a
 * backend's lazy read, the record it makes, the pins and cache scope it
 * reads) is that caller's, and so is the close a reader that stops early
 * sends. Mirrors Python's `with_caller`.
 */
export async function* withCaller<T>(source: AsyncIterable<T>, caller: Caller): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await runWithCaller(caller, () => iterator.next())
      if (next.done === true) return
      yield next.value
    }
  } finally {
    const finish = iterator.return?.bind(iterator)
    if (finish !== undefined) await runWithCaller(caller, () => finish())
  }
}

/** The execution the current call runs in; never a sibling's on hosts
 * without task isolation. */
export function currentExecutionId(): string | null {
  const id = currentCaller().execution
  if (
    id === null ||
    liveCallers().some((caller) => caller.execution !== null && caller.execution !== id)
  ) {
    return null
  }
  return id
}

/**
 * Run `run` as part of the execution `executionId`, which its records name.
 *
 * @param process the managed runner it is, when it is one.
 */
export function runWithExecution<T>(
  executionId: string,
  run: () => Promise<T>,
  process: ProcessHandle | null = null,
): Promise<T> {
  return runWithCaller({ ...currentCaller(), execution: executionId, process }, run)
}

function runChanged<T>(changes: Partial<Caller>, fn: () => Promise<T>): Promise<T> {
  return runWithCaller({ ...currentCaller(), ...changes }, fn)
}

/**
 * Bind `session` for the duration of `fn`.
 *
 * `owner` names the manager the session belongs to; omitting it keeps the
 * owner already bound, so a nested bind inside a line (a background job's
 * fork) stays attributed to the workspace running it. `evaluation` is the
 * evaluation running on the session; omitting it keeps the one already
 * bound when it runs on this same session, and drops another session's.
 */
export function runWithSession<T>(
  session: SessionState,
  fn: () => Promise<T>,
  options: { owner?: SessionOwner; evaluation?: EvaluationContext } = {},
): Promise<T> {
  const bound = currentCaller()
  return runChanged(
    {
      session,
      owner: options.owner ?? bound.owner,
      evaluation: options.evaluation ?? (bound.session === session ? bound.evaluation : null),
    },
    fn,
  )
}

export function getCurrentSession(): SessionState | null {
  return currentCaller().session
}

/**
 * Every line frame live in this context, oldest first, each once: on the
 * fallback storage the layers of one line each copy its frame.
 */
export function lineFrames(): LineAbortFrame[] {
  return [
    ...new Set(
      liveCallers().flatMap((caller) => (caller.lineAbort === null ? [] : [caller.lineAbort])),
    ),
  ]
}

/**
 * The active line's cancellation channel, when it can be attributed to this
 * session: the one line live on it, or the one signal every live line on it
 * answers to, as an `eval` or `source` line carries the line that runs it.
 */
export function lineSignal(session: SessionState): AbortSignal | undefined {
  const signals = new Set(
    lineFrames()
      .filter((frame) => frame.sessions.includes(session))
      .map((frame) => frame.signal),
  )
  return signals.size === 1 ? [...signals][0] : undefined
}

/**
 * The signal the current call answers to: its evaluation frame's and its
 * line's, which withdraw a pipe read or copy that waits; Python cancels the
 * awaiting task instead.
 */
export function callerSignal(): AbortSignal | undefined {
  const session = getCurrentSession()
  return mergeSignals(
    getCurrentEvaluation()?.frame.abortSignal,
    session === null ? undefined : lineSignal(session),
  )
}

/** Bind an evaluation with its session, as one binding. */
export function runWithEvaluation<T>(
  context: EvaluationContext,
  fn: () => Promise<T>,
  owner?: SessionOwner,
): Promise<T> {
  return runWithSession(context.session, fn, {
    ...(owner === undefined ? {} : { owner }),
    evaluation: context,
  })
}

/**
 * The evaluation bound with the current session, null outside one.
 *
 * On an isolating runtime that is the task's own binding. On the fallback
 * storage it is the newest live binding that carries one: a bind for
 * another session without an evaluation (a held dispatcher's) may be the
 * newest frame, and must not answer a running line with none, which would
 * skip that line's abort checks. Mirrors Python's get_current_evaluation.
 */
export function getCurrentEvaluation(): EvaluationContext | null {
  const callers = liveCallers()
  for (let at = callers.length - 1; at >= 0; at--) {
    const evaluation = callers[at]?.evaluation
    if (evaluation !== undefined && evaluation !== null) return evaluation
  }
  return null
}

/**
 * Every session whose binding is live in this context, oldest first.
 *
 * On an isolating runtime this is the bound session alone, so a fold
 * over it computes exactly what `getCurrentSession` implies. On the
 * fallback storage it is every concurrently bound session, which is
 * what lets a security predicate merge toward the most restrictive
 * answer instead of trusting the newest binding: every predicate here
 * fails open on "no session", so a frame another task shadows or
 * settles past must keep counting while it is live.
 */
export function liveSessions(): SessionState[] {
  return liveCallers().flatMap((caller) => (caller.session === null ? [] : [caller.session]))
}

/**
 * The bound session, but only when `owner` published it.
 *
 * A session carries one workspace's cwd, env and mount grants, so a
 * second workspace re-entered mid-line must resolve its own session
 * rather than adopt this one. The owner is the disambiguator, so every
 * live binding is searched, newest first: on the fallback storage a
 * concurrent workspace's bind shadowing the newest frame must not hide
 * this owner's own session.
 */
export function getCurrentSessionFor(owner: SessionOwner): SessionState | null {
  const callers = liveCallers()
  for (let at = callers.length - 1; at >= 0; at--) {
    const caller = callers[at]
    if (caller?.owner === owner) return caller.session
  }
  return null
}

/**
 * The bound session, unless another owner published it.
 *
 * An entry point keeps the session it is reached under, so it never widens
 * a caller's view: a command's runtime, a kernel mount and a guest
 * runtime all bind before they call. A binding that names an owner
 * other than `owner` is another workspace's, and its session describes
 * that workspace's hides and grants, so the entry point must not adopt it. A
 * binding that names no owner is a deliberate placement (a kernel
 * mount, a guest runtime, an embedder binding by hand) and is kept.
 */
export function getCurrentSessionUnlessForeign(owner: SessionOwner): SessionState | null {
  const caller = currentCaller()
  if (caller.owner !== null && caller.owner !== owner) return null
  return caller.session
}

/**
 * The current session's mode for this mount.
 *
 * `MountMode.EXEC` (no narrowing) when no session is bound, when the
 * profile names no mount, or when it names none for this one: a profile's
 * mount sections narrow what the mount already offers and never decide
 * whether it exists. A profile that must not reach a mount hides it, which
 * answers ENOENT rather than a permission error naming something the
 * profile cannot see. Folded to the weakest across every live session,
 * which on an isolating runtime is the bound one alone.
 */
function sessionModeOf(sess: SessionAccess, mountPrefix: string): MountMode {
  if (sess.mountModes == null) return MountMode.EXEC
  return sess.mountModes.get(norm(mountPrefix)) ?? MountMode.EXEC
}

function sessionMode(mountPrefix: string): MountMode {
  let mode: MountMode = MountMode.EXEC
  for (const sess of liveSessions()) {
    mode = weakerMode(mode, sessionModeOf(sess, mountPrefix))
  }
  return mode
}

export const DEFAULT_UMASK = 0o022

/** The owner's creation mask, or the ambient mask when no owner is supplied.
 * Unbound browser calls OR every live session's mask so an overlapping
 * wider session cannot relax permissions. No live session means bash's default. */
export function sessionUmask(access?: SessionAccess): number {
  if (access !== undefined) return access.umask
  const live = liveSessions()
  if (live.length === 0) return DEFAULT_UMASK
  let mask = 0
  for (const sess of live) mask |= sess.umask
  return mask
}

/** Whether the owner's pathname expansion includes leading dots.
 * Unbound browser calls require every live session to opt in; no live
 * session means bash's default, off. */
export function dotglobActive(access?: SessionAccess): boolean {
  if (access !== undefined) return access.shopts.dotglob === true
  const live = liveSessions()
  return live.length > 0 && live.every((sess) => sess.shopts.dotglob === true)
}

/** Whether the owner's patterns use extglob grammar. Without an explicit
 * owner, read the evaluating session; no session means bash's default, off. */
export function extglobActive(access?: SessionAccess): boolean {
  if (access !== undefined) return access.shopts.extglob === true
  return getCurrentSession()?.shopts.extglob === true
}

/** The owner's visibility, or the ambient view when no owner is supplied.
 * Unbound browser calls combine live sessions' hides and keep only shows
 * they all grant. An explicit unrestricted owner stays unrestricted. */
export function sessionVisibility(access?: SessionAccess): Visibility | null {
  if (access !== undefined) return access.visibility
  const live = liveSessions().map((sess) => sess.visibility)
  const first = live[0]
  if (first === undefined) return null
  if (live.every((vis) => vis === first)) return first
  const hiding = live.filter((vis) => vis.paths != null)
  const shown = (hiding[0]?.shown?.entries ?? []).filter((entry) =>
    hiding.every((vis) => (vis.shown?.entries ?? []).some((e) => e.path === entry.path)),
  )
  const paths = hiding.flatMap((vis) => vis.paths?.paths ?? [])
  const patterns = hiding.flatMap((vis) => vis.paths?.patterns ?? [])
  const names = live.flatMap((vis) => vis.vars?.names ?? [])
  const varPatterns = live.flatMap((vis) => vis.vars?.patterns ?? [])
  return {
    paths: hiding.length === 0 ? null : { paths, patterns },
    shown: shown.length === 0 ? null : { entries: shown },
    vars: names.length + varPatterns.length === 0 ? null : { names, patterns: varPatterns },
    processes: live.every((vis) => vis.processes === 'workspace') ? 'workspace' : 'session',
  }
}

/**
 * The error a hidden path answers, in POSIX's own terms.
 *
 * ENOENT names a component that does not exist and EACCES an entry the
 * caller may not write, so a create is EACCES only when the directory
 * it lands in is visible: a hidden name under a visible parent reads
 * as an existing file the session cannot write, which is the one
 * answer that neither reveals the content nor invites a create that
 * would clobber it. A create under a hidden directory is ENOENT, the
 * same answer every read gives for that directory, so a write cannot
 * detect a hide a read could not. Everything that is not a create is
 * ENOENT. `create` is whether the op creates the path it names; a
 * rename or copy destination is one. `links` are the namespace's links, so
 * a directory reached through a link into hidden space counts as hidden.
 */
export function hiddenRefusal(
  vis: Visibility | null,
  virtual: string,
  create: boolean,
  links: ReadonlyMap<string, string> = new Map(),
): Error {
  const above = parent(rstripSlash(virtual) || '/')
  if (create && pathVisible(vis, above) && !leadsHidden(vis, above, links)) return eacces(virtual)
  return enoent(virtual)
}

/**
 * Bind the admitted command's entry gate for the duration of `fn`: the
 * run of that one command.
 *
 * Bound by the dispatcher once the gate let the command through, so a
 * nested line (`xargs`, `find -exec`, `eval`) binds its own and the outer
 * command gets its gate back when it returns, and a pipeline stage in
 * its own async context never sees a sibling's.
 */
export function runWithAdmission<T>(gate: EntryGate, fn: () => Promise<T>): Promise<T> {
  return runChanged({ gate }, fn)
}

/**
 * The entry gate of the command running in this context, null when no
 * admitted command is bound (a command constructed outside the
 * dispatcher, or a line no gate judged).
 *
 * On an isolating runtime one gate is live and answers as bound. On
 * the fallback storage several commands' gates can be live at once
 * with nothing to say whose op is asking, so they merge toward
 * refusal: an entry must pass every live gate's `check`, its `refusal` is
 * the first live gate's that refuses it, and a rule counts
 * as granted only when every live gate carries it (a once-grant nodded
 * for one line must not authorize another's dispatcher), and a path as
 * judged only when every live gate names it. `scopes` is true when any
 * live gate scopes, keeping walks off the unfiltered native fast paths.
 */
export function getAdmission(): EntryGate | null {
  const gates = liveCallers().flatMap((caller) => (caller.gate === null ? [] : [caller.gate]))
  const first = gates[0]
  if (first === undefined) return null
  if (gates.every((gate) => gate === first)) return first
  return {
    granted: first.granted.filter((rule) => gates.every((gate) => gate.granted.includes(rule))),
    judged: new Set([...first.judged].filter((p) => gates.every((gate) => gate.judged.has(p)))),
    check(virtual: string): void {
      for (const gate of gates) gate.check(virtual)
    },
    scopes(virtual: string): boolean {
      return gates.some((gate) => gate.scopes(virtual))
    },
    refusal(virtual: string): string | null {
      for (const gate of gates) {
        const reason = gate.refusal(virtual)
        if (reason !== null) return reason
      }
      return null
    },
  }
}

/**
 * Bind the executing mount's prefix and configured mode for the
 * duration of `fn`: the run of one command.
 *
 * Bound by `Mount.runCommand` around the handler: it is how a command
 * tells its run on one mount from a run across mounts, which binds none
 * (`crossesMounts`), and the prefix a path it makes up is keyed below
 * (`mountRoot`).
 */
export function runWithMountGate<T>(
  prefix: string,
  mode: MountMode,
  fn: () => Promise<T>,
): Promise<T> {
  return runChanged({ mount: [prefix, mode] }, fn)
}

/**
 * Bind where the entry points note a policy's refusal, for the duration of `fn`:
 * one line's run.
 *
 * Bound by the workspace around a typed line: a command renders an op
 * refusal in its own GNU words, which say nothing of the policy, so the
 * entry point notes the record here and the line carries it on its result.
 * Every task and nested line the line starts inherits the binding, so a
 * stream drained after its command returned still reaches it. Mirrors
 * Python's set_refusal_sink.
 */
export function runWithRefusalSink<T>(sink: RefusalSink, fn: () => Promise<T>): Promise<T> {
  return runChanged({ refusals: sink }, fn)
}

/**
 * Whether a typed line is running in this context: the entry point it reaches is
 * inside a command, not a file tool's or the host's own call. Mirrors
 * Python's `line_running`.
 */
export function lineRunning(): boolean {
  return currentCaller().refusals !== null
}

/**
 * Run `fn` as a dry run: the op gate notes on `trace` what it would
 * answer and stops the op before any backend or cache is touched.
 * `DryRun.DECIDING` is what a policy does while it decides the op
 * explained: its reads run, nothing changes. A null trace runs `fn` for
 * real. Mirrors Python's `set_explaining`.
 */
export function runExplaining<T>(
  trace: VfsExplanation[] | DryRun | null,
  fn: () => Promise<T>,
): Promise<T> {
  return runChanged({ explaining: trace }, fn)
}

/**
 * The dry run's trace when the calls in this context only explain,
 * DECIDING while its policies decide, null when they run.
 */
export function explaining(): VfsExplanation[] | DryRun | null {
  return currentCaller().explaining
}

/**
 * Hand an entry point's refusal to the line running in this context; an entry point
 * reached outside any line (a programmatic op) has no line to tell, and
 * the record rides the thrown error alone.
 */
export function noteRefusal(refusal: Refusal): void {
  currentCaller().refusals?.(refusal)
}

/**
 * The walk probe bound to the command serving `virtual`, null outside a
 * mount's command (a generic invoked directly in a test).
 *
 * Selected among every live binding by the path itself, the longest prefix
 * covering it winning as the mount table routes, so on the fallback storage
 * a concurrent command on another mount cannot lend its probe to this one.
 * Mirrors Python's get_walk_probe.
 */
export function walkProbeFor(virtual: string): WalkProbe | null {
  const v = norm(virtual)
  let bestLen = -1
  let best: WalkProbe | null = null
  for (const [rawPrefix, probe] of liveCallers().flatMap((caller) =>
    caller.walkProbe === null ? [] : [caller.walkProbe],
  )) {
    const prefix = norm(rawPrefix)
    if (prefix !== '/' && v !== prefix && !v.startsWith(prefix + '/')) continue
    if (prefix.length > bestLen) {
      bestLen = prefix.length
      best = probe
    }
  }
  return best
}

/**
 * Bind a statement's expanded redirect targets to the command node they
 * belong to, for the duration of `fn` (that node's run).
 *
 * The redirect layer expands the targets before the command executes (a
 * `$()` in one runs exactly once there), so the admission gate deep in
 * command dispatch cannot re-derive them; it reads them here instead.
 * Keyed by the node object itself so a nested line expanded on the way
 * to the command (a `$()` operand, an `eval`) never inherits the outer
 * statement's targets.
 *
 * The runner applies redirects after command words expand, admitting each
 * resolved target before opening it. Nested expansions keep their own identity.
 */
export function runWithRedirectPaths<T>(
  node: object,
  paths: readonly PathSpec[],
  fn: () => Promise<T>,
  runner: RedirectRunner | null = null,
  syntax: readonly Redirect[] = [],
): Promise<T> {
  return runChanged({ redirects: [node, paths, runner, syntax] }, fn)
}

/** The caller a deferred workspace callback runs as: the bound one, as
 * `session` when one is named, whose evaluation comes along only when it
 * is the session bound now. */
export function sessionCaller(session: SessionState, owner?: SessionOwner): Caller {
  const bound = currentCaller()
  return {
    ...bound,
    session,
    owner: owner ?? null,
    evaluation: bound.session === session ? bound.evaluation : null,
  }
}

/**
 * Run a line as a program run in a session: `find -exec` hands its words
 * to `execvp`, so the head it runs is the coreutils program, not the
 * shell's builtin of the same name (`printf -v` is a format string there,
 * not an assignment). Keyed by the session object, which the child shells
 * it starts inherit, and cleared again by a nested shell the line starts
 * (`-exec sh -c ...`), so that shell's builtins are its own.
 */
export function runAsProgram<T>(session: SessionState, fn: () => Promise<T>): Promise<T> {
  return runChanged({ program: session }, fn)
}

/** Run a nested shell's script as the shell's own again: a nested shell
 * is a program, and the builtins it runs are its builtins, `printf -v`
 * included. */
export function runAsShell<T>(fn: () => Promise<T>): Promise<T> {
  return runChanged({ program: null }, fn)
}

/** Whether the line running in this session is a program run. */
export function isProgramInvocation(session: SessionState): boolean {
  const caller = currentCaller()
  const marked = caller.program
  if (marked === null) return false
  if (session === marked) return true
  if (caller.session !== session) return false
  for (let parent = caller.evaluation?.parent ?? null; parent !== null; parent = parent.parent)
    if (parent.session === marked) return true
  return false
}

/**
 * The redirect targets bound to this command node, empty for any other
 * node or when none are bound.
 *
 * The node is the disambiguator, so every live binding is searched,
 * newest first: on the fallback storage a concurrent statement's bind
 * shadowing the newest frame must not hide this node's own targets.
 */
export function redirectPathsFor(node: object): readonly PathSpec[] {
  const bindings = liveCallers().flatMap((caller) =>
    caller.redirects === null ? [] : [caller.redirects],
  )
  for (let at = bindings.length - 1; at >= 0; at--) {
    const bound = bindings[at]
    if (bound?.[0] === node) return bound[1]
  }
  return []
}

/** Pending redirects, before a rewritten command reaches admission. */
export function redirectSyntaxFor(node: object): readonly Redirect[] {
  const bindings = liveCallers().flatMap((caller) =>
    caller.redirects === null ? [] : [caller.redirects],
  )
  for (let at = bindings.length - 1; at >= 0; at--) {
    const bound = bindings[at]
    if (bound?.[0] === node) return bound[3]
  }
  return []
}

/**
 * The runner bound with this command node's redirect targets, null for any
 * other node or when none is bound.
 */
export function redirectRunnerFor(node: object): RedirectRunner | null {
  const bindings = liveCallers().flatMap((caller) =>
    caller.redirects === null ? [] : [caller.redirects],
  )
  for (let at = bindings.length - 1; at >= 0; at--) {
    const bound = bindings[at]
    if (bound?.[0] === node) return bound[2]
  }
  return null
}

/**
 * Whether a path is a redirect target command admission already judged
 * for the statement writing it now.
 *
 * The dispatcher asks this, and unlike `redirectPathsFor` it takes no node,
 * because by the time the shell writes the file the node has returned
 * and the dispatcher sees only a path. The binding is what keeps that honest: it
 * exists only while one statement's targets are being written, and a
 * statement whose targets a rule refused never reaches the write at all.
 * So a bound target is one the line was admitted with, and re-deriving a
 * verdict for it from the dispatcher, which knows neither the line nor the nod it
 * holds, can only get it wrong. Every live binding counts, because a
 * target is only ever bound after its own line's admission judged it: on the
 * fallback storage a concurrent statement's frame must not shadow this
 * one's targets into a re-derived refusal.
 */
export function redirectTargetJudged(virtual: string): boolean {
  return liveCallers().some(
    (caller) => caller.redirects?.[1].some((p) => p.virtual === virtual) === true,
  )
}

/**
 * The mount mode after narrowing by the owner's profile, or the live
 * sessions' when no owner is supplied. The mount's own mode is the
 * strongest one available; a profile's mode can only weaken it (a READ
 * mount stays read-only whatever the profile says). A mount the profile
 * does not name keeps its own mode.
 */
export function effectiveMountMode(
  mountPrefix: string,
  mountMode: MountMode,
  access?: SessionAccess,
): MountMode {
  return weakerMode(
    mountMode,
    access === undefined ? sessionMode(mountPrefix) : sessionModeOf(access, mountPrefix),
  )
}

/**
 * The mode in force at one path: the whole VFS axis on the one
 * anchor-depth rule.
 *
 * The mount's configured mode is narrowed by the deepest session
 * statement covering the path, where a statement is the profile's
 * per-mount mode (scored at the mount prefix's own depth) or a
 * mode-carrying show entry (scored at its anchor depth). Deeper wins,
 * so `mounts: {/repo: r}` with `show: {"/repo/build": rw}` reads the
 * repo and writes only the build tree; an equal-depth pair takes the
 * weaker, failing toward refusal. The configured mode stays the
 * strongest answer possible: the document never grants past it.
 * Folded to the weakest across every live session, which on an
 * isolating runtime is the bound one alone.
 */
function pathModeUnder(
  sess: SessionAccess,
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
): MountMode {
  const prefix = norm(mountPrefix)
  const cap = sess.mountModes?.get(prefix) ?? null
  if (cap === null && sess.visibility?.shown == null) return mountMode
  return visibilityMatcher(sess.visibility ?? null).ask('effective_mode', {
    path: units(virtual),
    prefix: units(prefix),
    configured: mountMode,
    cap,
  }) as MountMode
}

export function effectivePathMode(
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
  access?: SessionAccess,
): MountMode {
  if (access !== undefined) return pathModeUnder(access, virtual, mountPrefix, mountMode)
  let mode = mountMode
  for (const sess of liveSessions()) {
    mode = weakerMode(mode, pathModeUnder(sess, virtual, mountPrefix, mountMode))
  }
  return mode
}

/**
 * The strongest mode one session reaches anywhere under a mount: its
 * mount-wide mode, or a deeper show grant, still capped by the mount's
 * configured mode. Mirrors the Python `strongest_under_session`.
 */
export function strongestUnderSession(
  sess: SessionAccess,
  mountPrefix: string,
  mountMode: MountMode,
): MountMode {
  const prefix = norm(mountPrefix)
  const cap = sess.mountModes?.get(prefix) ?? null
  if (cap === null && sess.visibility?.shown == null) return mountMode
  return visibilityMatcher(sess.visibility ?? null).ask('strongest_mode', {
    prefix: units(prefix),
    configured: mountMode,
    cap,
  }) as MountMode
}

/**
 * The strongest mode the live sessions reach anywhere under a mount
 * (`strongestUnderSession`), folded to the weakest across them: a command
 * runs only when every live session would let it.
 *
 * What the whole-mount gates read: a write command stays runnable on a
 * mount whose only writable region is a show entry (the dispatcher then
 * refuses per path), and the interpreters' any-`x` rule counts a show
 * grant the way it counts a whole mount.
 */
export function strongestModeUnder(
  mountPrefix: string,
  mountMode: MountMode,
  access?: SessionAccess,
): MountMode {
  if (access !== undefined) return strongestUnderSession(access, mountPrefix, mountMode)
  let best = mountMode
  for (const sess of liveSessions()) {
    best = weakerMode(best, strongestUnderSession(sess, mountPrefix, mountMode))
  }
  return best
}

/**
 * The path to blame when a subtree mutation reaches into a read-only
 * region below its operand, null when nothing below is weaker.
 *
 * The dual of the per-path check, for the ops that mutate a whole
 * subtree in one backend call (`rm -r`, a directory rename, a native
 * `cp -r`): the operand's own region may grant writes while a
 * mode-carrying show entry holds a deeper subtree to `r`, and the
 * backend cannot honor that boundary mid-call, so the caller refuses
 * the operand up front. An exact entry is blamed by its anchor, the
 * row GNU would report the refusal on; a pattern names no single
 * anchor, so the operand itself is blamed whenever the pattern's
 * match space could reach below it, failing toward refusal. The first
 * blame any live session raises answers.
 */
function readonlyBelowUnder(
  sess: SessionAccess,
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
): string | null {
  if (sess.visibility?.shown == null) return null
  const prefix = norm(mountPrefix)
  const found = visibilityMatcher(sess.visibility).ask('readonly_below', {
    path: units(virtual),
    prefix: units(prefix),
    configured: mountMode,
    cap: sess.mountModes?.get(prefix) ?? null,
  }) as number[] | null
  return found === null ? null : fromUnits(found)
}

export function readonlyBelow(
  virtual: string,
  mountPrefix: string,
  mountMode: MountMode,
  access?: SessionAccess,
): string | null {
  if (access !== undefined) return readonlyBelowUnder(access, virtual, mountPrefix, mountMode)
  for (const sess of liveSessions()) {
    const blame = readonlyBelowUnder(sess, virtual, mountPrefix, mountMode)
    if (blame !== null) return blame
  }
  return null
}

/** Apply the same mode ceiling to command, dispatcher and namespace writes. */
export function requirePathsWritable(
  paths: readonly PathSpec[],
  mountPrefix: string,
  mountMode: MountMode,
  subtree = false,
  access?: SessionAccess,
): void {
  for (const path of paths) {
    if (effectivePathMode(path.virtual, mountPrefix, mountMode, access) === MountMode.READ) {
      throw erofs(path, `mount ${mountPrefix} is read-only`)
    }
  }
  if (subtree) {
    for (const path of paths) {
      const blame = readonlyBelow(path.virtual, mountPrefix, mountMode, access)
      if (blame !== null) throw erofs(blame, `mount ${mountPrefix} is read-only`)
    }
  }
}

/** Bind access to its owner before an asynchronous operation can suspend. */
export function sessionAccess(session: SessionAccess | null): SessionAccess {
  return (
    session ?? {
      sessionId: '',
      visibility: null,
      umask: DEFAULT_UMASK,
      shopts: {},
      mountModes: null,
      commandLimits: {},
    }
  )
}

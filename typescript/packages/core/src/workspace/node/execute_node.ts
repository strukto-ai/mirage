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

import { releaseFunctions } from '../session/functions.ts'
import { childSession, executionSession } from '../evaluation.ts'
import { ParseScope } from '../../shell/parse/scope.ts'

import { ExecutionScope } from '../execution.ts'
import { timingReport } from './timing.ts'
import { PathSpec } from '../../types.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'
import { runWithSession } from '../../context/session_context.ts'
import { isProgramInvocation, runAsProgram } from '../../context/session_context.ts'
import type { ProcessHandle } from '../../process/handle.ts'
import type { ProcessSupervisor } from '../../process/supervisor.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { share } from '../../io/async_line_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import { makeAbortError, mergeSignals } from '../abort.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { literalText } from '../../shell/parse/names.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { BASH_BUILTINS } from '../lookup/constants.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import {
  assignmentStatus,
  fd0Binding,
  finishStatement,
  recordStatus,
} from '../executor/statement.ts'
import {
  getCaseItems,
  getCaseWord,
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineStages,
  getRedirects,
  takeContinuation,
  getText,
  getParts,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { ERREXIT_EXEMPT_TYPES, FORK_FAILED, FORK_FAILED_STATUS } from '../../shell/constants.ts'
import { NodeType as NT, type PipelineStages, Redirect, RedirectKind } from '../../shell/types.ts'
import { NodeKind, nodeKind, pipelineTransparent } from '../../shell/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { type ExecuteFn, expandArith, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { evaluateArith } from '../../shell/arith.ts'
import type { ArithWrite } from '../../shell/types.ts'
import { ExitSignal, ArithError, ReadonlyError } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import { assignElement } from '../session/elements.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import {
  carried,
  type CforEval,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
  isUnwinding,
} from '../executor/control.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { handleTest, handleUnset } from '../executor/builtins/index.ts'
import { isValidName } from '../executor/builtins/shared.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { expandDoubleBracket, expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { installExecRedirects } from '../executor/builtins/exec/index.ts'
import { executeCommand } from './command_dispatch.ts'
import { executeAssignment } from './assignment.ts'
import { executeDeclaration } from './declaration.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { HandOff } from '../../policy/types.ts'
import type { SessionView } from '../../ops/types.ts'
import {
  ensureVarVisible,
  randomReader,
  sessionElements,
  sessionView,
  visibleEnv,
} from '../session/state.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import { drained, runStatement } from '../executor/jobs.ts'
import type { ExecuteNodeOpts } from '../executor/command/types.ts'
import { endShell } from '../executor/traps.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { encodeText } from '../../shell/bytes.ts'

const STREAMING_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.PROGRAM,
  NodeKind.COMPOUND,
  NodeKind.LIST,
  NodeKind.SUBSHELL,
  NodeKind.IF,
  NodeKind.FOR,
  NodeKind.CFOR,
  NodeKind.SELECT,
  NodeKind.WHILE,
  NodeKind.UNTIL,
  NodeKind.CASE,
  NodeKind.NEGATED,
])

type Result = [ByteSource | null, IOResult, ExecutionNode]
type Recurse = (
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<Result>

/**
 * The deps for a subtree that runs on `handed`.
 *
 * The hand-off a subtree's gates read and the one its nested
 * evaluations run under are one fact, set together here so the walker
 * can never carry one hand-off and evaluate under another. Everything a
 * command hands a line to (eval, source, xargs, command, a substitution,
 * a herestring, a redirect target) re-enters through `executeFn`, so the
 * hand-off is bound into it rather than into the line's closure: a
 * background job's subtree runs on a hand-off of the job's own, and a
 * line it evaluates after the typed line has ended has to stand under
 * that one. Under the line's, the inner gate could not see the grant the
 * job holds and asked again, and what it claimed went back to a hand-off
 * nothing revokes any more.
 */
export function withHandOff(deps: ExecuteNodeDeps, handed: HandOff): ExecuteNodeDeps {
  const inner = deps.executeFn
  const executeFn: ExecuteFn = (cmd, opts) => inner(cmd, { handed, ...opts })
  return { ...deps, handed, executeFn }
}

/**
 * Layer per-call overrides onto the walker's deps.
 *
 * Written field by field rather than spread so an explicitly undefined
 * override cannot erase a dep under exactOptionalPropertyTypes.
 */
function withOpts(base: ExecuteNodeDeps, opts?: ExecuteNodeOpts): ExecuteNodeDeps {
  if (opts === undefined) return base
  let next: ExecuteNodeDeps = { ...base }
  if (opts.sink !== undefined) next.sink = opts.sink
  if (opts.signal !== undefined) next.signal = opts.signal
  if (opts.executionScope !== undefined) {
    next.executionScope = opts.executionScope
    if (opts.executionScope !== base.executionScope && base.parser instanceof ParseScope) {
      const parser = base.parser.fork()
      opts.executionScope.own(() => {
        parser.release()
      })
      next.parser = parser
    }
  }
  if (opts.handed !== undefined) next = withHandOff(next, opts.handed)
  return next
}

/**
 * Evaluate one C-style for expression slot: the slot's integer value,
 * or the default for an empty slot (1 for the condition so `for
 * ((;;))` loops, 0 for init/update). Re-raises ArithError with the
 * expression text prepended so the loop can print bash's
 * `((: expr: reason` diagnostic, and throws ReadonlyError when the
 * expression assigns to a readonly variable.
 */
async function evalCforExpr(
  exprs: readonly TSNodeLike[],
  dflt: number,
  session: SessionState,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<number> {
  if (exprs.length === 0) return dflt
  // One comma expression, evaluated once, so an assignment early in the
  // slot is seen by the expressions after it.
  const parts: string[] = []
  for (const expr of exprs) parts.push(await expandArith(expr, session, executeFn, callStack, view))
  const text = parts.join(', ')
  const reader = randomReader(session)
  let error: ArithError | null = null
  let writes: readonly ArithWrite[] = []
  let value = 0n
  try {
    // Reads resolve against the visible env so a hidden name counts as
    // unset; a hidden write refuses through the session door
    // (ensureVarVisible), caught by the loop beside ReadonlyError.
    const result: ArithResult = evaluateArith(
      text,
      visibleEnv(session),
      0,
      sessionElements(session, reader),
      reader.read,
      reader.wrote,
    )
    writes = result.writes
    value = result.value
  } catch (err) {
    if (!(err instanceof ArithError)) throw err
    // bash bound the assignments made before the error; they land
    // before the error is reported.
    error = err
    writes = err.writes
  }
  for (const write of writes) {
    ensureVarVisible(session, write.name)
    if (session.readonlyVars.has(write.name)) throw new ReadonlyError(write.name)
  }
  // Through the door, so a preSession rule governs an arithmetic assignment
  // exactly as it governs `X=1`; in evaluation order, so a bare name and
  // its element 0 land as the expression wrote them.
  for (const write of writes) {
    await assignElement(session, view ?? null, write.name, write.key, write.value)
  }
  reader.settle()
  if (error !== null) throw new ArithError(`${text}: ${error.message}`)
  return Number(value)
}

/**
 * Recurse wrapper for a re-associated trailing redirect: the list's right
 * operand runs under the hoisted redirects, bound by the same rule in turn
 * (`runRedirected`), so a pipeline there hands them to its last command
 * and a nested list to its own right operand; targets expand only at that
 * point (after the left side ran, so cwd changes apply). Every other node
 * recurses normally.
 */
async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack, opts)
  return runRedirected(
    recurse,
    dispatch,
    executeFn,
    registry,
    right,
    [...redirects],
    signal,
    processes,
    undefined,
    session,
    stdin,
    callStack,
  )
}

/**
 * Recurse wrapper for a list the parse pulled into a pipeline's first
 * stage: the list's right operand, where the pipeline starts, runs the
 * pipeline; every other node recurses normally.
 */
async function recurseLifted(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  stages: PipelineStages,
  right: TSNodeLike,
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack, opts)
  return runPipeline(
    recurse,
    dispatch,
    executeFn,
    registry,
    stages,
    session,
    stdin,
    callStack,
    signal,
    processes,
  )
}

/**
 * Recurse wrapper for one pipeline stage. A stage the parse hoisted
 * redirects off runs under them, with the `2>&1` of a `|&` after it
 * applied last, as bash applies it after the command's own redirections;
 * a stage holding its own redirects gets that `2>&1` from
 * `recursePipeStderr`.
 */
async function recurseStage(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  stages: PipelineStages,
  targets: readonly TSNodeLike[],
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  const index = stages.commands.indexOf(node)
  const hoisted = index < 0 ? [] : (stages.redirects[index] ?? [])
  if (hoisted.length === 0) {
    return recursePipeStderr(
      recurse,
      dispatch,
      executeFn,
      registry,
      targets,
      node,
      session,
      stdin,
      callStack,
      opts,
    )
  }
  const bound = [...hoisted]
  if (targets.includes(node)) {
    bound.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  }
  return runRedirected(
    recurse,
    dispatch,
    executeFn,
    registry,
    node,
    bound,
    signal,
    processes,
    undefined,
    session,
    stdin,
    callStack,
  )
}

/**
 * Run a pipeline as bash reads it (`getPipelineStages`). A list the parse
 * pulled into the first stage runs as the list it is, its right operand
 * standing for the pipeline, so the pipeline runs only when the list's
 * operator says it does and its status is the list's. A leading `!`
 * negates the whole pipeline's status.
 */
async function runPipeline(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  stages: PipelineStages,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  signal?: AbortSignal,
  processes?: ProcessSupervisor,
): Promise<Result> {
  if (stages.lead !== null) {
    const [left, op, right] = stages.lead
    const wrapped = recurseLifted.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      { ...stages, lead: null },
      right,
      signal,
      processes,
    )
    return handleConnection(wrapped, left, op, right, session, stdin, callStack)
  }
  const targets = stages.commands.filter((_, i) => stages.stderrFlags[i] === true)
  const pipeRecurse = recurseStage.bind(
    null,
    recurse,
    dispatch,
    executeFn,
    registry,
    stages,
    targets,
    signal,
    processes,
  )
  const [stdout, io, execNode] = await handlePipe(
    pipeRecurse,
    stages.commands,
    stages.stderrFlags,
    session,
    stdin,
    callStack,
    signal,
    processes,
    executeFn,
  )
  if (!stages.negated) return [stdout, io, execNode]
  const flipped = new IOResult({
    exitCode: io.exitCode !== 0 ? 0 : 1,
    stderr: io.stderr,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
    refusal: io.refusal,
  })
  execNode.exitCode = flipped.exitCode
  session.errexitImmune = true
  return [stdout, flipped, execNode]
}

type RunLeft = (
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
) => Promise<Result>

/** What `!` makes of the statement it wraps once that has run. */
async function negated(
  rawStdout: ByteSource | null,
  io: IOResult,
  execNode: ExecutionNode,
  session: SessionState,
  inner: TSNodeLike,
): Promise<Result> {
  // Lazy exit codes (exitOnEmpty in grep) must be final before
  // inverting, or `! grep miss f` negates the provisional 0.
  const stdout = await applyBarrier(rawStdout, io, BarrierPolicy.VALUE)
  // bash reports the negated pipeline's own statuses in PIPESTATUS
  // (`! false` leaves `1`), so what `!` wraps is closed as a statement
  // of its own before `$?` inverts.
  recordStatus(session, io.exitCode, pipelineTransparent(inner))
  const flipped = new IOResult({
    exitCode: io.exitCode !== 0 ? 0 : 1,
    stderr: io.stderr,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
    refusal: io.refusal,
  })
  execNode.exitCode = flipped.exitCode
  session.errexitImmune = true
  return [stdout, flipped, execNode]
}

/**
 * Run a redirected statement: the command under its redirects, then the
 * pipeline a heredoc's operator line fed it into.
 *
 * The parse hoists a trailing redirect over whatever precedes it, so the
 * redirects are bound where bash binds them first: past a list to its
 * right operand, past a pipeline to its last stage, and inside a `!` to
 * the command it negates, recursively, until they reach the command they
 * follow.
 */
async function runRedirected(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  command: TSNodeLike | null,
  redirects: Redirect[],
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  sink: JobConsole | undefined,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (command !== null && command.type === NT.FUNCTION_DEFINITION) {
    // The redirects belong to the function, applied at each call
    // (getFunctionBody), not to the definition.
    return recurse(command, session, stdin, callStack)
  }
  if (command !== null && command.type === NT.LIST) {
    // tree-sitter hoists a trailing redirect over the whole &&/||
    // list; bash binds it to the last command:
    //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
    // Re-associate and defer target expansion until R runs, so
    // `cd /x && echo hi > f` writes under /x. R is bound by this same
    // rule, so `a && b | c < f` reaches `c`, not the pipeline. Compound
    // and subshell bodies keep the whole-body redirect (bash group
    // semantics).
    const [left, op, right] = getListParts(command)
    const wrapped = recurseReassociated.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      redirects,
      right,
      signal,
      processes,
    )
    return handleConnection(wrapped, left, op, right, session, stdin, callStack)
  }
  if (command !== null && command.type === NT.PIPELINE) {
    return runPipeline(
      recurse,
      dispatch,
      executeFn,
      registry,
      getPipelineStages(command, redirects),
      session,
      stdin,
      callStack,
      signal,
      processes,
    )
  }
  if (command !== null && command.type === NT.NEGATED_COMMAND) {
    // `! cmd < f` parses as redirected(negated(cmd), < f), but the
    // redirect is the command's: bash negates what `cmd < f` returns, a
    // redirect that failed to open included.
    const inner = getNegatedCommand(command)
    const [stdout, io, execNode] = await runRedirected(
      recurse,
      dispatch,
      executeFn,
      registry,
      inner,
      redirects,
      signal,
      processes,
      sink,
      session,
      stdin,
      callStack,
    )
    return negated(stdout, io, execNode, session, inner)
  }
  const [expandedRedirects, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
    forks(command, session),
  )
  // `exec > file` with no command installs the redirects on the shell
  // for every later statement, rather than applying them to one
  // command. `exec cmd > file` still has a command and falls through
  // to the ordinary path, which refuses the command form.
  if (isBareExec(command)) {
    return await installExecRedirects(dispatch, session, expandedRedirects, stdin)
  }
  // A heredoc's operator line reads the routed stdout, so then it is
  // returned rather than written. A simple command expands its words
  // before its redirects apply, so what that printed (a substitution's
  // stderr) goes around them; a compound body expands inside them.
  const simple =
    command !== null &&
    (command.type === NT.COMMAND ||
      command.type === NT.VARIABLE_ASSIGNMENT ||
      command.type === NT.VARIABLE_ASSIGNMENTS)
  const outer = session.diagnostics
  if (simple) session.diagnostics = []
  let stdout: ByteSource | null
  let io: IOResult
  let execNode: ExecutionNode
  try {
    ;[stdout, io, execNode] = await handleRedirect(
      simple
        ? (n, s, i, cs, opts) => recurse(n, s, i, cs, { ...opts, ownDiagnostics: false })
        : recurse,
      dispatch,
      command,
      expandedRedirects,
      session,
      stdin,
      callStack,
      false,
      pipeNode === null ? sink : undefined,
    )
    if (simple && session.diagnostics.length > 0) {
      const err = diagnosticStderr(command, session)
      io.stderr = concat([err, await io.materializeStderr()])
      execNode.stderr = concat([err, execNode.stderr])
    }
  } catch (err) {
    if (simple && err instanceof ExitSignal) {
      err.stderr = concat([diagnosticStderr(command, session), err.stderr])
    }
    throw err
  } finally {
    session.diagnostics = outer
  }
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

/**
 * Fold the `&&`/`||` steps a heredoc's operator line carried around the
 * statement, left to right.
 *
 * The last step's operator joins everything before it to its right
 * operand, so the fold is `handleConnection` with the statement's node
 * standing for that left side; `recurseContinuation` runs the remaining
 * steps when asked for it and recurses normally for the right operand.
 * The list semantics (short-circuit, `$?`, `PIPESTATUS`, `set -e`
 * immunity) are therefore the `list` node's own, not a second copy.
 */
async function runContinuation(
  recurse: Recurse,
  runLeft: RunLeft,
  left: TSNodeLike,
  steps: readonly (readonly [string, TSNodeLike])[],
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  const last = steps[steps.length - 1]
  if (last === undefined) return runLeft(session, stdin, callStack)
  const [op, right] = last
  const wrapped = recurseContinuation.bind(null, recurse, runLeft, left, steps.slice(0, -1))
  return handleConnection(wrapped, left, op, right, session, stdin, callStack)
}

async function recurseContinuation(
  recurse: Recurse,
  runLeft: RunLeft,
  left: TSNodeLike,
  steps: readonly (readonly [string, TSNodeLike])[],
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node === left)
    return runContinuation(recurse, runLeft, left, steps, session, stdin, callStack)
  return recurse(node, session, stdin, callStack)
}

async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, session, stdin, callStack, opts)
  }
  const [command, redirects] = getRedirects(node)
  redirects.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
    sessionView(session, registry.policies),
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    command,
    expanded,
    session,
    stdin,
    callStack,
  )
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

export interface ExecuteNodeDeps {
  /** @internal Scheduling scope; background jobs create their own. */
  executionScope?: ExecutionScope
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: RouteDecision
  signal?: AbortSignal
  /**
   * The hand-off this subtree runs on, carried to every command's gate
   * so it runs on the grants claimed for this line and never another's,
   * and bound into `executeFn` by `withHandOff` so every line the
   * subtree evaluates stands under it too.
   */
  handed?: HandOff
  /**
   * The shell parser. Only alias expansion needs it: an alias rewrites the
   * head word textually and the result is read as a fresh line, so a value
   * holding a pipe is a pipe. Absent (a unit test driving the walker
   * directly) means an alias definition is stored and printed but never
   * expanded.
   */
  parser?: ShellParser | ParseScope
  /**
   * Console this node writes its output to as it is produced.
   * When set, the node emits and returns no stdout; when unset
   * it returns stdout as a value, which is what capture sites
   * (command substitution, pipe stages, redirects) rely on.
   */
  sink?: JobConsole
}

/**
 * Whether a redirected statement's command is a bare `exec`: a command
 * name and no arguments, so its redirects are the shell's own rather
 * than one command's. `exec cmd` is not bare and falls through to the
 * command path, which refuses it.
 */
function isBareExec(command: TSNodeLike | null): boolean {
  if (command?.type !== NT.COMMAND) return false
  const named = getParts(command)
  return named.length === 1 && named[0]?.type === NT.COMMAND_NAME && getText(named[0]) === 'exec'
}

/**
 * Whether bash forks to run a redirected command, so its redirects expand
 * in the child and an error there fails that command alone: a subshell or a
 * program. A builtin, a function or another compound command is the shell's
 * own, which expands its redirects itself and discards the line on an
 * error. `command -v` is the builtin itself; `command X` is X with functions
 * masked; a name only an expansion spells is taken for a program. Mirrors
 * Python's _forks.
 */
function forks(command: TSNodeLike | null, session: SessionState): boolean {
  if (command?.type !== NT.COMMAND) return command?.type === NT.SUBSHELL
  let words = getParts(command).filter((part) => part.type !== NT.VARIABLE_ASSIGNMENT)
  let functions = true
  while (words[0] !== undefined && getText(words[0]) === 'command') {
    words = words.slice(1)
    functions = false
    while (words[0] !== undefined && getText(words[0]).startsWith('-')) {
      const option = getText(words[0])
      words = words.slice(1)
      if (option === '--') break
      if (option.includes('v') || option.includes('V')) return false
    }
  }
  let head = words[0]
  if (head === undefined) return false
  if (head.type === NT.COMMAND_NAME && head.namedChildren[0] !== undefined) {
    head = head.namedChildren[0]
  }
  const name = literalText(head)
  return (
    name === null ||
    (!BASH_BUILTINS.has(name) && !(functions && session.functions[name] !== undefined))
  )
}

export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  // What expanding the node printed (a substitution's stderr) goes out with
  // the node's own stderr, unless its caller collects it: a simple
  // command's words expand before its redirects apply.
  ownDiagnostics = true,
  // The node is the whole of a child shell (a background job), which runs
  // its EXIT action when the node ends, its evaluator bound the way
  // `executeNodeBody` binds it for the node's own lines.
  endsShell = false,
): Promise<Result> {
  session = executionSession(session)
  if (endsShell) {
    const { signal, executionScope } = deps
    const executeFn: ExecuteFn = (cmd, opts) =>
      deps.executeFn(cmd, {
        session,
        ...(signal !== undefined ? { signal } : {}),
        ...(executionScope !== undefined ? { executionScope } : {}),
        ...opts,
      })
    return endShell(
      executeFn,
      session,
      stdin,
      callStack,
      executeNode(deps, node, session, stdin, callStack, ownDiagnostics),
    )
  }
  const executionScope = deps.executionScope ?? new ExecutionScope()
  await executionScope.checkpoint(deps.signal ?? session.abortSignal ?? undefined)
  if (!ownDiagnostics) {
    const result = await executeNodeBody(deps, node, session, stdin, callStack, executionScope)
    if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
      throw makeAbortError(
        deps.signal?.aborted === true ? deps.signal : (session.abortSignal ?? undefined),
      )
    }
    return result
  }
  const outer = session.diagnostics
  session.diagnostics = []
  try {
    const [stdout, io, execNode] = await executeNodeBody(
      deps,
      node,
      session,
      stdin,
      callStack,
      executionScope,
    )
    // A statement that settles after the caller aborted is an orphan: its
    // status must not reach the shell the caller was already released from.
    if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
      throw makeAbortError(
        deps.signal?.aborted === true ? deps.signal : (session.abortSignal ?? undefined),
      )
    }
    if (session.diagnostics.length > 0) {
      const err = diagnosticStderr(node, session)
      const existing = await io.materializeStderr()
      const merged = new Uint8Array(err.length + existing.length)
      merged.set(err)
      merged.set(existing, err.length)
      io.stderr = merged
      execNode.stderr = merged
    }
    return [stdout, io, execNode]
  } catch (err) {
    if (err instanceof ExitSignal) {
      const extra = diagnosticStderr(node, session)
      const merged = new Uint8Array(extra.length + err.stderr.length)
      merged.set(extra)
      merged.set(err.stderr, extra.length)
      err.stderr = merged
    }
    throw err
  } finally {
    session.diagnostics = outer
  }
}

function diagnosticStderr(node: TSNodeLike, session: SessionState): Uint8Array {
  const head = getText(node).trimStart().split(/\s+/, 1)[0] ?? ''
  const builtin = ['export', 'declare', 'local', 'readonly', 'read', 'printf', 'let'].includes(head)
    ? head
    : ''
  const prefix = builtin === '' ? 'bash: ' : `bash: ${builtin}: `
  const parts = session.diagnostics.map((message) =>
    typeof message === 'string' ? encodeText(prefix + message + '\n') : message,
  )
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

async function executeNodeBody(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  executionScope: ExecutionScope,
): Promise<Result> {
  // The scope and signal this subtree runs under are the ones its nested
  // evaluations run under, bound into `executeFn` here, at the one door
  // every node goes through, as Python binds them into `execute_fn`: a
  // background job runs without the caller's signal, and so must the lines
  // it evaluates, or a `$(...)` inside the job would die of an abort that
  // was never the job's.
  const inner = deps.executeFn
  const signal = deps.signal
  deps = {
    ...deps,
    executionScope,
    executeFn: (cmd, opts) => {
      if (opts.executionScope !== undefined) return inner(cmd, opts)
      const merged = mergeSignals(signal, opts.signal)
      return inner(cmd, {
        ...opts,
        executionScope,
        ...(merged !== undefined ? { signal: merged } : {}),
      })
    },
  }
  const { sink, ...captureDeps } = deps
  const recurse = (
    n: TSNodeLike,
    s: SessionState,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ): Promise<Result> =>
    executeNode(
      withOpts(captureDeps, opts),
      n,
      s,
      i,
      cs,
      opts?.ownDiagnostics !== false,
      opts?.endsShell === true,
    )
  const stream =
    sink === undefined
      ? recurse
      : (
          n: TSNodeLike,
          s: SessionState,
          i: ByteSource | null,
          cs: CallStack | null,
          opts?: ExecuteNodeOpts,
        ): Promise<Result> =>
          executeNode(
            withOpts(deps, opts),
            n,
            s,
            i,
            cs,
            opts?.ownDiagnostics !== false,
            opts?.endsShell === true,
          )

  const { dispatch, registry, jobTable, agentId } = deps
  // Capture the walker's session before any await; a concurrent line's
  // ambient frame cannot identify this node's nested evaluations.
  const executeFn: ExecuteFn = (cmd, opts) => deps.executeFn(cmd, { session, ...opts })
  const kind = nodeKind(node)
  // A root run on a caller's frames is the caller's own line (eval,
  // source, an alias, `$( )`); one given none is a shell of its own.
  const inline = callStack !== null
  callStack ??= new CallStack()

  // The statements a construct runs all read one descriptor, as bash's
  // do: `read` takes its line and the command after it gets the rest, in
  // a group, a loop, a list, a subshell or a nested shell alike.
  if (STREAMING_KINDS.has(kind)) stdin = share(stdin)

  // `set -n` reads without executing, and it stops *everything* after
  // it, at every depth: GNU answers `if true; then set -n; echo BAD; fi`
  // and `f(){ set -n; echo BAD; }; f` with nothing at all. Stated here,
  // at the one door every node goes through, rather than in each
  // statement runner — the program loop, the subshell body, a group, a
  // function body and every loop body are five places for one rule to
  // drift, and it did: the check lived in the program loop alone, so
  // `set -n` worked flat and did nothing one construct deep. The program
  // loop keeps its own `break` as the reader-level stop, which is also
  // what silences `set -v` for the lines it never reads.
  if (session.shellOptions.noexec === true) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
    throw makeAbortError(
      deps.signal?.aborted === true ? deps.signal : (session.abortSignal ?? undefined),
    )
  }
  session.errexitImmune = false

  // A sink turns this walk from "return your output" into "write your
  // output". Sequencing constructs pass it to their children so each
  // statement lands as it finishes; everything else runs unchanged and
  // has its result drained here. Only STREAMING_KINDS inherit a sink,
  // so capture sites keep receiving their output as a value.
  if (
    sink !== undefined &&
    !STREAMING_KINDS.has(kind) &&
    kind !== NodeKind.COMMAND &&
    kind !== NodeKind.REDIRECT &&
    kind !== NodeKind.VAR_ASSIGN &&
    kind !== NodeKind.VAR_ASSIGNS
  ) {
    return drained(sink, ...(await recurse(node, session, stdin, callStack)))
  }

  if (kind === NodeKind.TIMED) {
    const started = performance.now()
    const inner = node.namedChildren[0]
    if (inner === undefined) throw new Error('timed statement has no body')
    const [body, io, execNode] = await stream(inner, session, stdin, callStack)
    const stdout = await applyBarrier(body, io, BarrierPolicy.VALUE)
    const elapsed = (performance.now() - started) / 1000
    const stderr = await io.materializeStderr()
    const reports = [...(node.timing ?? [])]
      .reverse()
      .map((portable) => timingReport(elapsed, portable, session.env.TIMEFORMAT))
    const merged = new Uint8Array(
      stderr.length + reports.reduce((n, report) => n + report.length, 0),
    )
    merged.set(stderr)
    let offset = stderr.length
    for (const report of reports) {
      merged.set(report, offset)
      offset += report.length
    }
    io.stderr = merged
    return [stdout, io, execNode]
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    return executeProgram(
      recurse,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      agentId,
      dispatch,
      deps.handed ?? null,
      registry.decisions,
      sink ?? null,
      inline,
      executeFn,
    )
  }

  if (kind === NodeKind.COMMAND) {
    const result = await runInCommandScope(() =>
      executeCommand(
        recurse,
        dispatch,
        registry,
        deps.namespace,
        executeFn,
        node,
        session,
        stdin,
        callStack,
        jobTable,
        deps.runtimeBindings,
        deps.routingDecision,
        deps.signal,
        deps.parser,
        agentId,
        deps.handed,
        sink,
      ),
    )
    return sink === undefined ? result : drained(sink, ...result)
  }

  if (kind === NodeKind.PIPELINE) {
    // `! a | b` parses as pipeline(negated_command(a), b), and a redirect
    // followed by `|` closes over everything to its left, so the stages
    // are read the way bash reads them rather than as the parse nested
    // them (see getPipelineStages).
    return runPipeline(
      recurse,
      dispatch,
      executeFn,
      registry,
      getPipelineStages(node),
      session,
      stdin,
      callStack,
      deps.signal,
      jobTable.processes,
    )
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(stream, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    // The `&&`/`||` steps a heredoc's operator line carried
    // (`false <<EOF || echo x`) wrap the whole statement, hoisted list
    // and all, exactly as a `list` node would have wrapped it had the
    // parser read the line the way bash does.
    const continuation = takeContinuation(redirects)
    const runLeft = runRedirected.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      command,
      redirects,
      deps.signal,
      jobTable.processes,
      sink,
    )
    const result =
      continuation.length === 0
        ? await runLeft(session, stdin, callStack)
        : await runContinuation(recurse, runLeft, node, continuation, session, stdin, callStack)
    return sink === undefined ? result : drained(sink, ...result)
  }

  if (kind === NodeKind.SUBSHELL) {
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = jobTable.child()
    const abort = new AbortController()
    const subDeps: ExecuteNodeDeps = {
      ...captureDeps,
      jobTable: subTable,
      signal:
        deps.signal === undefined ? abort.signal : AbortSignal.any([deps.signal, abort.signal]),
    }
    // The opts parameter is load-bearing, not decoration: a job started
    // inside the subshell body hands `handleBackground` its own console
    // and abort signal through it. Dropping it (a 4-parameter closure
    // still satisfies ExecuteNodeFn, since function parameters are
    // bivariant) would run the nested job against the enclosing job's
    // sink and signal instead.
    const subRecurse = (
      n: TSNodeLike,
      s: SessionState,
      inp: ByteSource | null,
      cs: CallStack | null,
      opts?: ExecuteNodeOpts,
    ): Promise<Result> =>
      executeNode(
        withOpts(subDeps, opts),
        n,
        s,
        inp,
        cs,
        opts?.ownDiagnostics !== false,
        opts?.endsShell === true,
      )
    const child = childSession(session)
    const asProgram = isProgramInvocation(session)
    let result: Result | undefined
    let process: ProcessHandle
    try {
      process = subTable.processes.start({
        sessionId: session.sessionId,
        command: node.text,
        cwd: PathSpec.fromStrPath(session.cwd),
        parentPid: session.processId,
        cancel: () => {
          abort.abort()
        },
        limit: session.processes.max,
        run: async () => {
          const body = () =>
            handleSubshell(
              subRecurse,
              node.children,
              child,
              stdin,
              callStack,
              subTable,
              agentId,
              dispatch,
              deps.handed ?? null,
              registry.decisions,
              sink ?? null,
              executeFn,
            )
          result = await runWithSession(child, () =>
            asProgram ? runAsProgram(child, body) : body(),
          )
          return result[1].exitCode
        },
      })
    } catch (error) {
      releaseFunctions(child.functions)
      if ((error as { code?: unknown }).code === 'EAGAIN')
        throw new ExitSignal(FORK_FAILED_STATUS, encodeText(FORK_FAILED))
      throw error
    }
    child.processId = process.info.pid
    try {
      await process.task
      if (result === undefined) throw new Error('subshell completed without a result')
      return result
    } finally {
      releaseFunctions(child.functions)
    }
  }

  if (kind === NodeKind.COMPOUND && node.children[0]?.type === NT.ARITH_OPEN) {
    const text = getText(node)
    const expr = await expandArith(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    const reader = randomReader(session)
    let error: ArithError | null = null
    let writes: readonly ArithWrite[] = []
    let value = 0n
    try {
      // Reads resolve against the visible env so a hidden name counts
      // as unset; a hidden write refuses below, in this command's own
      // voice like the readonly refusal.
      const result: ArithResult = evaluateArith(
        expr,
        visibleEnv(session),
        0,
        sessionElements(session, reader),
        reader.read,
        reader.wrote,
      )
      writes = result.writes
      value = result.value
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      // bash bound the assignments made before the error; they land
      // before the error is reported.
      error = err
      writes = err.writes
    }
    for (const write of writes) {
      const name = write.name
      try {
        ensureVarVisible(session, name)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        const errBytes = encodeText(`bash: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
      if (session.readonlyVars.has(name)) {
        const errBytes = encodeText(`bash: ${name}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
    }
    try {
      for (const write of writes) {
        await assignElement(
          session,
          sessionView(session, registry.policies),
          write.name,
          write.key,
          write.value,
        )
      }
      reader.settle()
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const errBytes = encodeText(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    if (error !== null) {
      const errBytes = encodeText(`bash: ((: ${expr}: ${error.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    const code = value !== 0n ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: text, exitCode: code }),
    ]
  }

  if (kind === NodeKind.COMPOUND) {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '{}', exitCode: 0 })
    const bound = fd0Binding(session)
    for (const child of node.namedChildren) {
      if (child.type === NT.COMMENT) continue
      let result: Result
      try {
        result = await runStatement(
          stream,
          child,
          session,
          stdin,
          bound,
          callStack,
          jobTable,
          agentId,
          deps.handed ?? null,
          registry.decisions,
        )
      } catch (sig) {
        if (!isUnwinding(sig)) throw sig
        throw await carried(sig, allStdout.length > 0 ? asyncChain(allStdout) : null, mergedIo)
      }
      const [rawStdout, io, execNode] = result
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session, child)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type) &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- recurse() mutates it
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    }
    if (allStdout.length === 1 && allStdout[0] !== undefined) {
      return [allStdout[0], mergedIo, lastExec]
    }
    const combined = allStdout.length > 0 ? asyncChain(allStdout) : null
    return [combined, mergedIo, lastExec]
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(
      stream,
      branches,
      elseBody,
      session,
      stdin,
      callStack,
      jobTable,
      agentId,
      deps.handed ?? null,
      registry.decisions,
    )
  }

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) =>
      evalCforExpr(e, d, session, executeFn, callStack, sessionView(session, registry.policies))
    return callStack.loop(() =>
      handleCfor(
        stream,
        exprs,
        body,
        evalExpr,
        session,
        stdin,
        callStack,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
      ),
    )
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
    if (!isValidName(variable)) {
      const err = encodeText(`bash: \`${variable}': not a valid identifier\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: kind, exitCode: 1, stderr: err }),
      ]
    }
    const resolved = await runInCommandScope(async () => {
      const classified = await expandAndClassify(
        values,
        session,
        executeFn,
        registry,
        session.cwd,
        callStack,
        sessionView(session, registry.policies),
      )
      // The loop word list is consumed by the shell (WordPolicy.SHELL):
      // globs resolve to matches before iteration starts.
      return resolveGlobs(
        classified,
        registry,
        session.shellOptions.noglob === true,
        deps.namespace,
        globOptions(session),
      )
    })
    if (kind === NodeKind.SELECT) {
      return callStack.loop(() =>
        handleSelect(
          stream,
          variable,
          resolved,
          body,
          session,
          stdin,
          callStack,
          registry.policies,
          jobTable,
          agentId,
          deps.handed ?? null,
          registry.decisions,
          mergeSignals(deps.signal, session.abortSignal),
          sink,
        ),
      )
    }
    return callStack.loop(() =>
      handleFor(
        stream,
        variable,
        resolved,
        body,
        session,
        stdin,
        callStack,
        registry.policies,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
      ),
    )
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [condition, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return callStack.loop(() =>
        handleUntil(
          stream,
          condition,
          body,
          session,
          stdin,
          callStack,
          jobTable,
          agentId,
          deps.handed ?? null,
          registry.decisions,
        ),
      )
    }
    return callStack.loop(() =>
      handleWhile(
        stream,
        condition,
        body,
        session,
        stdin,
        callStack,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
      ),
    )
  }

  if (kind === NodeKind.CASE) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(
      wordNode,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    const items: [string[], TSNodeLike[], string][] = []
    for (const [patternNodes, body, terminator] of getCaseItems(node)) {
      const patterns: string[] = []
      for (const patternNode of patternNodes) {
        patterns.push(
          await expandPattern(
            patternNode,
            session,
            executeFn,
            callStack,
            sessionView(session, registry.policies),
          ),
        )
      }
      items.push([patterns, body, terminator])
    }
    return handleCase(
      stream,
      word,
      items,
      session,
      stdin,
      callStack,
      jobTable,
      agentId,
      deps.handed ?? null,
      registry.decisions,
    )
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    if (session.readonlyFunctions.has(name)) {
      // `readonly -f f` froze the body: either definition syntax refuses
      // with `f: readonly function`, exit 1, and the old body stays,
      // pinned on 5.2.37.
      const err = encodeText(`bash: ${name}: readonly function\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: `function ${name}`, exitCode: 1, stderr: err }),
      ]
    }
    const body = getFunctionBody(node)
    session.functions[name] = body
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (kind === NodeKind.DECLARATION) {
    return await runInCommandScope(() =>
      executeDeclaration(node, session, executeFn, registry, deps.namespace, callStack),
    )
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(getUnsetArgs(node), session, sessionView(session, registry.policies))
  }

  if (kind === NodeKind.TEST) {
    const opener = node.children[0]?.type ?? '['
    if (opener === '[[') {
      const tree = await expandDoubleBracket(
        node,
        session,
        executeFn,
        callStack,
        sessionView(session, registry.policies),
      )
      return handleTest(
        dispatch,
        deps.namespace,
        tree,
        session,
        '[[',
        sessionView(session, registry.policies),
      )
    }
    const expanded = await expandTestExpr(
      node,
      session,
      executeFn,
      callStack,
      sessionView(session, registry.policies),
    )
    return handleTest(
      dispatch,
      deps.namespace,
      expanded,
      session,
      '[',
      sessionView(session, registry.policies),
    )
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [stdout, io, execNode] = await stream(inner, session, stdin, callStack)
    return negated(stdout, io, execNode, session, inner)
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    return await executeAssignment(node, session, executeFn, registry, deps.namespace, callStack)
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = session.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, session, stdin, callStack, { ownDiagnostics: false })
      mergedIo = await mergedIo.merge(io)
    }
    // The statement's status follows the last command substitution
    // performed across ALL its assignments, not the last child's.
    const code = assignmentStatus(session, subSeq)
    mergedIo.exitCode = code
    return [null, mergedIo, new ExecutionNode({ command: getText(node), exitCode: code })]
  }

  // Constructs the parser accepts but the executor cannot honor (e.g.
  // C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
  // so agents see a capability gap, not a crash.
  const unsupportedErr = encodeText(`mirage: unsupported shell construct: ${node.type}\n`)
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}

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

import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { assignmentStatus, finishStatement, recordStatus } from '../executor/statement.ts'
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
  getPipelineCommands,
  getRedirects,
  getText,
  getParts,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/helpers.ts'
import { JobTable } from '../../shell/job_table/index.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { NodeType as NT, Redirect, RedirectKind } from '../../shell/types.ts'
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
  type CforEval,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { handleTest, handleUnset } from '../executor/builtins/index.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
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
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { type ExecuteNodeOpts, pump } from '../executor/jobs.ts'

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
  session: Session,
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
  session: Session,
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

async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack)
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
    right,
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

async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, session, stdin, callStack)
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
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  ensureOpen?: (resource: Resource) => Promise<void>
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
   * Parse one line into a tree. Only alias expansion needs it: an alias
   * rewrites the head word textually and the result is read as a fresh
   * line, so a value holding a pipe is a pipe. Absent (a unit test
   * driving the walker directly) means an alias definition is stored and
   * printed but never expanded.
   */
  reparse?: (line: string) => TSNodeLike
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

export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const outer = session.diagnostics
  session.diagnostics = []
  try {
    const [stdout, io, execNode] = await executeNodeBody(deps, node, session, stdin, callStack)
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

function diagnosticStderr(node: TSNodeLike, session: Session): Uint8Array {
  const head = getText(node).trimStart().split(/\s+/, 1)[0] ?? ''
  const builtin = ['export', 'declare', 'local', 'readonly', 'read', 'printf', 'let'].includes(head)
    ? head
    : ''
  const prefix = builtin === '' ? 'bash: ' : `bash: ${builtin}: `
  const parts = session.diagnostics.map((message) =>
    typeof message === 'string' ? new TextEncoder().encode(prefix + message + '\n') : message,
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
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const { sink, ...captureDeps } = deps
  const recurse = (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ): Promise<Result> => executeNode(withOpts(captureDeps, opts), n, s, i, cs)
  const stream =
    sink === undefined
      ? recurse
      : (
          n: TSNodeLike,
          s: Session,
          i: ByteSource | null,
          cs: CallStack | null,
          opts?: ExecuteNodeOpts,
        ): Promise<Result> => executeNode(withOpts(deps, opts), n, s, i, cs)

  const { dispatch, registry, jobTable, executeFn, agentId } = deps
  const kind = nodeKind(node)

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
    throw makeAbortError()
  }
  session.errexitImmune = false

  // A sink turns this walk from "return your output" into "write your
  // output". Sequencing constructs pass it to their children so each
  // statement lands as it finishes; everything else runs unchanged and
  // has its result drained here. Only STREAMING_KINDS inherit a sink,
  // so capture sites keep receiving their output as a value.
  if (sink !== undefined && !STREAMING_KINDS.has(kind)) {
    const [stdout, io, execNode] = await recurse(node, session, stdin, callStack)
    await pump(sink, Channel.STDOUT, stdout)
    const stderr = await io.materializeStderr()
    if (stderr.byteLength > 0) {
      await sink.emit(Channel.STDERR, stderr)
      // Cleared so the job's tail does not emit it a second time.
      io.stderr = null
    }
    return [null, io, execNode]
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    return executeProgram(
      stream,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      agentId,
      dispatch,
      deps.handed ?? null,
      registry.decisions,
    )
  }

  if (kind === NodeKind.COMMAND) {
    return executeCommand(
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
      deps.ensureOpen,
      deps.runtimeBindings,
      deps.routingDecision,
      deps.signal,
      deps.reparse,
      agentId,
      deps.handed,
    )
  }

  if (kind === NodeKind.PIPELINE) {
    const [pipeCommands, stderrFlags] = getPipelineCommands(node)
    let commands = pipeCommands
    // `! a | b` parses as pipeline(negated_command(a), b) but bash
    // negates the WHOLE pipeline's exit status.
    const first = commands[0]
    const negated = first?.type === NT.NEGATED_COMMAND
    if (negated) {
      commands = [getNegatedCommand(first), ...commands.slice(1)]
    }
    let pipeRecurse = recurse
    if (stderrFlags.some(Boolean)) {
      const targets = commands.filter((_, i) => stderrFlags[i] === true)
      pipeRecurse = recursePipeStderr.bind(null, recurse, dispatch, executeFn, registry, targets)
    }
    const [stdout, io, execNode] = await handlePipe(
      pipeRecurse,
      commands,
      stderrFlags,
      session,
      stdin,
      callStack,
    )
    if (!negated) return [stdout, io, execNode]
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

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(stream, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    if (command !== null && command.type === NT.LIST) {
      // tree-sitter hoists a trailing redirect over the whole &&/||
      // list; bash binds it to the last command:
      //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
      // Re-associate and defer target expansion until R runs, so
      // `cd /x && echo hi > f` writes under /x. Compound and subshell
      // bodies keep the whole-body redirect (bash group semantics).
      const [left, op, right] = getListParts(command)
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handleConnection(wrapped, left, op, right, session, stdin, callStack)
    }
    if (command !== null && command.type === NT.PIPELINE) {
      const [commands, stderrFlags] = getPipelineCommands(command)
      const right = commands[commands.length - 1]
      if (right === undefined) throw new Error('redirected pipeline: missing command')
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handlePipe(wrapped, commands, stderrFlags, session, stdin, callStack)
    }
    const [expandedRedirects, pipeNode] = await expandRedirects(
      redirects,
      session,
      executeFn,
      registry,
      callStack,
      sessionView(session, registry.policies),
    )
    // `exec > file` with no command installs the redirects on the shell
    // for every later statement, rather than applying them to one
    // command. `exec cmd > file` still has a command and falls through
    // to the ordinary path, which refuses the command form.
    if (isBareExec(command)) {
      return await installExecRedirects(dispatch, session, expandedRedirects)
    }
    let [stdout, io, execNode] = await handleRedirect(
      recurse,
      dispatch,
      command,
      expandedRedirects,
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

  if (kind === NodeKind.SUBSHELL) {
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = new JobTable()
    const subDeps: ExecuteNodeDeps = { ...deps, jobTable: subTable }
    // The opts parameter is load-bearing, not decoration: a job started
    // inside the subshell body hands `handleBackground` its own console
    // and abort signal through it. Dropping it (a 4-parameter closure
    // still satisfies ExecuteNodeFn, since function parameters are
    // bivariant) would run the nested job against the enclosing job's
    // sink and signal instead.
    const subRecurse = (
      n: TSNodeLike,
      s: Session,
      inp: ByteSource | null,
      cs: CallStack | null,
      opts?: ExecuteNodeOpts,
    ): Promise<Result> => executeNode(withOpts(subDeps, opts), n, s, inp, cs)
    return handleSubshell(
      subRecurse,
      node.children,
      session,
      stdin,
      callStack,
      subTable,
      agentId,
      dispatch,
      deps.handed ?? null,
      registry.decisions,
    )
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
        const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
      if (session.readonlyVars.has(name)) {
        const errBytes = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
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
      const errBytes = new TextEncoder().encode(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    if (error !== null) {
      const errBytes = new TextEncoder().encode(`bash: ((: ${expr}: ${error.message}\n`)
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
    for (const child of node.namedChildren) {
      if (child.type === NT.COMMENT) continue
      const [rawStdout, io, execNode] = await stream(child, session, stdin, callStack)
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
    const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
    return [combined, mergedIo, lastExec]
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(stream, branches, elseBody, session, stdin, callStack)
  }

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) =>
      evalCforExpr(e, d, session, executeFn, callStack, sessionView(session, registry.policies))
    return handleCfor(stream, exprs, body, evalExpr, session, stdin, callStack)
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
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
    const resolved = await resolveGlobs(
      classified,
      registry,
      session.shellOptions.noglob === true,
      deps.namespace,
      globOptions(session),
    )
    if (kind === NodeKind.SELECT) {
      return handleSelect(
        stream,
        variable,
        resolved,
        body,
        session,
        stdin,
        callStack,
        registry.policies,
      )
    }
    return handleFor(stream, variable, resolved, body, session, stdin, callStack, registry.policies)
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [condition, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return handleUntil(stream, condition, body, session, stdin, callStack)
    }
    return handleWhile(stream, condition, body, session, stdin, callStack)
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
    return handleCase(stream, word, items, session, stdin, callStack)
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    if (session.readonlyFunctions.has(name)) {
      // `readonly -f f` froze the body: either definition syntax refuses
      // with `f: readonly function`, exit 1, and the old body stays,
      // pinned on 5.2.37.
      const err = new TextEncoder().encode(`bash: ${name}: readonly function\n`)
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
    return await executeDeclaration(node, session, executeFn, registry, deps.namespace, callStack)
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
    const [rawStdout, io, execNode] = await stream(inner, session, stdin, callStack)
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

  if (kind === NodeKind.VAR_ASSIGN) {
    return await executeAssignment(node, session, executeFn, registry, deps.namespace, callStack)
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = session.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, session, stdin, callStack)
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
  const unsupportedErr = new TextEncoder().encode(
    `mirage: unsupported shell construct: ${node.type}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}

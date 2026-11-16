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

import { shellVoice } from '../../shell/voice.ts'
import { atoi } from '../../commands/builtin/utils/strtol.ts'
import type { RedirectResult } from '../../context/session_context.ts'
import { lineBuffer } from '../../io/async_line_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { Decisions } from '../../policy/decisions.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { HandOff } from '../../policy/types.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { Recorder } from '../../shell/descriptors.ts'
import { ArithError, ExitSignal, ReturnSignal } from '../../shell/errors.ts'
import type { JobTable } from '../../execution/job/index.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { traceLine } from '../../shell/xtrace.ts'
import type { Item, Shell, ShellSlot, ShellTask, ShellTreeNode } from '../../rs/shell.ts'
import { shellNode } from '../../shell/parse/program.ts'
import type { PathSpec } from '../../types.ts'
import { wordText } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { ExpandHost } from '../expand/node.ts'
import { diagnosticStderr } from '../node/diagnostics.ts'
import type { ExecuteFn } from '../expand/types.ts'
import type { SessionState } from '../session/session.ts'
import { frame, sessionView, visibleEnv } from '../session/state.ts'
import { drive } from '../session/task.ts'
import { ExecutionNode } from '../types.ts'
import { readReply } from './builtins/read/index.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import { runProgram, runStatement } from './background.ts'
import {
  errexitActs,
  fd0Binding,
  finishStatement,
  ignoringErrexit,
  land,
  recordStatus,
  writeErrorLine,
} from './statement.ts'
import { errTrapArmed, runErrTrap, runReturnTrap } from './traps.ts'

/** Runs a list of statements: `executeBody` bound to the walk. */
export type BodyRun = (
  nodes: readonly TSNodeLike[],
  bound?: ReturnType<typeof fd0Binding>,
  leading?: Uint8Array,
) => Promise<RedirectResult>

export class LoopSignal extends Error {
  constructor(
    public stdout: ByteSource | null = null,
    public io: IOResult = new IOResult(),
    public levels = 1,
  ) {
    super(new.target === BreakSignal ? 'break' : 'continue')
    this.name = new.target.name
  }
}

export class BreakSignal extends LoopSignal {}

export class ContinueSignal extends LoopSignal {}

/**
 * Execute a list of statements in order: a group, a loop or `if` body, a
 * `case` arm, a function body.
 *
 * A statement ending in `&` is launched as a job through `runStatement`
 * rather than run inline; `jobTable` is the job plane it needs. The ERR
 * action answers a failing statement, its output landed
 * through `sink` when the body writes to one, and `set -e` stops the list.
 * `bound` is `fd0Binding` as the construct running the list started, so an
 * `exec <&-` in a loop body reaches the next test. A comment leaves `$?` as
 * it was, and a `break` or `continue` records its own status as it leaves
 * (bash leaves `${PIPESTATUS[@]}` at `0`).
 */
export async function executeBody(
  executeNode: ExecuteNodeFn,
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  handed: HandOff | null,
  decisions: Decisions | null,
  executeFn: ExecuteFn | null = null,
  sink: JobConsole | null = null,
  bound: ReturnType<typeof fd0Binding> = fd0Binding(context.session),
  leading: Uint8Array = new Uint8Array(),
): Promise<RedirectResult> {
  const session = context.session
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  if (leading.byteLength > 0)
    mergedIo = await land([[Channel.STDERR, leading, false]], sink, allStdout, mergedIo)
  for (const cmd of body) {
    if (cmd.type === NT.COMMENT) continue
    const armed = errTrapArmed(session)
    try {
      const [stdout, io, execNode] = await runProgram(
        cmd,
        context,
        async () => {
          const [out, ranIo, ran] = await runStatement(
            executeNode,
            cmd,
            context,
            stdin,
            bound,
            callStack,
            jobTable,
            handed,
            decisions,
          )
          return [await finishStatement(out, ranIo, session, cmd), ranIo, ran]
        },
        jobTable,
        sink,
      )
      lastExec = execNode
      if (sink instanceof Recorder && sink.refused) {
        // A write an `exec` in the body sent where no write goes (`exec
        // 1<f`) fails the statement that made it.
        sink.refused = false
        await sink.emit(Channel.STDERR, writeErrorLine(execNode.command ?? ''))
        io.exitCode = 1
        recordStatus(session, 1)
      }
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      mergedIo = await land(
        await runErrTrap(executeFn, cmd, io.exitCode, session, armed, stdin, callStack, execNode),
        sink,
        allStdout,
        mergedIo,
      )
      if (errexitActs(cmd, io.exitCode, session)) break
    } catch (sig) {
      if (!isUnwinding(sig)) throw sig
      if (sig instanceof LoopSignal) recordStatus(session, sig.io.exitCode)
      throw await carried(sig, chainStreams(allStdout), mergedIo)
    }
  }
  return [chainStreams(allStdout), mergedIo, lastExec]
}

/**
 * Add what one turn of a loop wrote to the loop's output, nothing for a turn
 * that wrote nothing, so a loop with no end holds no more for it. Mirrors
 * Python's _keep.
 */
function keep(allStdout: (ByteSource | null)[], stdout: ByteSource | null): void {
  if (stdout !== null && !(stdout instanceof Uint8Array && stdout.byteLength === 0)) {
    allStdout.push(stdout)
  }
}

function chainStreams(sources: readonly (ByteSource | null)[]): ByteSource | null {
  const nonNull = sources.filter(
    (s): s is ByteSource => s !== null && !(s instanceof Uint8Array && s.byteLength === 0),
  )
  if (nonNull.length === 0) return null
  return asyncChain(nonNull)
}

export type Unwinding = LoopSignal | ReturnSignal | ExitSignal

export function isUnwinding(err: unknown): err is Unwinding {
  return err instanceof LoopSignal || err instanceof ReturnSignal || err instanceof ExitSignal
}

/**
 * An unwinding `break`, `continue`, `return` or `exit` with the output the
 * construct it leaves had produced put in front of its own, which that
 * construct would otherwise drop on the way out (bash wrote it as it went).
 * Mirrors Python's carried.
 */
export async function carried(
  sig: Unwinding,
  stdout: ByteSource | null,
  io: IOResult,
): Promise<Unwinding> {
  if (sig instanceof LoopSignal) {
    sig.stdout = chainStreams([stdout, sig.stdout])
    sig.io = await io.merge(sig.io)
    return sig
  }
  sig.stderr = concat([await materialize(io.stderr), sig.stderr])
  if (sig instanceof ReturnSignal) sig.stdout = chainStreams([stdout, sig.stdout])
  else sig.stdout = concat([await materialize(stdout), sig.stdout ?? new Uint8Array()])
  return sig
}

/**
 * What a function or a sourced file gives back as it returns: its output and
 * status, with what its RETURN action wrote after the output. A `return` in
 * a function's action returns from the function with its status. A sourced
 * file has returned by the time its action runs, so a `return` there leaves
 * the function around it, or only complains at the top level. An `exit`,
 * or that `return`, leaves with the output in front of its own. Mirrors
 * Python's returning.
 */
export async function returning(
  executeFn: ExecuteFn | null,
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack,
  stdout: ByteSource | null,
  io: IOResult,
  sink: JobConsole | null = null,
): Promise<[ByteSource | null, IOResult]> {
  const frame = callStack.current
  frame.closed = frame.sourced
  if (session.functionNames !== null) session.functionNames = callStack.functionNames()
  session.callLines = callStack.callLines()
  const outputs = [stdout]
  try {
    io = await land(await runReturnTrap(executeFn, session, stdin, callStack), sink, outputs, io)
  } catch (sig) {
    if (!isUnwinding(sig)) throw sig
    const left = await carried(sig, stdout, io)
    if (!(left instanceof ReturnSignal) || frame.sourced) throw left
    return [
      left.stdout,
      new IOResult({
        stderr: left.stderr.byteLength > 0 ? left.stderr : null,
        exitCode: left.exitCode,
      }),
    ]
  }
  return [chainStreams(outputs), io]
}

/**
 * What a child shell reports when an `Unwinding` ends it: what it wrote, its
 * diagnostic, and its status, `exit`'s contained one, `return`'s own, or that
 * of `break` or `continue`. A child running one simple command is the shell
 * `exit` ends (`simple`), so it reports `exit`'s own status (`: ${U?} | cat`
 * is 127, `( : ${U?} ) | cat` is 1), unless the signal left text `eval` or
 * `source` ran. Mirrors Python's ended.
 */
export function ended(sig: Unwinding, simple = false): IOResult {
  if (sig instanceof LoopSignal) {
    return new IOResult({ stdout: sig.stdout, stderr: sig.io.stderr, exitCode: sig.io.exitCode })
  }
  return new IOResult({
    stdout: sig.stdout,
    stderr: sig.stderr.byteLength > 0 ? sig.stderr : null,
    exitCode:
      sig instanceof ExitSignal && (!simple || sig.sourced) ? sig.containedCode : sig.exitCode,
  })
}

/**
 * Take what a nested line wrote before it left (an `exec`'d command, an ERR
 * or RETURN action), for the redirects it ran under to route. An EXIT
 * action's output, the `cleanup` at its end, goes around them, and what the
 * other unwinding signals carry went through them already. Mirrors Python's
 * take_stdout.
 */
export async function takeStdout(sig: Unwinding): Promise<Uint8Array> {
  if (!(sig instanceof ExitSignal || sig instanceof ReturnSignal) || !sig.unrouted)
    return new Uint8Array()
  const written = await materialize(sig.stdout)
  const cut = written.byteLength - (sig instanceof ExitSignal ? sig.cleanup.byteLength : 0)
  sig.stdout = cut < written.byteLength ? written.subarray(cut) : null
  return written.subarray(0, cut)
}

/**
 * Take the diagnostic an `Unwinding` carries, for the redirects it was
 * written under to route. Mirrors Python's take_stderr.
 */
export async function takeStderr(sig: Unwinding): Promise<Uint8Array> {
  if (sig instanceof LoopSignal) {
    const diagnostic = await materialize(sig.io.stderr)
    sig.io.stderr = null
    return diagnostic
  }
  const diagnostic = sig.stderr
  sig.stderr = new Uint8Array()
  return diagnostic
}

/**
 * Fold a `break` or `continue` into the loop it reached; one aimed further
 * out (`break 2`) goes on with a level spent and the loop's output in front
 * of its own. Mirrors Python's _absorbed.
 */
async function absorbed(
  sig: LoopSignal,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<IOResult> {
  keep(allStdout, sig.stdout)
  const merged = await mergedIo.merge(sig.io)
  if (sig.levels > 1) {
    sig.stdout = chainStreams(allStdout)
    sig.io = merged
    sig.levels -= 1
    throw sig
  }
  return merged
}

function collectLoopResult(
  allStdout: readonly (ByteSource | null)[],
  mergedIo: IOResult,
  label: string,
): RedirectResult {
  const execNode = new ExecutionNode({ command: label, exitCode: mergedIo.exitCode })
  const combined = chainStreams(allStdout)
  return [combined, mergedIo, execNode]
}

/**
 * What a compound command asks of the shell: to run the lists of statements
 * it picks, here, keeping what they wrote. Mirrors Python's _ConstructHost.
 */
/** Take what a construct's own expansions and trace have said. */
function takeSaid(context: EvaluationContext): Uint8Array {
  const said = diagnosticStderr(null, context)
  context.frame.diagnostics.length = 0
  return said
}

class ConstructHost extends ExpandHost {
  readonly allStdout: (ByteSource | null)[] = []
  mergedIo = new IOResult()
  lastExec: ExecutionNode | null = null
  loopSignal: LoopSignal | null = null
  left: Unwinding | null = null
  // Each test and body reads the fd 0 the construct started with, so an
  // `exec < f` in one reaches the rest.
  readonly bound: ReturnType<typeof fd0Binding>

  constructor(
    private readonly body: BodyRun,
    private readonly lists: readonly (readonly TSNodeLike[])[],
    context: EvaluationContext,
    executeFn: ExecuteFn,
    callStack: CallStack | null,
    word: TSNodeLike | null,
    private readonly wholeTests: boolean,
  ) {
    super(context, executeFn, callStack, word)
    this.bound = fd0Binding(context.session)
  }

  override async run(
    index: number,
    test: boolean,
    start: number,
    pending: number | null,
    framed: boolean,
    said: readonly (string | Uint8Array)[],
  ): Promise<[number, string, number, boolean]> {
    const session = this.session
    if (pending !== null) recordStatus(session, pending)
    const statements =
      start > 0 ? (this.lists[index] ?? []).slice(start) : (this.lists[index] ?? [])
    this.context.frame.diagnostics.push(...said)
    const leading = takeSaid(this.context)
    try {
      const [stdout, io, ran] = test
        ? await ignoringErrexit(session, () => this.body(statements, this.bound, leading))
        : await this.body(statements, this.bound, leading)
      if (!test) this.lastExec = ran
      keep(this.allStdout, stdout)
      this.mergedIo = await this.mergedIo.merge(
        test && !this.wholeTests
          ? new IOResult({ stderr: io.stderr, exitCode: this.mergedIo.exitCode })
          : io,
      )
      // The list changed the session; a construct that reads it reads it as
      // it goes on.
      if (framed) frame(session, this.callStack)
      const leaving = session.errexitExiting && !test
      return [io.exitCode, '', 0, leaving || session.shellOptions.noexec === true]
    } catch (sig) {
      if (sig instanceof LoopSignal) {
        keep(this.allStdout, sig.stdout)
        this.mergedIo = await this.mergedIo.merge(sig.io)
        this.loopSignal = sig
        if (framed) frame(session, this.callStack)
        const tag = sig instanceof BreakSignal ? 'break' : 'continue'
        return [sig.io.exitCode, tag, sig.levels, false]
      }
      if (!isUnwinding(sig)) throw sig
      this.left = sig
      return [0, 'stop', 0, false]
    }
  }
}

/**
 * Run a compound command on the session's shell, which picks each list and
 * hands it here to run. Mirrors Python's _run_construct.
 */
async function runConstruct(
  start: (shell: Shell) => ShellTask,
  body: BodyRun,
  lists: readonly (readonly TSNodeLike[])[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  word: TSNodeLike | null = null,
  wholeTests = false,
  framed = true,
): Promise<ConstructHost> {
  const session = context.session
  if (framed) frame(session, callStack)
  const host = new ConstructHost(body, lists, context, executeFn, callStack, word, wholeTests)
  let outcome: Item
  try {
    outcome = await drive(start(session.vars.shell), host, context.frame.diagnostics)
  } catch (sig) {
    if (!isUnwinding(sig)) throw sig
    throw await carried(sig, chainStreams(host.allStdout), host.mergedIo)
  }
  const [said, failed, tag, levels, pending, status] = outcome as readonly [
    string,
    boolean,
    string,
    number,
    number | null | undefined,
    number | null | undefined,
  ]
  if (pending !== null && pending !== undefined) recordStatus(session, pending)
  const leading = takeSaid(context)
  if (leading.byteLength > 0) {
    const [, last] = await body([], host.bound, leading)
    host.mergedIo = await host.mergedIo.merge(
      new IOResult({ stderr: last.stderr, exitCode: host.mergedIo.exitCode }),
    )
  }
  if (host.left !== null) {
    throw await carried(host.left, chainStreams(host.allStdout), host.mergedIo)
  }
  const signal = host.loopSignal
  if (tag !== '' && signal !== null) {
    signal.stdout = chainStreams(host.allStdout)
    signal.io = host.mergedIo
    signal.levels = levels
    throw signal
  }
  if (status !== null && status !== undefined) host.mergedIo.exitCode = status
  if (failed) {
    const stderr = said !== '' ? encodeText(said) : null
    host.mergedIo = await host.mergedIo.merge(new IOResult({ exitCode: 1, stderr }))
  }
  return host
}

function looped(host: ConstructHost, label: string): RedirectResult {
  return collectLoopResult(host.allStdout, host.mergedIo, label)
}

/** An `if`'s or a `case`'s result: the last body's node stands for it. */
function finished(host: ConstructHost, label: string): RedirectResult {
  const node = host.lastExec ?? new ExecutionNode({ command: label, exitCode: 0 })
  return [chainStreams(host.allStdout), host.mergedIo, node]
}

/** Run `if`: each test in turn, then the branch the first passing one opens. */
export async function handleIf(
  run: BodyRun,
  branches: readonly [TSNodeLike[], TSNodeLike[]][],
  elseBody: TSNodeLike[] | null,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const lists: (readonly TSNodeLike[])[] = [elseBody ?? []]
  const pairs: [number, number][] = []
  for (const [test, body] of branches) {
    pairs.push([lists.length, lists.length + 1])
    lists.push(test, body)
  }
  const host = await runConstruct(
    (shell) => shell.runIf(pairs, 0),
    run,
    lists,
    context,
    executeFn,
    callStack,
    null,
    true,
    false,
  )
  return finished(host, '')
}

/** Run `for`: the variable takes each word as typed, and keeps the last. */
export async function handleFor(
  run: BodyRun,
  variable: string,
  values: readonly (string | PathSpec)[],
  head: string,
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const words = values.map((value) => wordText(value))
  const host = await runConstruct(
    (shell) => shell.runFor(variable, words, head, 0, statements(context.session, [body])),
    run,
    [body],
    context,
    executeFn,
    callStack,
  )
  return looped(host, 'for')
}

/** Run `while` or `until`. */
export async function handleWhile(
  run: BodyRun,
  test: readonly TSNodeLike[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  until = false,
): Promise<RedirectResult> {
  const host = await runConstruct(
    (shell) => shell.runWhile(0, 1, until, statements(context.session, [test, body])),
    run,
    [test, body],
    context,
    executeFn,
    callStack,
  )
  return looped(host, until ? 'until' : 'while')
}

function nodes(parts: readonly TSNodeLike[]): ShellTreeNode[] {
  return parts.map(shellNode).filter((node): node is ShellTreeNode => node !== null)
}

/** Each list's statements as the shell reads them, each with its line. */
function statements(
  session: SessionState,
  lists: readonly (readonly TSNodeLike[])[],
): ((readonly [ShellTreeNode, number])[] | null)[] {
  return lists.map((list) => {
    const parsed = nodes(list)
    if (parsed.length !== list.length) return null
    return parsed.map((node, at) => {
      const statement = list[at]
      return [node, statement === undefined ? 0 : session.lineOf(statement)] as const
    })
  })
}

/**
 * A C-style `for` expression as the shell reads it: its nodes and the node
 * whose start ends its text, null for an empty slot. Mirrors Python's _slot.
 */
function slot(exprs: readonly TSNodeLike[]): ShellSlot | null {
  const first = exprs[0]
  if (first === undefined) return null
  const closer =
    (first.parent ?? null) === null ? null : (exprs[exprs.length - 1]?.nextSibling ?? null)
  return [nodes(exprs), closer === null ? null : shellNode(closer)]
}

/** Run bash's C-style for: ((init; cond; update)) around a body. */
export async function handleCfor(
  run: BodyRun,
  exprs: readonly (readonly TSNodeLike[])[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const slots = exprs.map(slot)
  const word = exprs.find((expr) => expr.length > 0)?.[0] ?? null
  const host = await runConstruct(
    (shell) => shell.runCFor(slots, 0, statements(context.session, [body])),
    run,
    [body],
    context,
    executeFn,
    callStack,
    word,
  )
  return looped(host, 'for')
}

/**
 * Run the first arm whose pattern matches `word`, and after it the arms its
 * terminator reaches: `;&` falls into the next arm's body untested, `;;&`
 * tests the rest, `;;` stops.
 */
export async function handleCase(
  run: BodyRun,
  word: string,
  items: readonly [readonly TSNodeLike[], readonly TSNodeLike[], string][],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const lists = items.map(([, body]) => body)
  const arms = items.map(
    ([patterns, , terminator], index) => [nodes(patterns), index, terminator] as const,
  )
  const first = items.find(([patterns]) => patterns.length > 0)?.[0][0] ?? null
  const host = await runConstruct(
    (shell) => shell.runCase(word, arms),
    run,
    lists,
    context,
    executeFn,
    callStack,
    first,
  )
  return finished(host, 'case')
}

/**
 * The select menu as bash 5.2 prints it: column-major in
 * `$COLUMNS` (80 when unset or not positive), each cell padded with tabs
 * to an 8-wide stop, one entry per row when they all fit on one.
 */
function selectMenu(words: readonly string[], columns: string): string {
  const width = atoi(columns)
  const indexLen = String(words.length).length
  const cell = Math.max(...words.map((w) => Array.from(w).length)) + indexLen + 4
  let rows = Math.ceil(words.length / Math.max(Math.floor((width > 0 ? width : 80) / cell), 1))
  if (rows === 1) rows = words.length
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    let col = 0
    for (let ind = row, pos = 0; ind < words.length; ind += rows, pos++) {
      while (col < pos * cell) {
        const tab = Math.floor((pos * cell) / 8) > Math.floor(col / 8)
        line += tab ? '\t' : ' '
        col = tab ? col + 8 - (col % 8) : col + 1
      }
      const label = String(ind + 1).padStart(pos === 0 ? String(rows).length : indexLen)
      const text = `${label}) ${words[ind] ?? ''}`
      line += text
      col += Array.from(text).length
    }
    lines.push(line + '\n')
  }
  return lines.join('')
}

/**
 * Run bash's select loop: menu to stderr, choice read from stdin. Each
 * iteration prompts with `$PS3` (`#? ` when unset), takes a line the way a
 * bare `read` does into REPLY, and sets the variable to the chosen entry
 * (empty for an out-of-range or non-numeric reply, like bash). An empty
 * reply redisplays the menu without running the body, and so does a body
 * that empties REPLY; end of input prints a newline and ends the loop with
 * status 1. An empty list runs nothing. `sink` is where the body's
 * statements write as they finish, so the loop's own newline lands in
 * order.
 */
export async function handleSelect(
  run: BodyRun,
  variable: string,
  values: readonly (string | PathSpec)[],
  head: string,
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<RedirectResult> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, context.frame.diagnostics)
  const lines = stdin !== null ? lineBuffer(stdin) : null
  const bound = fd0Binding(session)
  const words = values.map((v) => wordText(v))
  let showMenu = words.length > 0
  const traced = session.shellOptions.xtrace === true ? traceLine(head) : new Uint8Array()
  mergedIo = await land(
    [[Channel.STDERR, concat([traced, takeSaid(context)]), false]],
    sink ?? null,
    allStdout,
    mergedIo,
  )
  while (words.length > 0 && session.shellOptions.noexec !== true) {
    const env = visibleEnv(session)
    const menu = showMenu ? selectMenu(words, env.COLUMNS ?? '') : ''
    const prompt = menu + (env.PS3 ?? '#? ')
    mergedIo = await land(
      [[Channel.STDERR, encodeText(prompt), false]],
      sink ?? null,
      allStdout,
      mergedIo,
    )
    const reply = lines !== null ? await readReply(lines, signal) : null
    // A failed choice read (end of input, a readonly REPLY) ends the prompt
    // line; a readonly loop variable fails after it.
    let frozen: string | null = null
    if (reply !== null && view.isReadonly('REPLY')) frozen = 'REPLY'
    else if (reply !== null && reply !== '' && view.isReadonly(variable)) frozen = variable
    if (reply === null || frozen === 'REPLY') {
      if (sink !== undefined) await sink.emit(Channel.STDOUT, encodeText('\n'))
      else allStdout.push(encodeText('\n'))
    }
    if (reply === null || frozen !== null) {
      const err =
        frozen !== null ? encodeText(`${shellVoice()}${frozen}: readonly variable\n`) : null
      mergedIo = await mergedIo.merge(new IOResult({ exitCode: 1, stderr: err }))
      break
    }
    const number = /^\s*([+-]?\d+)[ \t]*$/.exec(reply)
    const index = number !== null ? Number(number[1]) : 0
    try {
      await view.set('REPLY', reply)
      showMenu = reply === ''
      if (showMenu) continue
      await view.set(variable, index >= 1 && index <= words.length ? (words[index - 1] ?? '') : '')
    } catch (err) {
      if (err instanceof ArithError) throw err.signal('', true)
      if (!(err instanceof PolicyDenied)) throw err
      mergedIo = await mergedIo.merge(
        new IOResult({ exitCode: 1, stderr: encodeText(`${err.message}\n`) }),
      )
      break
    }
    try {
      const [stdout, io] = await run(body, bound)
      keep(allStdout, stdout)
      mergedIo = await mergedIo.merge(io)
      if (session.errexitExiting) break
    } catch (sig) {
      if (!isUnwinding(sig)) throw sig
      if (!(sig instanceof LoopSignal)) throw await carried(sig, chainStreams(allStdout), mergedIo)
      mergedIo = await absorbed(sig, allStdout, mergedIo)
      if (sig instanceof BreakSignal) break
    }
    showMenu = (visibleEnv(session).REPLY ?? '') === ''
  }
  // The loop variable is an ordinary variable in bash and keeps its
  // last value after the loop (`for X in a b; do :; done; echo $X`
  // prints b); nothing is put back.
  return collectLoopResult(allStdout, mergedIo, 'select')
}

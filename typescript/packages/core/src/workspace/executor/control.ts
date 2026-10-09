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

import type { EvaluationContext } from '../evaluation.ts'
import { lineBuffer } from '../../io/async_line_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { concat } from '../../io/cachable_iterator.ts'
import type { HandOff } from '../../policy/types.ts'
import type { Decisions } from '../../policy/decisions.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { type Policies } from '../../policy/index.ts'
import { ArithError, ExitSignal, ReadonlyError, ReturnSignal } from '../../shell/errors.ts'
import {
  errexitActs,
  fd0Binding,
  finishStatement,
  ignoringErrexit,
  land,
  recordStatus,
} from './statement.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { readReply } from './builtins/read/index.ts'
import type { PathSpec } from '../../types.ts'
import { wordText } from '../../types.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'

import { sessionView, visibleEnv } from '../session/state.ts'
import { ExecutionNode } from '../types.ts'
import { runStatement } from './jobs.ts'
import { errTrapArmed, runErrTrap, runReturnTrap } from './traps.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecuteStringFn } from './builtins/types.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const MAX_WHILE = 10_000

/** Runs a list of statements: `executeBody` bound to the walk. */
export type BodyRun = (
  nodes: readonly TSNodeLike[],
  bound?: ReturnType<typeof fd0Binding>,
) => Promise<Result>

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
 * rather than run inline; `jobTable` and `agentId` are the job plane it
 * needs. The ERR action answers a failing statement, its output landed
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
  agentId: string | null,
  handed: HandOff | null,
  decisions: Decisions | null,
  executeFn: ExecuteStringFn | null = null,
  sink: JobConsole | null = null,
  bound: ReturnType<typeof fd0Binding> = fd0Binding(context.session),
): Promise<Result> {
  const session = context.session
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  for (const cmd of body) {
    if (cmd.type === NT.COMMENT) continue
    const armed = errTrapArmed(session)
    try {
      const [stdout, io, execNode] = await runStatement(
        executeNode,
        cmd,
        context,
        stdin,
        bound,
        callStack,
        jobTable,
        agentId,
        handed,
        decisions,
      )
      lastExec = execNode
      allStdout.push(await finishStatement(stdout, io, session, cmd))
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
      throw await carried(sig, chainNonNull(allStdout), mergedIo)
    }
  }
  return [chainNonNull(allStdout), mergedIo, lastExec]
}

function chainNonNull(sources: readonly (ByteSource | null)[]): ByteSource | null {
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
    sig.stdout = chainNonNull([stdout, sig.stdout])
    sig.io = await io.merge(sig.io)
    return sig
  }
  sig.stderr = concat([await materialize(io.stderr), sig.stderr])
  if (sig instanceof ReturnSignal) sig.stdout = chainNonNull([stdout, sig.stdout])
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
  executeFn: ExecuteStringFn | null,
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
  return [chainNonNull(outputs), io]
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
  allStdout.push(sig.stdout)
  const merged = await mergedIo.merge(sig.io)
  if (sig.levels > 1) {
    sig.stdout = chainNonNull(allStdout)
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
): Result {
  const execNode = new ExecutionNode({ command: label, exitCode: mergedIo.exitCode })
  const combined = chainNonNull(allStdout)
  return [combined, mergedIo, execNode]
}

export async function handleIf(
  run: BodyRun,
  branches: readonly [TSNodeLike[], TSNodeLike[]][],
  elseBody: TSNodeLike[] | null,
  session: SessionState,
): Promise<Result> {
  // Each test and the branch read the fd 0 the `if` started with, so an
  // `exec < f` or `exec <&-` in one reaches the next; a test runs with
  // `set -e` ignored.
  const bound = fd0Binding(session)
  // What the tests wrote stays, ahead of what the branch writes.
  const leadStdout: (ByteSource | null)[] = []
  let lead = new IOResult()
  try {
    let chosen = elseBody ?? []
    for (const [test, body] of branches) {
      const [stdout, io] = await ignoringErrexit(session, () => run(test, bound))
      leadStdout.push(stdout)
      lead = await lead.merge(io)
      if (io.exitCode === 0) {
        chosen = body
        break
      }
    }
    const [stdout, io, lastExec] = await run(chosen, bound)
    return [chainNonNull([...leadStdout, stdout]), await lead.merge(io), lastExec]
  } catch (sig) {
    if (!isUnwinding(sig)) throw sig
    throw await carried(sig, chainNonNull(leadStdout), lead)
  }
}

// `set -n` inside a loop body has to stop the *driver* too, not only the
// statements: `executeNode` refuses every node while the option is on, so
// the `break` or the false condition the driver is waiting for is one of
// the refused nodes and it would spin to MAX_WHILE. GNU never runs the
// loop at all, which is what falling straight out of it produces.
export async function handleFor(
  run: BodyRun,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  policies: Policies | null = null,
): Promise<Result> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, policies, context.frame.diagnostics)
  // The loop variable is the shell's own write: readonly is bash's
  // rule, checked up front so the loop never starts, exactly as bash
  // refuses `for x` on a readonly x before the first iteration.
  if (view.isReadonly(variable)) {
    const err = encodeText(`bash: ${variable}: readonly variable\n`)
    return collectLoopResult([], new IOResult({ exitCode: 1, stderr: err }), 'for')
  }
  // Each iteration reads the fd 0 the loop started with, so an `exec < f` in
  // one reaches the next.
  const bound = fd0Binding(session)
  for (const val of values) {
    if (session.shellOptions.noexec === true) break
    // bash keeps `for f in sub/*.txt` matches relative, so the loop
    // variable takes the typed form; a policy denial aborts the loop
    // before its body runs.
    try {
      await view.set(variable, wordText(val))
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
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof LoopSignal)) throw sig
      mergedIo = await absorbed(sig, allStdout, mergedIo)
      if (sig instanceof BreakSignal) break
      continue
    }
  }
  // The loop variable is an ordinary variable in bash and keeps its
  // last value after the loop (`for X in a b; do :; done; echo $X`
  // prints b); nothing is put back.
  return collectLoopResult(allStdout, mergedIo, 'for')
}

export async function handleWhile(
  run: BodyRun,
  test: readonly TSNodeLike[],
  body: readonly TSNodeLike[],
  session: SessionState,
  until = false,
): Promise<Result> {
  const label = until ? 'until' : 'while'
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  // Each test and body reads the fd 0 the loop started with, so an
  // `exec < f` in one reaches the rest.
  const bound = fd0Binding(session)
  let i = 0
  for (; i < MAX_WHILE; i++) {
    if (session.shellOptions.noexec === true) break
    try {
      const [condStdout, condIo] = await ignoringErrexit(session, () => run(test, bound))
      allStdout.push(condStdout)
      mergedIo = await mergedIo.merge(
        new IOResult({ stderr: condIo.stderr, exitCode: mergedIo.exitCode }),
      )
      if ((condIo.exitCode === 0) === until) break
      const [stdout, io] = await run(body, bound)
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof LoopSignal)) {
        if (isUnwinding(sig)) throw await carried(sig, chainNonNull(allStdout), mergedIo)
        throw sig
      }
      mergedIo = await absorbed(sig, allStdout, mergedIo)
      if (sig instanceof BreakSignal) break
      continue
    }
  }
  if (i === MAX_WHILE) capped(mergedIo, label)
  return collectLoopResult(allStdout, mergedIo, label)
}

/**
 * Say on stderr that a loop stopped at MAX_WHILE iterations, mirage's own
 * cap (bash has none), so a runaway loop or a `while read` over a longer
 * stream is never cut short silently. Mirrors Python's _capped.
 */
function capped(io: IOResult, label: string): void {
  const warn = encodeText(
    `warning: ${label} loop terminated after ${MAX_WHILE.toString()} iterations\n`,
  )
  io.stderr = io.stderr instanceof Uint8Array ? concat([io.stderr, warn]) : warn
}

export type CforEval = (exprs: readonly TSNodeLike[], dflt: number) => Promise<number>

/**
 * Run bash's C-style for: ((init; cond; update)) around a body.
 *
 * `evalExpr` evaluates one expression slot to its integer value (the
 * default when the slot is empty) and throws ArithError with the
 * offending expression text on an invalid expression, or ReadonlyError
 * when it assigns to a readonly variable; bash aborts the loop with
 * status 1, keeping the output of iterations that ran. The update
 * expression still runs after `continue`, per bash. A PolicyDenied is a
 * header expression assigning a hidden name.
 */
export async function handleCfor(
  run: BodyRun,
  exprs: readonly (readonly TSNodeLike[])[],
  body: readonly TSNodeLike[],
  evalExpr: CforEval,
  session: SessionState,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const bound = fd0Binding(session)
  try {
    await evalExpr(exprs[0] ?? [], 0)
    let i = 0
    for (; i < MAX_WHILE; i++) {
      if (session.shellOptions.noexec === true) break
      if ((await evalExpr(exprs[1] ?? [], 1)) === 0) break
      try {
        const [stdout, io] = await run(body, bound)
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (!(sig instanceof LoopSignal)) throw sig
        mergedIo = await absorbed(sig, allStdout, mergedIo)
        if (sig instanceof BreakSignal) break
        await evalExpr(exprs[2] ?? [], 0)
        continue
      }
      await evalExpr(exprs[2] ?? [], 0)
    }
    if (i === MAX_WHILE) capped(mergedIo, 'for')
  } catch (err) {
    if (
      !(err instanceof ArithError) &&
      !(err instanceof ReadonlyError) &&
      !(err instanceof PolicyDenied)
    ) {
      throw err
    }
    if (err instanceof ArithError && err.inSubscript) {
      throw await carried(err.signal(), chainNonNull(allStdout), mergedIo)
    }
    const prefix = err instanceof ArithError ? 'bash: ((: ' : 'bash: '
    const errBytes = encodeText(`${prefix}${err.message}\n`)
    mergedIo = await mergedIo.merge(new IOResult({ exitCode: 1, stderr: errBytes }))
    mergedIo.exitCode = 1
  }
  return collectLoopResult(allStdout, mergedIo, 'for')
}

/**
 * Run the first arm whose pattern matches `word`, and after it the arms its
 * terminator reaches: `;&` falls into the next arm's body untested, `;;&`
 * tests the rest, `;;` stops.
 */
export async function handleCase(
  run: BodyRun,
  word: string,
  items: readonly [readonly string[], readonly TSNodeLike[], string][],
  session: SessionState,
): Promise<Result> {
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: 'case', exitCode: 0 })
  let fallthrough = false
  // Each arm reads the fd 0 the `case` started with, so an `exec < f` in one
  // reaches an arm it falls into.
  const bound = fd0Binding(session)
  const extglob = session.shopts.extglob ?? false
  for (const [patterns, body, terminator] of items) {
    if (!(fallthrough || patterns.some((p) => fnmatch(word, p, extglob)))) continue
    try {
      const [stdout, io, execNode] = await run(body, bound)
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      lastExec = execNode
    } catch (sig) {
      if (!isUnwinding(sig)) throw sig
      throw await carried(sig, chainNonNull(allStdout), mergedIo)
    }
    fallthrough = terminator === ';&'
    if (session.errexitExiting || (terminator !== ';&' && terminator !== ';;&')) break
  }
  return [chainNonNull(allStdout), mergedIo, lastExec]
}

/**
 * The select menu as bash 5.2 prints it: column-major in
 * `$COLUMNS` (80 when unset or not positive), each cell padded with tabs
 * to an 8-wide stop, one entry per row when they all fit on one.
 */
function selectMenu(words: readonly string[], columns: string): string {
  const width = parseInt(/^\s*[+-]?\d+/.exec(columns)?.[0] ?? '0', 10)
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
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  policies: Policies | null = null,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<Result> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, policies, context.frame.diagnostics)
  const lines = stdin !== null ? lineBuffer(stdin) : null
  const bound = fd0Binding(session)
  const words = values.map((v) => wordText(v))
  let showMenu = words.length > 0
  for (let i = 0; i < (words.length > 0 ? MAX_WHILE : 0); i++) {
    if (session.shellOptions.noexec === true) break
    const env = visibleEnv(session)
    const menu = showMenu ? selectMenu(words, env.COLUMNS ?? '') : ''
    const prompt = menu + (env.PS3 ?? '#? ')
    mergedIo = await mergedIo.merge(
      new IOResult({ stderr: prompt !== '' ? encodeText(prompt) : null }),
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
      const err = frozen !== null ? encodeText(`bash: ${frozen}: readonly variable\n`) : null
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
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof LoopSignal)) throw sig
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

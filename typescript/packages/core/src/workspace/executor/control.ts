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
import { fd0Binding, finishStatement, recordStatus } from './statement.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { readReply } from './builtins/read/index.ts'
import type { PathSpec } from '../../types.ts'
import { wordText } from '../../types.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'

import { sessionView, visibleEnv } from '../session/state.ts'
import { ExecutionNode } from '../types.ts'
import { runStatement } from './jobs.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const MAX_WHILE = 10_000

export class BreakSignal extends Error {
  readonly stdout: ByteSource | null
  readonly io: IOResult
  readonly levels: number
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult(), levels = 1) {
    super('break')
    this.name = 'BreakSignal'
    this.stdout = stdout
    this.io = io
    this.levels = levels
  }
}

export class ContinueSignal extends Error {
  readonly stdout: ByteSource | null
  readonly io: IOResult
  readonly levels: number
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult(), levels = 1) {
    super('continue')
    this.name = 'ContinueSignal'
    this.stdout = stdout
    this.io = io
    this.levels = levels
  }
}

/**
 * Execute a list of body commands sequentially.
 *
 * A statement ending in `&` is launched as a job through `runStatement`
 * rather than run inline; `jobTable` and `agentId` are the job plane it
 * needs. `test` marks an `if`/`while`/`until` test, whose failures
 * `set -e` ignores; `bound` is `fd0Binding` as the construct running the
 * list started, so an `exec <&-` in a loop body reaches the next test.
 */
async function executeBody(
  executeNode: ExecuteNodeFn,
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  agentId: string | null,
  handed: HandOff | null,
  decisions: Decisions | null,
  test = false,
  bound: ReturnType<typeof fd0Binding> = fd0Binding(context.session),
): Promise<Result> {
  const session = context.session
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  for (const cmd of body) {
    // A comment is no statement: it leaves `$?` as it was.
    if (cmd.type === NT.COMMENT) continue
    try {
      const [rawStdout, io, execNode] = await runStatement(
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
      const stdout = await finishStatement(rawStdout, io, session, cmd)
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        !test &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(cmd.type) &&
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    } catch (sig) {
      if (!isUnwinding(sig)) throw sig
      // The control builtin is a statement the loop leaves through
      // rather than closes, so its own status is recorded here: bash
      // leaves `${PIPESTATUS[@]}` at `0` after `break`.
      if (sig instanceof BreakSignal || sig instanceof ContinueSignal) {
        recordStatus(session, sig.io.exitCode)
      }
      throw await carried(sig, chainNonNull(allStdout), mergedIo)
    }
  }
  const combined = chainNonNull(allStdout)
  return [combined, mergedIo, lastExec]
}

function chainNonNull(sources: readonly (ByteSource | null)[]): ByteSource | null {
  const nonNull = sources.filter(
    (s): s is ByteSource => s !== null && !(s instanceof Uint8Array && s.byteLength === 0),
  )
  if (nonNull.length === 0) return null
  return asyncChain(nonNull)
}

export type Unwinding = BreakSignal | ContinueSignal | ReturnSignal | ExitSignal

export function isUnwinding(err: unknown): err is Unwinding {
  return (
    err instanceof BreakSignal ||
    err instanceof ContinueSignal ||
    err instanceof ReturnSignal ||
    err instanceof ExitSignal
  )
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
  if (sig instanceof BreakSignal || sig instanceof ContinueSignal) {
    const Signal = sig instanceof BreakSignal ? BreakSignal : ContinueSignal
    return new Signal(chainNonNull([stdout, sig.stdout]), await io.merge(sig.io), sig.levels)
  }
  const stderr = concat([await materialize(io.stderr), sig.stderr])
  if (sig instanceof ReturnSignal) {
    return new ReturnSignal(sig.exitCode, stderr, chainNonNull([stdout, sig.stdout]))
  }
  sig.stdout = concat([await materialize(stdout), sig.stdout ?? new Uint8Array()])
  sig.stderr = stderr
  return sig
}

/**
 * What a child shell reports when an `Unwinding` ends it: what it wrote, its
 * diagnostic, and its status, `exit`'s contained one, `return`'s own, or that
 * of `break` or `continue`. A child running one simple command is the shell
 * `exit` ends (`simple`), so it reports `exit`'s own status (`: ${U?} | cat`
 * is 127, `( : ${U?} ) | cat` is 1). Mirrors Python's ended.
 */
export function ended(sig: Unwinding, simple = false): IOResult {
  if (sig instanceof BreakSignal || sig instanceof ContinueSignal) {
    return new IOResult({ stdout: sig.stdout, stderr: sig.io.stderr, exitCode: sig.io.exitCode })
  }
  return new IOResult({
    stdout: sig.stdout,
    stderr: sig.stderr.byteLength > 0 ? sig.stderr : null,
    exitCode: sig instanceof ExitSignal && !simple ? sig.containedCode : sig.exitCode,
  })
}

/**
 * Take the diagnostic an `Unwinding` carries, for the redirects it was
 * written under to route. Mirrors Python's take_stderr.
 */
export async function takeStderr(sig: Unwinding): Promise<Uint8Array> {
  if (sig instanceof BreakSignal || sig instanceof ContinueSignal) {
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
  sig: BreakSignal | ContinueSignal,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<IOResult> {
  allStdout.push(sig.stdout)
  const merged = await mergedIo.merge(sig.io)
  if (sig.levels > 1) {
    const Signal = sig instanceof BreakSignal ? BreakSignal : ContinueSignal
    throw new Signal(chainNonNull(allStdout), merged, sig.levels - 1)
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
  executeNode: ExecuteNodeFn,
  branches: readonly [TSNodeLike[], TSNodeLike[]][],
  elseBody: TSNodeLike[] | null,
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  const run = (nodes: readonly TSNodeLike[], isTest = false): Promise<Result> =>
    executeBody(
      executeNode,
      nodes,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      handed,
      decisions,
      isTest,
    )
  // What the tests wrote stays, ahead of what the branch writes.
  const leadStdout: (ByteSource | null)[] = []
  let lead = new IOResult()
  try {
    let chosen = elseBody ?? []
    for (const [test, body] of branches) {
      const [stdout, io] = await run(test, true)
      leadStdout.push(stdout)
      lead = await lead.merge(io)
      if (io.exitCode === 0) {
        chosen = body
        break
      }
    }
    const [stdout, io, lastExec] = await run(chosen)
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
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
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
  for (const val of values) {
    if (session.shellOptions.noexec === true) break
    // env stores strings only; bash keeps `for f in sub/*.txt`
    // matches relative, so the loop variable takes the typed form.
    // The write goes through the session door; a policy denial
    // aborts the loop before its body runs.
    const textVal = wordText(val)
    try {
      await view.set(variable, textVal)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      mergedIo = await mergedIo.merge(
        new IOResult({ exitCode: 1, stderr: encodeText(`${err.message}\n`) }),
      )
      break
    }
    try {
      const [stdout, io] = await executeBody(
        executeNode,
        body,
        context,
        stdin,
        callStack,
        jobTable,
        agentId,
        handed,
        decisions,
      )
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof BreakSignal || sig instanceof ContinueSignal)) throw sig
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

async function conditionLoop(
  executeNode: ExecuteNodeFn,
  test: readonly TSNodeLike[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  agentId: string | null,
  handed: HandOff | null,
  decisions: Decisions | null,
  label: string,
  breakOnZero: boolean,
): Promise<Result> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  let hitLimit = true
  const bound = fd0Binding(session)
  const run = (nodes: readonly TSNodeLike[], isTest = false): Promise<Result> =>
    executeBody(
      executeNode,
      nodes,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      handed,
      decisions,
      isTest,
      isTest ? bound : fd0Binding(session),
    )
  for (let i = 0; i < MAX_WHILE; i++) {
    if (session.shellOptions.noexec === true) {
      hitLimit = false
      break
    }
    try {
      const [condStdout, condIo] = await run(test, true)
      allStdout.push(condStdout)
      mergedIo = await mergedIo.merge(
        new IOResult({ stderr: condIo.stderr, exitCode: mergedIo.exitCode }),
      )
      if ((condIo.exitCode === 0) === breakOnZero) {
        hitLimit = false
        break
      }
      const [stdout, io] = await run(body)
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof BreakSignal || sig instanceof ContinueSignal)) {
        if (isUnwinding(sig)) throw await carried(sig, chainNonNull(allStdout), mergedIo)
        throw sig
      }
      mergedIo = await absorbed(sig, allStdout, mergedIo)
      if (sig instanceof BreakSignal) {
        hitLimit = false
        break
      }
      continue
    }
  }

  if (hitLimit) {
    const warn = encodeText(
      `warning: ${label} loop terminated after ${MAX_WHILE.toString()} iterations\n`,
    )
    const existing = mergedIo.stderr
    if (existing instanceof Uint8Array && existing.byteLength > 0) {
      const combined = new Uint8Array(existing.byteLength + warn.byteLength)
      combined.set(existing, 0)
      combined.set(warn, existing.byteLength)
      mergedIo.stderr = combined
    } else {
      mergedIo.stderr = warn
    }
  }
  return collectLoopResult(allStdout, mergedIo, label)
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
 * expression still runs after `continue`, per bash.
 */
export async function handleCfor(
  executeNode: ExecuteNodeFn,
  exprs: readonly (readonly TSNodeLike[])[],
  body: readonly TSNodeLike[],
  evalExpr: CforEval,
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  let hitLimit = true
  try {
    await evalExpr(exprs[0] ?? [], 0)
    for (let i = 0; i < MAX_WHILE; i++) {
      if (session.shellOptions.noexec === true) {
        hitLimit = false
        break
      }
      if ((await evalExpr(exprs[1] ?? [], 1)) === 0) {
        hitLimit = false
        break
      }
      try {
        const [stdout, io] = await executeBody(
          executeNode,
          body,
          context,
          stdin,
          callStack,
          jobTable,
          agentId,
          handed,
          decisions,
        )
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (!(sig instanceof BreakSignal || sig instanceof ContinueSignal)) throw sig
        mergedIo = await absorbed(sig, allStdout, mergedIo)
        if (sig instanceof BreakSignal) {
          hitLimit = false
          break
        }
        await evalExpr(exprs[2] ?? [], 0)
        continue
      }
      await evalExpr(exprs[2] ?? [], 0)
    }
  } catch (err) {
    // PolicyDenied is a header expression assigning a hidden name,
    // refused by the same door as any denied assignment.
    if (
      !(err instanceof ArithError) &&
      !(err instanceof ReadonlyError) &&
      !(err instanceof PolicyDenied)
    ) {
      throw err
    }
    const prefix = err instanceof ArithError ? 'bash: ((: ' : 'bash: '
    const errBytes = encodeText(`${prefix}${err.message}\n`)
    mergedIo = await mergedIo.merge(new IOResult({ exitCode: 1, stderr: errBytes }))
    mergedIo.exitCode = 1
    return collectLoopResult(allStdout, mergedIo, 'for')
  }
  if (hitLimit) {
    const warn = encodeText(
      `warning: for loop terminated after ${MAX_WHILE.toString()} iterations\n`,
    )
    const existing = mergedIo.stderr
    if (existing instanceof Uint8Array && existing.byteLength > 0) {
      const combined = new Uint8Array(existing.byteLength + warn.byteLength)
      combined.set(existing, 0)
      combined.set(warn, existing.byteLength)
      mergedIo.stderr = combined
    } else {
      mergedIo.stderr = warn
    }
  }
  return collectLoopResult(allStdout, mergedIo, 'for')
}

export function handleWhile(
  executeNode: ExecuteNodeFn,
  test: readonly TSNodeLike[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  return conditionLoop(
    executeNode,
    test,
    body,
    context,
    stdin,
    callStack,
    jobTable,
    agentId,
    handed,
    decisions,
    'while',
    false,
  )
}

export function handleUntil(
  executeNode: ExecuteNodeFn,
  test: readonly TSNodeLike[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  return conditionLoop(
    executeNode,
    test,
    body,
    context,
    stdin,
    callStack,
    jobTable,
    agentId,
    handed,
    decisions,
    'until',
    true,
  )
}

export async function handleCase(
  executeNode: ExecuteNodeFn,
  word: string,
  items: readonly [readonly string[], readonly TSNodeLike[], string][],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  const session = context.session
  const allStdout: ByteSource[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: 'case', exitCode: 0 })
  let ran = false
  let fallthrough = false
  const bound = fd0Binding(session)
  for (const [patterns, body, terminator] of items) {
    if (!(fallthrough || patterns.some((p) => fnmatch(word, p)))) continue
    ran = true
    for (const stmt of body) {
      if (stmt.type === NT.COMMENT) continue
      let result: Result
      try {
        result = await runStatement(
          executeNode,
          stmt,
          context,
          stdin,
          bound,
          callStack,
          jobTable,
          agentId,
          handed,
          decisions,
        )
      } catch (sig) {
        if (!isUnwinding(sig)) throw sig
        throw await carried(sig, chainNonNull(allStdout), mergedIo)
      }
      const [rawStdout, io, execNode] = result
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session, stmt)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    }
    if (terminator === ';&') {
      // Fall through: run the next arm's body without testing it.
      fallthrough = true
      continue
    }
    // ;;& keeps testing remaining patterns; ;; stops here.
    fallthrough = false
    if (terminator !== ';;&') break
  }
  if (!ran) return [null, new IOResult(), new ExecutionNode({ command: 'case', exitCode: 0 })]
  const first = allStdout[0]
  if (allStdout.length === 1 && first !== undefined) return [first, mergedIo, lastExec]
  const combined = allStdout.length > 0 ? asyncChain(allStdout) : null
  return [combined, mergedIo, lastExec]
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
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<Result> {
  const session = context.session
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, policies, context.frame.diagnostics)
  const lines = stdin !== null ? lineBuffer(stdin) : null
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
      if (!(err instanceof PolicyDenied)) throw err
      mergedIo = await mergedIo.merge(
        new IOResult({ exitCode: 1, stderr: encodeText(`${err.message}\n`) }),
      )
      break
    }
    try {
      const [stdout, io] = await executeBody(
        executeNode,
        body,
        context,
        stdin,
        callStack,
        jobTable,
        agentId,
        handed,
        decisions,
      )
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    } catch (sig) {
      if (!(sig instanceof BreakSignal || sig instanceof ContinueSignal)) throw sig
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

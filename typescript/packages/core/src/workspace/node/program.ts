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
import { CommandTimeoutError } from '../../commands/errors.ts'
import { isControlFlowError } from '../workspace/failure.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { DiscardSignal, ExitSignal } from '../../shell/errors.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { getText } from '../../shell/helpers.ts'
import { pipelineTransparent } from '../../shell/node_kind.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { isFsError } from '../../errors/fs.ts'
import {
  BreakSignal,
  ContinueSignal,
  carried,
  isUnwinding,
  type Unwinding,
} from '../executor/control.ts'
import { divertStatement } from '../executor/builtins/exec/index.ts'
import { handleBackground } from '../executor/jobs.ts'
import type { ExecuteNodeFn } from '../executor/command/types.ts'
import {
  asWritten,
  errexitActs,
  failedRead,
  fd0Binding,
  land,
  recordStatus,
  recording,
  statementOutput,
  statementStdin,
} from '../executor/statement.ts'
import { errTrapArmed, runErrTrap, runExitTrap } from '../executor/traps.ts'
import type { ExecuteFn } from '../expand/node.ts'
import { Recorder, type StreamOwner } from '../../shell/descriptors.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'

import { ExecutionNode } from '../types.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function executeProgram(
  recurse: ExecuteNodeFn,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable,
  agentId: string,
  // The op door, threaded so an active `exec` redirect can send each
  // statement's output to its file; undefined (a nested loop that is not
  // the program root) leaves output undiverted.
  dispatch?: DispatchFn,
  // The line's hand-off and its ledger, for a background job to borrow.
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
  // Takes each statement's output as it finishes, in the order it was
  // written, instead of the result. The outermost program of a session's
  // line routes what a statement wrote to the session's terminal through a
  // copy (`exec 3>&1`); a nested one (`eval`, `source`) leaves that to it.
  sink: JobConsole | null = null,
  // An inline program runs on its caller's frames (`eval`, `source`, an
  // alias, `$( )`), so an `exit`, `return`, `break` or `continue` goes on
  // into the caller, after what the program wrote; any other program is a
  // shell of its own and ends there, running its EXIT action through
  // `executeFn`. Either resumes at its next line after an error that
  // discards one, unless it runs in a child shell.
  inline = false,
  executeFn: ExecuteFn | null = null,
): Promise<Result> {
  const session = context.session
  // Every program loop is one parse, which is the unit bash's alias rule
  // counts in: an alias defined on this parse and row is not expanded by
  // a use on the same parse and row. Restored on the way out so a nested
  // parse (`eval`, `source`, `bash -c`) does not leave its id behind.
  session.parseSeq += 1
  const outerParse: [number, number] = [session.parseCurrent, session.parseRow]
  session.parseCurrent = session.parseSeq
  session.parseRow = 0
  const root = !session.lineOpen
  session.lineOpen = true
  try {
    return await runProgram(
      recurse,
      node,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      dispatch,
      handed,
      decisions,
      sink,
      root ? session.terminal : null,
      inline,
      executeFn,
    )
  } finally {
    ;[session.parseCurrent, session.parseRow] = outerParse
    if (root) {
      session.lineOpen = false
      session.errexitExiting = false
    }
  }
}

async function runProgram(
  recurse: ExecuteNodeFn,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable,
  agentId: string,
  dispatch?: DispatchFn,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
  sink: JobConsole | null = null,
  own: StreamOwner | null = null,
  inline = false,
  executeFn: ExecuteFn | null = null,
): Promise<Result> {
  const session = context.session
  const children = node.children
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  // Source lines and the highest one `set -v` has already echoed.
  const sourceLines = getText(node).split('\n')
  let echoedRow = -1
  const bound = fd0Binding(session)

  let i = 0
  while (i < children.length) {
    const child = children[i]
    if (child === undefined) {
      i += 1
      continue
    }
    if (child.isNamed !== true || child.type === NT.COMMENT) {
      i += 1
      continue
    }
    if (child.type === NT.ERROR) {
      // A line bash refuses never gets here (checkSyntax gates it), so an
      // ERROR node is a fragment the grammar recovered from in a line bash
      // reads, which we deliberately skip.
      i += 1
      continue
    }

    // `set -n` reads without executing, so every statement after the
    // one that set it is skipped. Checking here rather than deeper
    // gives bash's one-way trip for free: a later `set +n` is itself
    // a statement, so it never runs and cannot turn execution back
    // on within the same input.
    if (session.shellOptions.noexec === true) break

    // `set -v` echoes input to stderr as the reader consumes it, and
    // the unit is a *line*, not a statement: GNU answers
    // `set -v; echo a` with nothing at all, because that whole line
    // was already read before the option took effect, while
    // `set -v\necho a` echoes the second line. So a line is echoed
    // once, when the first statement on it runs, and a statement
    // spanning several lines carries all of them.
    const startRow = child.startPosition?.row ?? 0
    if (startRow > echoedRow) {
      // From the line after the last one echoed, not from this
      // statement's own row: the reader consumes comments and blank
      // lines too, so `# note`, an empty line and `echo ok` all reach
      // stderr. Clamping to the next executable row dropped everything
      // that carried no node.
      const first = echoedRow + 1
      const last = child.endPosition?.row ?? startRow
      if (session.shellOptions.verbose === true && last >= first) {
        const text = sourceLines.slice(first, last + 1).join('\n')
        mergedIo = await land(
          [[Channel.STDERR, encodeText(`${text}\n`), false]],
          sink,
          allStdout,
          mergedIo,
        )
      }
      // Marked read either way: a line reaches the reader once, so
      // a line whose own first statement turned the option on was
      // already past it and is never echoed.
      echoedRow = last
    }

    if (children[i + 1]?.type === NT.BACKGROUND) {
      let launched: [ByteSource | null, IOResult, ExecutionNode]
      try {
        launched = await handleBackground(
          recurse,
          child,
          null,
          context,
          jobTable,
          agentId,
          stdin,
          callStack,
          handed,
          decisions,
        )
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // A job the shell cannot fork ends the line, as a failed fork(2)
        // ends bash's.
        mergedIo = await mergedIo.merge(
          new IOResult({ exitCode: err.exitCode, stderr: err.stderr }),
        )
        mergedIo.exitCode = err.exitCode
        recordStatus(session, err.exitCode)
        lastExec = new ExecutionNode({
          command: child.text,
          exitCode: err.exitCode,
          stderr: err.stderr,
        })
        break
      }
      const [bgStdout, bgIo, bgExec] = launched
      lastExec = bgExec
      // Launching a job is itself a statement: bash sets $? to 0
      // (the launch status), so `false; cmd & echo $?` prints 0.
      recordStatus(session, bgIo.exitCode)
      if (bgStdout !== null) allStdout.push(bgStdout)
      mergedIo = await mergedIo.merge(bgIo)
      i += 2
      continue
    }

    const at = i
    i += 1
    const armed = errTrapArmed(session)
    // Each statement writes to a recorder rather than straight to the
    // program's output, so what it wrote to the terminal through a copy
    // (`exec 3>&1`) keeps its place, past an `exec` diversion, and what it
    // wrote to an enclosing level's stream goes on there.
    const recorder = new Recorder()
    let io: IOResult
    try {
      // `exec < file` feeds the shell's stdin: a later `read` or `while
      // read` sees it, and each statement reads on from where the one
      // before it stopped.
      const childStdin = statementStdin(session, stdin, bound)
      let s: ByteSource | null
      ;[s, io, lastExec] = await recording(session, recorder, () =>
        recurse(child, context, childStdin, callStack, { sink: recorder }),
      )
      let stdout: ByteSource | null
      try {
        stdout = await materialize(s)
      } catch (err) {
        if (isControlFlowError(err) || err instanceof CommandTimeoutError) throw err
        // Lazy reads can fail on the first pull (e.g. a backend size
        // guard), which is the command's failure, not a crash.
        if (isFsError(err)) await failedRead(io, err, lastExec)
        else {
          io.stderr = concat([
            await materialize(io.stderr),
            encodeText(`${err instanceof Error ? err.message : String(err)}\n`),
          ])
          io.exitCode = 1
        }
        lastExec.exitCode = io.exitCode
        stdout = null
      }
      recordStatus(session, io.exitCode, pipelineTransparent(child))
      // An `exec` redirect sends the shell's own output to a file: every
      // statement after the `exec` diverts here, so nothing bubbles to the
      // terminal and stderr lands in its own target.
      const written = await divertStatement(
        dispatch,
        session,
        await statementOutput(recorder, stdout, io, own, sink),
        io,
        child,
        lastExec.command ?? '',
      )
      mergedIo = await land(written, sink, allStdout, mergedIo)
      mergedIo = await mergedIo.merge(io)
      mergedIo = await land(
        await runErrTrap(
          executeFn ?? null,
          child,
          io.exitCode,
          session,
          armed,
          stdin,
          callStack,
          lastExec,
        ),
        sink,
        allStdout,
        mergedIo,
      )
    } catch (err) {
      if (!isUnwinding(err)) throw err
      // What it wrote before it left; the ERR action answering it left
      // after that was landed.
      mergedIo = await land(
        await statementOutput(recorder, null, new IOResult(), own, sink),
        sink,
        allStdout,
        mergedIo,
      )
      let resumes: boolean
      ;[resumes, mergedIo, lastExec] = await unwound(
        err,
        child,
        context,
        stdin,
        callStack,
        sink,
        inline,
        executeFn,
        allStdout,
        mergedIo,
      )
      if (resumes) {
        i = nextLine(node, children, at)
        continue
      }
      break
    }
    if (errexitActs(child, io.exitCode, session)) {
      if (!inline) {
        mergedIo = await exitShell(
          executeFn,
          context,
          io.exitCode,
          stdin,
          callStack,
          allStdout,
          mergedIo,
        )
      }
      break
    }
  }

  const parts = allStdout.filter((part): part is ByteSource => part !== null)
  if (parts.length === 1 && parts[0] !== undefined) {
    return [parts[0], mergedIo, lastExec]
  }
  const combined = parts.length > 0 ? asyncChain(parts) : null
  return [combined, mergedIo, lastExec]
}

/**
 * The first statement after `children[i]` on a later line, where a
 * discarded line resumes. The parse has joined continued lines and folded
 * each heredoc body into its statement, so a newline between two statements
 * is a line break. Mirrors Python's _next_line.
 */
function nextLine(node: TSNodeLike, children: readonly TSNodeLike[], i: number): number {
  const text = node.text
  const base = node.startIndex ?? 0
  let end = children[i]?.endIndex ?? base
  let j = i + 1
  for (; j < children.length; j++) {
    const next = children[j]
    if (next === undefined) continue
    const start = next.startIndex ?? end
    if (text.slice(end - base, start - base).includes('\n')) break
    end = next.endIndex ?? start
  }
  return j
}

/**
 * Settle a signal that unwound out of a statement, or out of the ERR action
 * that answered it. bash's DISCARD resumes the loop at the next line with
 * `$?` at 1. An inline program carries anything else on into
 * its caller, after what it wrote; any other program ends its shell there:
 * `exit`, or an error bash treats as one. Mirrors Python's _unwound.
 */
async function unwound(
  err: Unwinding,
  child: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  sink: JobConsole | null,
  inline: boolean,
  executeFn: ExecuteFn | null,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<[boolean, IOResult, ExecutionNode]> {
  const session = context.session
  if (
    err instanceof DiscardSignal &&
    callStack?.subshell !== true &&
    session.shellOptions.errexit !== true
  ) {
    mergedIo = await land(asWritten(err.stdout, err.stderr), sink, allStdout, mergedIo)
    mergedIo.exitCode = err.exitCode
    recordStatus(session, err.exitCode)
    return [
      true,
      mergedIo,
      new ExecutionNode({ command: getText(child), exitCode: err.exitCode, stderr: err.stderr }),
    ]
  }
  if (inline) {
    const parts = allStdout.filter((part): part is ByteSource => part !== null)
    throw await carried(err, parts.length > 0 ? asyncChain(parts) : null, mergedIo)
  }
  if (err.stdout !== null) allStdout.push(err.stdout)
  const looped = err instanceof BreakSignal || err instanceof ContinueSignal
  const code = looped ? err.io.exitCode : err.exitCode
  mergedIo = await mergedIo.merge(
    new IOResult({ exitCode: code, stderr: looped ? err.io.stderr : err.stderr }),
  )
  mergedIo = await exitShell(executeFn, context, code, stdin, callStack, allStdout, mergedIo)
  recordStatus(session, mergedIo.exitCode)
  return [false, mergedIo, new ExecutionNode({ command: 'exit', exitCode: mergedIo.exitCode })]
}

/**
 * End this shell with `code`, running its EXIT action after what it wrote
 * (`allStdout`, extended in place), and return its result with the status
 * the shell ends with.
 */
async function exitShell(
  executeFn: ExecuteFn | null,
  context: EvaluationContext,
  code: number,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<IOResult> {
  const session = context.session
  const cleanup = await runExitTrap(executeFn, session, code, stdin, callStack)
  if (cleanup === null) {
    mergedIo.exitCode = code
    return mergedIo
  }
  allStdout.push(cleanup.stdout)
  const merged = await mergedIo.merge(new IOResult({ stderr: cleanup.stderr }))
  merged.exitCode = cleanup.exitCode
  return merged
}

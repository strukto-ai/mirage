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

import { CommandTimeoutError } from '../../commands/errors.ts'
import { isControlFlowError } from '../workspace/failure.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { getText } from '../../shell/helpers.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { readFailExitCode } from '../../commands/spec/usage.ts'
import { errorVirtualPath, gnuStrerror } from '../../utils/errors.ts'
import { ReturnSignal } from '../executor/command.ts'
import { BreakSignal, ContinueSignal } from '../executor/control.ts'
import { divertStatement } from '../executor/builtins/exec/index.ts'
import { handleBackground } from '../executor/jobs.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function executeProgram(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable,
  agentId: string,
  // The op door, threaded so an active `exec` redirect can send each
  // statement's output to its file; undefined (a nested loop that is not
  // the program root) leaves output undiverted.
  dispatch?: DispatchFn,
): Promise<Result> {
  // Every program loop is one parse, which is the unit bash's alias rule
  // counts in: an alias defined on this parse and row is not expanded by
  // a use on the same parse and row. Restored on the way out so a nested
  // parse (`eval`, `source`, `bash -c`) does not leave its id behind.
  session.parseSeq += 1
  const outerParse = session.parseCurrent
  session.parseCurrent = session.parseSeq
  try {
    return await runProgram(recurse, node, session, stdin, callStack, jobTable, agentId, dispatch)
  } finally {
    session.parseCurrent = outerParse
  }
}

async function runProgram(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable,
  agentId: string,
  dispatch?: DispatchFn,
): Promise<Result> {
  const children = node.children
  const allStdout: ByteSource[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  // Source lines and the highest one `set -v` has already echoed.
  const sourceLines = getText(node).split('\n')
  let echoedRow = -1

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
      // ERROR nodes that contain only stray statement separators (`& ;`)
      // are filtered out at parse-time by findSyntaxError, so anything
      // reaching here is a recovered fragment we deliberately skip;
      // structural errors would have raised before executeNode ran.
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
        mergedIo = await mergedIo.merge(
          new IOResult({ stderr: new TextEncoder().encode(`${text}\n`) }),
        )
      }
      // Marked read either way: a line reaches the reader once, so
      // a line whose own first statement turned the option on was
      // already past it and is never echoed.
      echoedRow = last
    }

    const next = children[i + 1]
    const isBg = next?.type === NT.BACKGROUND

    let stdout: ByteSource | null
    let io: IOResult
    if (isBg) {
      const [bgStdout, bgIo, bgExec] = await handleBackground(
        recurse,
        child,
        null,
        session,
        jobTable,
        agentId,
        stdin,
        callStack,
      )
      stdout = bgStdout
      io = bgIo
      lastExec = bgExec
      // Launching a job is itself a statement: bash sets $? to 0
      // (the launch status), so `false; cmd & echo $?` prints 0.
      session.lastExitCode = bgIo.exitCode
      i += 2
    } else {
      let s: ByteSource | null
      let ioResult: IOResult
      let execNode: ExecutionNode
      try {
        // `exec < file` feeds the shell's stdin: a later `read` or
        // `while read` sees it. The same bytes reach each statement, and
        // the identity-keyed line buffer advances a sequence of reads
        // through them.
        const childStdin = stdin ?? session.execStdin
        ;[s, ioResult, execNode] = await recurse(child, session, childStdin, callStack)
      } catch (err) {
        if (err instanceof ExitSignal) {
          // exit (or a fatal expansion error) ends the line: keep
          // what earlier statements produced, drop the rest.
          if (err.stdout !== null && err.stdout.byteLength > 0) allStdout.push(err.stdout)
          const sigIo = new IOResult({ exitCode: err.exitCode, stderr: err.stderr })
          mergedIo = await mergedIo.merge(sigIo)
          mergedIo.exitCode = err.exitCode
          session.lastExitCode = err.exitCode
          lastExec = new ExecutionNode({
            command: 'exit',
            exitCode: err.exitCode,
            stderr: err.stderr,
          })
          break
        }
        if (err instanceof ReturnSignal) {
          // `return` inside a sourced file ends the source; the file's
          // status becomes the return's. Anywhere else the signal
          // belongs to an enclosing function call.
          if (session.sourceDepth <= 0) throw err
          if (err.stderr.byteLength > 0) {
            mergedIo = await mergedIo.merge(new IOResult({ stderr: err.stderr }))
          }
          mergedIo.exitCode = err.exitCode
          session.lastExitCode = err.exitCode
          lastExec = new ExecutionNode({ command: 'return', exitCode: err.exitCode })
          break
        }
        if (err instanceof BreakSignal || err instanceof ContinueSignal) {
          // break/continue with a level beyond the loop nesting ends
          // every enclosing loop and execution continues with the next
          // statement, like bash (which clamps the level to the depth).
          if (err.stdout !== null) allStdout.push(err.stdout)
          mergedIo = await mergedIo.merge(err.io)
          session.lastExitCode = err.io.exitCode
          i += 1
          continue
        }
        throw err
      }
      let drainErr: string | null = null
      // Only a filesystem failure reads its code off the command; anything
      // else keeps the catch-all 1, so the two arms below do not share the
      // assignment.
      let drainExit = 1
      try {
        stdout = await materialize(s)
      } catch (err) {
        if (isControlFlowError(err) || err instanceof CommandTimeoutError) throw err
        // Lazy reads can fail on the first pull (e.g. a backend size guard);
        // surface that as a failed statement, not a crash. Filesystem
        // errors format as a GNU coreutils line, respelling the path as
        // typed via the operands the leaf node carries, mirroring the
        // eager executor chokepoint.
        const strerror = gnuStrerror((err as { code?: string }).code)
        if (strerror !== null) {
          const vpath = errorVirtualPath(err)
          const cmdName = execNode.command?.split(' ')[0] ?? ''
          const spelled = execNode.paths.find((p) => p.virtual === vpath)?.rawPath ?? vpath
          drainErr = `${cmdName}: ${spelled}: ${strerror}`
          drainExit = readFailExitCode(cmdName, err)
        } else {
          drainErr = err instanceof Error ? err.message : String(err)
        }
        stdout = null
      }
      if (drainErr !== null) {
        const existing = await materialize(ioResult.stderr)
        const added = new TextEncoder().encode(`${drainErr}\n`)
        const merged = new Uint8Array(existing.byteLength + added.byteLength)
        merged.set(existing, 0)
        merged.set(added, existing.byteLength)
        ioResult.stderr = merged
        ioResult.exitCode = drainExit
        execNode.exitCode = drainExit
      }
      session.lastExitCode = ioResult.exitCode
      io = ioResult
      lastExec = execNode
      i += 1
    }

    // An `exec` redirect sends the shell's own output to a file: every
    // statement after the `exec` diverts here, so nothing bubbles to the
    // terminal and stderr lands in its own target.
    if (dispatch !== undefined && (session.execStdout !== null || session.execStderr !== null)) {
      const bytes = stdout === null ? null : await materialize(stdout)
      stdout = await divertStatement(dispatch, session, bytes, io)
    }
    if (stdout !== null) allStdout.push(stdout)
    mergedIo = await mergedIo.merge(io)

    if (
      io.exitCode !== 0 &&
      session.shellOptions.errexit === true &&
      !isBg &&
      !ERREXIT_EXEMPT_TYPES.has(child.type) &&
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

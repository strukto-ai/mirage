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

import { runWithTimeout } from '../../commands/builtin/utils/safeguard.ts'
import { asyncChain, closeQuietly, mergeStdoutStderr } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { ERREXIT_EXEMPT_TYPES, NodeType as NT } from '../../shell/types.ts'
import type { JobTable } from '../../shell/job_table.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { ExecutionNode } from '../types.ts'
import { type ExecuteNodeFn, handleBackground } from './jobs.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function handlePipe(
  executeNode: ExecuteNodeFn,
  commands: readonly TSNodeLike[],
  stderrFlags: readonly boolean[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let currentStdin: ByteSource | null = stdin
  let lastStdout: ByteSource | null = null
  const childNodes: ExecutionNode[] = []
  const ios: IOResult[] = []
  const intermediate: ByteSource[] = []

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]
      if (cmd === undefined) continue
      let stdout: ByteSource | null
      let io: IOResult
      let childExec: ExecutionNode
      try {
        ;[stdout, io, childExec] = await executeNode(cmd, session, currentStdin, callStack)
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // Each pipeline segment is its own shell in bash: exit
        // (or ${var:?}) ends the segment, not the pipeline.
        stdout = err.stdout
        io = new IOResult({ exitCode: err.containedCode, stderr: err.stderr })
        childExec = new ExecutionNode({
          command: cmd.text,
          exitCode: err.containedCode,
          stderr: err.stderr,
        })
      }
      ios.push(io)
      childNodes.push(childExec)

      if (i < commands.length - 1) {
        const pipeStderr = i < stderrFlags.length && stderrFlags[i] === true
        const piped = pipeStderr ? mergeStdoutStderr(stdout, io) : stdout
        currentStdin = piped ?? new Uint8Array()
        if (!(currentStdin instanceof Uint8Array)) {
          intermediate.push(currentStdin)
        }
      }
      lastStdout = stdout
    }

    if (lastStdout !== null && !(lastStdout instanceof Uint8Array)) {
      lastStdout = await runWithTimeout(
        materialize(lastStdout),
        session.pipelineTimeoutSeconds,
        'pipeline',
      )
    }
  } finally {
    for (const s of intermediate) await closeQuietly(s)
  }

  const lastIo = ios[ios.length - 1] ?? new IOResult()
  lastIo.syncExitCode()
  if (session.shellOptions.pipefail === true) {
    for (const io of ios) io.syncExitCode()
    let rightmostFailure = 0
    for (let k = ios.length - 1; k >= 0; k--) {
      const code = ios[k]?.exitCode ?? 0
      if (code !== 0) {
        rightmostFailure = code
        break
      }
    }
    if (rightmostFailure !== 0) lastIo.exitCode = rightmostFailure
  }
  const mergedStderrParts: Uint8Array[] = []
  const mergedReads: Record<string, ByteSource> = {}
  const mergedWrites: Record<string, ByteSource> = {}
  const mergedCache: string[] = []

  for (let i = 0; i < ios.length; i++) {
    const io = ios[i]
    const child = childNodes[i]
    if (io === undefined || child === undefined) continue
    io.syncExitCode()
    child.exitCode = io.exitCode
    const stderrBytes = await materialize(io.stderr)
    if (stderrBytes.byteLength > 0) mergedStderrParts.push(stderrBytes)
    Object.assign(mergedReads, io.reads)
    Object.assign(mergedWrites, io.writes)
    mergedCache.push(...io.cache)
  }

  if (mergedStderrParts.length > 0) {
    lastIo.stderr = concat(mergedStderrParts)
  }
  lastIo.reads = mergedReads
  lastIo.writes = mergedWrites
  lastIo.cache = mergedCache

  const execNode = new ExecutionNode({
    op: '|',
    exitCode: lastIo.exitCode,
    children: childNodes,
  })
  return [lastStdout, lastIo, execNode]
}

async function mergeLeftIntoExit(
  sig: ExitSignal,
  leftBytes: ByteSource | null,
  leftIo: IOResult,
): Promise<ExitSignal> {
  // Fold the left side's completed output into a propagating exit.
  const leftStderr = await materialize(leftIo.stderr)
  const left = await materialize(leftBytes)
  sig.stdout = concat([left, sig.stdout ?? new Uint8Array()])
  sig.stderr = concat([leftStderr, sig.stderr])
  return sig
}

export async function handleConnection(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  op: string | null,
  right: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const [leftStdout, leftIo, leftExec] = await executeNode(left, session, stdin, callStack)
  const children = [leftExec]

  if (op === NT.AND) {
    const leftBytes = await applyBarrier(leftStdout, leftIo, BarrierPolicy.VALUE)
    session.lastExitCode = leftIo.exitCode
    if (leftIo.exitCode !== 0) {
      // The failing command is left of the final `&&`, which bash
      // exempts from `set -e`.
      session.errexitImmune = true
      return [
        leftBytes,
        leftIo,
        new ExecutionNode({ op: '&&', exitCode: leftIo.exitCode, children }),
      ]
    }
    let rightStdout: ByteSource | null
    let rightIo: IOResult
    let rightExec: ExecutionNode
    try {
      ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
    } catch (err) {
      if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
      throw err
    }
    children.push(rightExec)
    const rightBytes = await materialize(rightStdout)
    const merged = await leftIo.merge(rightIo)
    const combined = asyncChain(leftBytes, rightBytes)
    return [combined, merged, new ExecutionNode({ op: '&&', exitCode: merged.exitCode, children })]
  }

  if (op === NT.OR) {
    const leftBytes = await applyBarrier(leftStdout, leftIo, BarrierPolicy.VALUE)
    session.lastExitCode = leftIo.exitCode
    if (leftIo.exitCode === 0) {
      return [
        leftBytes,
        leftIo,
        new ExecutionNode({ op: '||', exitCode: leftIo.exitCode, children }),
      ]
    }
    let rightStdout: ByteSource | null
    let rightIo: IOResult
    let rightExec: ExecutionNode
    try {
      ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
    } catch (err) {
      if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
      throw err
    }
    children.push(rightExec)
    const rightBytes = await materialize(rightStdout)
    const merged = await leftIo.merge(rightIo)
    const combined = asyncChain(leftBytes, rightBytes)
    return [combined, merged, new ExecutionNode({ op: '||', exitCode: merged.exitCode, children })]
  }

  // ; (semicolon) or other: run both regardless
  const leftBytes = await applyBarrier(leftStdout, leftIo, BarrierPolicy.VALUE)
  session.lastExitCode = leftIo.exitCode
  let rightStdout: ByteSource | null
  let rightIo: IOResult
  let rightExec: ExecutionNode
  try {
    ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
  } catch (err) {
    if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
    throw err
  }
  children.push(rightExec)
  const rightBytes = await materialize(rightStdout)
  const merged = await leftIo.merge(rightIo)
  const combined = asyncChain(leftBytes, rightBytes)
  return [
    combined,
    merged,
    new ExecutionNode({ op: op ?? ';', exitCode: merged.exitCode, children }),
  ]
}

/**
 * Execute body in isolated env.
 *
 * `body` is ALL subshell children, including the `&` tokens that mark
 * background statements (named-only lists would run `a & b`
 * synchronously and never set `$!`). Background jobs live in the
 * subshell's private `jobTable` (bash forks: the parent's table never
 * sees them), and `executeNode` is bound to that same table so
 * `wait`/`kill`/`jobs` inside the body resolve against it.
 */
export async function handleSubshell(
  executeNode: ExecuteNodeFn,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
): Promise<Result> {
  const savedCwd = session.cwd
  const savedEnv = { ...session.env }
  const savedOptions = { ...session.shellOptions }
  const savedReadonly = new Set(session.readonlyVars)
  const savedArrays: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(session.arrays)) savedArrays[k] = [...v]
  const savedFunctions = { ...session.functions }
  const savedPositional = [...session.positionalArgs]
  const savedLastBgJob = session.lastBgJobId
  const savedGetoptsPos = session.getoptsPos
  const savedGetoptsOptind = session.getoptsOptind
  try {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '()', exitCode: 0 })
    let i = 0
    while (i < body.length) {
      const child = body[i]
      if (child?.isNamed !== true || child.type === NT.COMMENT) {
        i += 1
        continue
      }
      const isBg = body[i + 1]?.type === NT.BACKGROUND
      if (isBg && jobTable !== null) {
        const [bgStdout, bgIo, bgExec] = await handleBackground(
          executeNode,
          child,
          null,
          session,
          jobTable,
          agentId ?? '',
          stdin,
          callStack,
        )
        if (bgStdout !== null) allStdout.push(bgStdout)
        mergedIo = await mergedIo.merge(bgIo)
        lastExec = bgExec
        i += 2
        continue
      }
      i += 1
      let stdout: ByteSource | null
      let io: IOResult
      let childExec: ExecutionNode
      try {
        ;[stdout, io, childExec] = await executeNode(child, session, stdin, callStack)
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // A subshell is its own shell: exit (or ${var:?}) ends the
        // subshell only, becoming its exit status.
        if (err.stdout !== null && err.stdout.byteLength > 0) allStdout.push(err.stdout)
        const sigIo = new IOResult({ exitCode: err.containedCode, stderr: err.stderr })
        mergedIo = await mergedIo.merge(sigIo)
        mergedIo.exitCode = err.containedCode
        lastExec = new ExecutionNode({
          command: '()',
          exitCode: err.containedCode,
          stderr: err.stderr,
        })
        break
      }
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      lastExec = childExec
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
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
  } finally {
    session.cwd = savedCwd
    session.env = savedEnv
    session.shellOptions = savedOptions
    session.readonlyVars = savedReadonly
    session.arrays = savedArrays
    session.functions = savedFunctions
    session.positionalArgs = savedPositional
    session.lastBgJobId = savedLastBgJob
    session.getoptsPos = savedGetoptsPos
    session.getoptsOptind = savedGetoptsOptind
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

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

import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { ERREXIT_EXEMPT_TYPES, NodeType as NT } from '../../shell/types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { errorVirtualPath, gnuStrerror } from '../../utils/errors.ts'
import { handleBackground } from '../executor/jobs.ts'
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
  jobTable: JobTable | null,
  agentId: string,
): Promise<Result> {
  const children = node.children
  const allStdout: ByteSource[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })

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
      i += 2
    } else {
      let s: ByteSource | null
      let ioResult: IOResult
      let execNode: ExecutionNode
      try {
        ;[s, ioResult, execNode] = await recurse(child, session, stdin, callStack)
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
        throw err
      }
      let drainErr: string | null = null
      try {
        stdout = await materialize(s)
      } catch (err) {
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
        } else {
          drainErr = err instanceof Error ? err.message : String(err)
        }
        stdout = null
      }
      ioResult.syncExitCode()
      if (drainErr !== null) {
        const existing = await materialize(ioResult.stderr)
        const added = new TextEncoder().encode(`${drainErr}\n`)
        const merged = new Uint8Array(existing.byteLength + added.byteLength)
        merged.set(existing, 0)
        merged.set(added, existing.byteLength)
        ioResult.stderr = merged
        ioResult.exitCode = 1
        execNode.exitCode = 1
      }
      session.lastExitCode = ioResult.exitCode
      io = ioResult
      lastExec = execNode
      i += 1
    }

    if (stdout !== null) allStdout.push(stdout)
    mergedIo = await mergedIo.merge(io)

    if (
      io.exitCode !== 0 &&
      session.shellOptions.errexit === true &&
      !isBg &&
      !ERREXIT_EXEMPT_TYPES.has(child.type)
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

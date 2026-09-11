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

import type { ShellVar } from '../../../shell/variable.ts'
import type { ByteSource } from '../../../io/types.ts'
import { IOResult } from '../../../io/types.ts'
import { finishStatement } from '../statement.ts'
import { CallStack } from '../../../shell/call_stack.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../../shell/constants.ts'
import type { PathSpec } from '../../../types.ts'
import { wordText } from '../../../types.ts'
import type { Session } from '../../session/session.ts'
import { restoreLocals } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { asyncChain } from '../../../io/stream.ts'
import type { ExecuteNodeFn } from '../jobs.ts'

import { ReturnSignal } from '../control.ts'
import type { Result } from './types.ts'

export async function executeShellFunction(
  executeNode: ExecuteNodeFn,
  cmdName: string,
  body: unknown[],
  restParts: readonly (string | PathSpec)[],
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  const cs = callStack ?? new CallStack()
  // Positional args carry the word as typed ($1 stays sub/a.txt).
  const textArgs = restParts.map(wordText)
  cs.push(textArgs, cmdName)
  // One stack: a local shadows the whole record, so the caller's value
  // and attributes are saved and put back together.
  const savedLocals = new Map<string, ShellVar | null>()
  // The caller's frame is kept and put back: a function that calls
  // another and then declares a `local` is still inside a function, and
  // its own shadows must keep being recorded on its own frame.
  const outerLocals = session.localVars
  session.localVars = savedLocals
  session.localFrames.push(savedLocals)
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: cmdName, exitCode: 0 })

  try {
    for (const cmd of body) {
      try {
        const cmdNode = cmd as Parameters<ExecuteNodeFn>[0]
        const [rawStdout, io, execNode] = await executeNode(cmdNode, session, stdin, cs)
        // $? tracks each statement inside the body, so a bare `return`
        // (and mid-function $?) sees the last command.
        const stdout = await finishStatement(rawStdout, io, session, cmdNode)
        if (stdout !== null) allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
        lastExec = execNode
        if (
          io.exitCode !== 0 &&
          session.shellOptions.errexit === true &&
          !ERREXIT_EXEMPT_TYPES.has(cmdNode.type) &&
          !session.errexitImmune
        ) {
          mergedIo.exitCode = io.exitCode
          break
        }
      } catch (err) {
        if (err instanceof ReturnSignal) {
          if (err.stderr.length > 0) {
            mergedIo = await mergedIo.merge(new IOResult({ stderr: err.stderr }))
          }
          mergedIo.exitCode = err.exitCode
          break
        }
        throw err
      }
    }
  } finally {
    cs.pop()
    restoreLocals(session, savedLocals)
    session.localFrames.pop()
    session.localVars = outerLocals
  }

  const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
  lastExec.exitCode = mergedIo.exitCode
  return [combined, mergedIo, lastExec]
}

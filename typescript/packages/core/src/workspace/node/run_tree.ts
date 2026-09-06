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
import { guardOutput } from '../../commands/builtin/utils/limit.ts'
import { postExecuteGate, refusalOf, renderDeny } from '../../policy/index.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecutionNode } from '../types.ts'
import { executeNode, type ExecuteNodeDeps } from './execute_node.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function runCommandTree(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
): Promise<Result> {
  const [stdout, io, execNode] = await executeNode(deps, node, session, stdin, null)
  let materialized: ByteSource | null
  try {
    materialized = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  } catch (err) {
    if (isControlFlowError(err) || err instanceof CommandTimeoutError) throw err
    // Lazy reads can fail on the first pull (e.g. a backend size guard);
    // surface that as a failed command, not a crash.
    const msg = err instanceof Error ? err.message : String(err)
    const existing = await materialize(io.stderr)
    const added = new TextEncoder().encode(`${msg}\n`)
    const merged = new Uint8Array(existing.byteLength + added.byteLength)
    merged.set(existing, 0)
    merged.set(added, existing.byteLength)
    io.stderr = merged
    io.exitCode = 1
    materialized = null
    execNode.exitCode = 1
    return [materialized, io, execNode]
  }
  // The boundary consultation: the envelope's producer facts become
  // the postExecute context; the built-in cap and any user policies
  // answer with Limits (tightest merged), enforced by guardOutput.
  const producer = io.producer ?? { command: '', prefixes: [], declared: null }
  const [deny, bound] = await postExecuteGate(deps.registry.policies, {
    producer,
    exitCode: io.exitCode,
  })
  if (deny !== null) {
    const existingErr = await materialize(io.stderr)
    const [denyBytes, exitCode] = renderDeny(producer.command || 'line', deny)
    const mergedErr = new Uint8Array(existingErr.byteLength + denyBytes.byteLength)
    mergedErr.set(existingErr, 0)
    mergedErr.set(denyBytes, existingErr.byteLength)
    io.stderr = mergedErr
    io.exitCode = exitCode
    io.refusal = refusalOf(deny)
    execNode.exitCode = io.exitCode
    return [null, io, execNode]
  }
  const [guarded, guardedErr, guardedCode] = await guardOutput(
    materialized,
    io.stderr,
    io.exitCode,
    bound,
  )
  materialized = guarded !== null ? await materialize(guarded) : null
  io.stderr = guardedErr
  io.exitCode = guardedCode
  return [materialized, io, execNode]
}

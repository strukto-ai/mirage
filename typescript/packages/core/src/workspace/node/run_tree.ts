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

import { guardOutput } from '../../commands/builtin/utils/safeguard.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../expand/variable.ts'
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
  io.syncExitCode()
  const [guarded, guardedErr, guardedCode] = await guardOutput(
    materialized,
    io.stderr,
    io.exitCode,
    io.safeguard,
  )
  materialized = guarded !== null ? await materialize(guarded) : null
  io.stderr = guardedErr
  io.exitCode = guardedCode
  return [materialized, io, execNode]
}

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
import { runWithAdmission } from '../../context/session_context.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import { isControlFlowError } from '../workspace/failure.ts'
import { guardOutput } from '../../commands/builtin/utils/limit.ts'
import { postExecuteGate, refusalOf, renderDeny } from '../../policy/index.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { Terminal } from '../../shell/console/index.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { inputSubstitutionRedirect } from '../../shell/helpers.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { toScope } from '../executor/builtins/scope.ts'
import { handleRedirect } from '../executor/redirect.ts'
import { sessionView } from '../session/state.ts'

import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'
import { Admitted, admit } from './admission.ts'
import { claimantFor } from './occurrence.ts'
import { PathSpec } from '../../types.ts'
import { executeNode, type ExecuteNodeDeps } from './execute_node.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function runCommandTree(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  commandSubstitution = false,
  // The frames of the caller the tree runs in place of (`eval`), null for
  // a line of its own.
  callStack: CallStack | null = null,
): Promise<Result> {
  const session = context.session
  const redirect = commandSubstitution ? inputSubstitutionRedirect(node) : null
  let result: Result
  if (redirect === null) {
    result = await executeNode(deps, node, context, stdin, callStack)
  } else {
    const [redirects] = await expandRedirects(
      [redirect],
      context,
      deps.executeFn,
      deps.registry,
      null,
      sessionView(session, deps.registry.policies, context.frame.diagnostics),
    )
    // Bash's implicit read uses cat's policy identity without invoking
    // a shadowing function/alias or expanding the filename a second time.
    const target = redirects[0]?.target
    const paths =
      target instanceof PathSpec ? [target] : typeof target === 'string' ? [toScope(target)] : []
    const verdict = await admit(
      'cat',
      [],
      [],
      context.session,
      deps.registry,
      deps.namespace,
      deps.agentId,
      null,
      paths,
      deps.signal,
      claimantFor(node, deps.handed),
      true,
    )
    if (!(verdict instanceof Admitted)) {
      result = [
        null,
        new IOResult({
          exitCode: verdict.exitCode,
          stderr: verdict.stderr,
          refusal: verdict.refusal,
        }),
        new ExecutionNode({
          command: 'cat',
          exitCode: verdict.exitCode,
          stderr: verdict.stderr,
          refused: true,
        }),
      ]
    } else {
      result = await runWithAdmission(verdict, () =>
        handleRedirect(
          (inner, current, input, stack) => executeNode(deps, inner, current, input, stack),
          deps.dispatch,
          null,
          redirects,
          context,
          stdin,
          null,
          true,
        ),
      )
    }
  }
  const [stdout, io, execNode] = result
  let materialized: ByteSource | null
  try {
    materialized = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  } catch (err) {
    if (isControlFlowError(err) || err instanceof CommandTimeoutError) throw err
    // Lazy reads can fail on the first pull (e.g. a backend size guard);
    // surface that as a failed command, not a crash.
    const msg = err instanceof Error ? err.message : String(err)
    const existing = await materialize(io.stderr)
    const added = encodeText(`${msg}\n`)
    const merged = new Uint8Array(existing.byteLength + added.byteLength)
    merged.set(existing, 0)
    merged.set(added, existing.byteLength)
    io.stderr = merged
    io.exitCode = 1
    materialized = null
    execNode.exitCode = 1
    return [materialized, io, execNode]
  }
  // A line written to a terminal (a typed line's, a substitution's) is
  // bounded as what reached it, its jobs' output included, and what the
  // bound leaves goes back ahead of anything later.
  const screen = deps.sink instanceof Terminal && deps.sink.reader === null ? deps.sink : null
  if (screen !== null) {
    const [out, err] = screen.drain()
    materialized = concat([out, await materialize(materialized)])
    const stderr = concat([err, await materialize(io.stderr)])
    io.stderr = stderr.byteLength > 0 ? stderr : null
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
    if (screen !== null) {
      screen.putBack(new Uint8Array(), mergedErr)
      io.stderr = null
    }
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
  if (screen !== null) {
    screen.putBack(materialized ?? new Uint8Array(), await materialize(io.stderr))
    materialized = null
    io.stderr = null
  }
  return [materialized, io, execNode]
}

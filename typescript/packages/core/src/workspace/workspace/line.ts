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

import { Limit } from '../../types.ts'
import { runOutput } from '../../commands/builtin/general/interpreter.ts'
import { guardIO, guardOutput, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import type { Context } from '../../commands/config.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { LineExecutor } from '../../runtime/mixin.ts'
import type { OutputFn, RunResult } from '../../runtime/types.ts'
import type { RouteContext } from '../../policy/types.ts'
import {
  type Claimant,
  postExecuteGate,
  refusalOf,
  renderDeny,
  resolveLimit,
} from '../../policy/index.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { pump } from '../executor/jobs.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { commandName } from './utils.ts'
import { ExecutionNode } from '../types.ts'
import { makeAbortError } from '../../utils/abort.ts'
import { concat } from '../../utils/bytes.ts'
import { isControlFlowError } from './failure.ts'
import { PathSpec, type Refusal } from '../../types.ts'
import { encodeText } from '../../shell/bytes.ts'

/**
 * What a whole line answers: the runtime's own result plus the
 * refusal record when the boundary's post_execute gate refused it.
 */
export interface LineResult extends RunResult {
  refusal: Refusal | null
}

/**
 * Hand the raw line to one runtime instead of walking its tree.
 * Mirrors the Python `run_whole_line` in `workspace/line.py`.
 *
 * A whole line is a command like any other: the same limit
 * resolution and boundary rule as the tree, so `timeoutSeconds` answers
 * 124 and `maxBytes`/`maxLines` cap the output. `registry` holds the
 * workspace's mounts, every one of which the line may span (a whole-line
 * runtime sees the full workspace), its policies and its command
 * defaults; it settles the line when it ends (`MountRegistry.settle`).
 * Its output is handed over as the runtime writes it (`runOutput`): into
 * `sink` as it comes, unless a `postExecute` policy must see it whole
 * before any of it escapes, and back in the result without one.
 */
export async function runWholeLine(
  runtime: Runtime & LineExecutor,
  command: string,
  stdin: ByteSource | null,
  session: SessionState,
  registry: MountRegistry,
  signal?: AbortSignal,
  claimant: Claimant | null = null,
  // What `preExecute` saw of the line, which `postExecute` sees with what
  // came back; null when no policy reads `postExecute`.
  route: RouteContext | null = null,
  // Where the line writes; absent returns its output in the result.
  sink?: JobConsole,
): Promise<LineResult> {
  const name = commandName(command)
  const mounts = registry.allMounts()
  const guard = resolveLimit(
    name,
    mounts,
    null,
    null,
    registry.commandLimits,
    session.commandLimits,
  )
  const timeout = guard?.timeoutSeconds ?? null
  const ctx: Context = {
    flags: { c: command },
    stdin,
    env: envSnapshot(session),
    cwd: PathSpec.fromStrPath(session.cwd),
  }
  const run = async (output: OutputFn, errors: OutputFn, stop: AbortSignal): Promise<RunResult> => {
    const deadline = new AbortController()
    try {
      return await runWithTimeout(
        runtime.execute(
          [],
          [],
          { ...ctx, signal: AbortSignal.any([stop, deadline.signal]) },
          { kind: 'line', output, errors },
        ),
        timeout,
        name,
      )
    } catch (err) {
      // A run past its deadline is stopped before its runtime settles,
      // which may wait for the run.
      if (err instanceof CommandTimeoutError) deadline.abort()
      throw err
    } finally {
      await registry.settle(runtime)
    }
  }
  const producer = { command: name, prefixes: mounts.map((m) => m.prefix), declared: null }
  const shown = route === null ? sink : undefined
  const [stdout, io] = runOutput(
    run,
    producer,
    shown === undefined ? undefined : (chunk) => shown.emit(Channel.STDERR, chunk),
    stdin,
    signal,
  )
  let data: Uint8Array = new Uint8Array()
  try {
    if (route === null) {
      const out = guardIO(stdout, io, session.terminalOutput ? guard : null)
      if (shown === undefined) data = await materialize(out)
      else await pump(shown, Channel.STDOUT, out)
    } else {
      data = await materialize(stdout)
    }
  } catch (err) {
    if (signal?.aborted) throw makeAbortError()
    if (isControlFlowError(err)) throw err
    // A failed run is still a result, which post_execute sees.
    data = new Uint8Array()
    if (err instanceof CommandTimeoutError) {
      io.stderr = encodeText(`${err.message}\n`)
      io.exitCode = 124
    } else {
      io.stderr = encodeText(err instanceof Error ? err.message : String(err))
      io.exitCode = 1
    }
  }
  const stderr = await io.materializeStderr()
  if (route === null) {
    return {
      stdout: data,
      stderr: stderr.length > 0 ? stderr : null,
      exitCode: io.exitCode,
      refusal: null,
    }
  }
  const [refused, bound] = await postExecuteGate(
    registry.policies,
    {
      ...route,
      producer,
      exitCode: io.exitCode,
      output: data,
      results: new ExecutionNode({ command, stderr, exitCode: io.exitCode }).toDict(),
    },
    claimant,
    signal,
  )
  if (refused !== null) {
    const [denyBytes, exitCode] = renderDeny(name, refused)
    return {
      stdout: new Uint8Array(),
      stderr: concat([stderr, denyBytes]),
      exitCode,
      refusal: refusalOf(refused),
    }
  }
  const [capped, cappedErr, cappedCode] = await guardOutput(
    data,
    stderr.length > 0 ? stderr : null,
    io.exitCode,
    Limit.aggr([session.terminalOutput ? guard : null, bound]),
  )
  return {
    stdout: capped !== null ? await materialize(capped) : new Uint8Array(),
    stderr: cappedErr !== null ? await materialize(cappedErr) : null,
    exitCode: cappedCode,
    refusal: null,
  }
}

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

import { guardOutput, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import type { ByteSource } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { LineExecutor } from '../../runtime/mixin.ts'
import type { RunResult } from '../../runtime/types.ts'
import {
  type Policies,
  postExecuteGate,
  refusalOf,
  renderDeny,
  resolveLimit,
} from '../../policy/index.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { Session } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { commandName } from './utils.ts'
import type { Refusal } from '../../types.ts'

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
 * 124 and `maxBytes`/`maxLines` cap the output. `invalidate` drops
 * local read caches once the line has run: it may have written
 * anywhere in the runtime's view of the workspace.
 */
export async function runWholeLine(
  runtime: Runtime & LineExecutor,
  command: string,
  stdin: ByteSource | null,
  session: Session,
  mounts: readonly MountEntry[],
  policies: Policies,
  invalidate: () => Promise<void>,
): Promise<LineResult> {
  const data = stdin !== null ? await materialize(stdin) : null
  const name = commandName(command)
  const guard = resolveLimit(name, mounts)
  let result: RunResult
  try {
    result = await runWithTimeout(
      runtime.runLine(command, data, envSnapshot(session), session.cwd),
      guard?.timeoutSeconds ?? null,
      name,
    )
  } catch (err) {
    if (err instanceof CommandTimeoutError) {
      result = {
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(`${err.message}\n`),
        exitCode: 124,
      }
    } else {
      result = {
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(err instanceof Error ? err.message : String(err)),
        exitCode: 1,
      }
    }
  } finally {
    await invalidate()
  }
  const [deny, bound] = await postExecuteGate(policies, {
    producer: { command: name, prefixes: mounts.map((m) => m.prefix), declared: null },
    exitCode: result.exitCode,
  })
  if (deny !== null) {
    const [denyBytes, exitCode] = renderDeny(name, deny)
    const priorErr = result.stderr !== null ? await materialize(result.stderr) : new Uint8Array()
    const mergedErr = new Uint8Array(priorErr.byteLength + denyBytes.byteLength)
    mergedErr.set(priorErr, 0)
    mergedErr.set(denyBytes, priorErr.byteLength)
    return { stdout: new Uint8Array(), stderr: mergedErr, exitCode, refusal: refusalOf(deny) }
  }
  const [capped, cappedErr, cappedCode] = await guardOutput(
    result.stdout,
    result.stderr,
    result.exitCode,
    bound,
  )
  return {
    stdout: capped !== null ? await materialize(capped) : new Uint8Array(),
    stderr: cappedErr !== null ? await materialize(cappedErr) : null,
    exitCode: cappedCode,
    refusal: null,
  }
}

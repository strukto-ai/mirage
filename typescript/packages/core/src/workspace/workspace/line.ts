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

import {
  CommandTimeoutError,
  guardOutput,
  runWithTimeout,
} from '../../commands/builtin/utils/safeguard.ts'
import type { ByteSource } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import type { Runtime } from '../executor/runtime.ts'
import type { RunResult } from '../executor/runtime_types.ts'
import { resolveSafeguard } from '../executor/policy/safeguard.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { Session } from '../session/session.ts'
import { commandName } from './utils.ts'

/**
 * Hand the raw line to one runtime instead of walking its tree.
 * Mirrors the Python `run_whole_line` in `workspace/line.py`.
 *
 * A whole line is a command like any other: the same safeguard
 * resolution and boundary rule as the tree, so `timeoutSeconds` answers
 * 124 and `maxBytes`/`maxLines` cap the output. `invalidate` drops
 * local read caches once the line has run: it may have written
 * anywhere in the runtime's view of the workspace.
 */
export async function runWholeLine(
  runtime: Runtime & { runLine: NonNullable<Runtime['runLine']> },
  command: string,
  stdin: ByteSource | null,
  session: Session,
  mounts: readonly MountEntry[],
  invalidate: () => Promise<void>,
): Promise<RunResult> {
  const data = stdin !== null ? await materialize(stdin) : null
  const name = commandName(command)
  const guard = resolveSafeguard(name, mounts)
  let result: RunResult
  try {
    result = await runWithTimeout(
      runtime.runLine(command, data, { ...session.env }, session.cwd),
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
  const [capped, cappedErr, cappedCode] = await guardOutput(
    result.stdout,
    result.stderr,
    result.exitCode,
    guard,
  )
  return {
    stdout: capped !== null ? await materialize(capped) : new Uint8Array(),
    stderr: cappedErr !== null ? await materialize(cappedErr) : null,
    exitCode: cappedCode,
  }
}

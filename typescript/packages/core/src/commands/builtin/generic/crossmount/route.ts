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

import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { errorVirtualPath, gnuStrerror } from '../../../../utils/errors.ts'
import { strategyFor } from './detect.ts'
import { runFanout } from './fanout/index.ts'
import { Strategy, type Cmd, type CrossResult, type DispatchFn, type RunSingle } from './types.ts'
import { runRelay } from './relay/index.ts'
import { runStream } from './stream/index.ts'

// Run a command whose path operands span mounts. Every command combines
// per-mount work under one of three strategies (see Strategy): STREAM merges
// raw per-operand bytes and runs the command once on the merged stream,
// FANOUT runs the command natively once per operand and combines the
// outputs, RELAY moves per-file data through the dispatcher into one shared
// generic. STREAM and FANOUT execute through `runSingle`, so each mount
// expands its own glob operands and uses its own native command
// implementation.
export async function handleCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  try {
    // isCrossMount gated on CROSS_MOUNT_COMMANDS membership, so the name is
    // one of the Cmd values by the time it reaches the strategy layer.
    const cmd = cmdName as Cmd
    const strategy = strategyFor(cmd, flagKwargs)
    if (strategy === Strategy.RELAY) {
      return await runRelay(cmd, scopes, flagKwargs, dispatch)
    }
    if (strategy === Strategy.STREAM) {
      return await runStream(cmd, scopes, textArgs, flagKwargs, runSingle)
    }
    return await runFanout(cmd, scopes, textArgs, flagKwargs, runSingle, stdin)
  } catch (err) {
    const strerror = gnuStrerror((err as { code?: string }).code)
    const vpath = errorVirtualPath(err)
    const display = scopes.find((p) => p.virtual === vpath)?.rawPath ?? vpath
    const line =
      strerror !== null
        ? `${cmdName}: ${display}: ${strerror}\n`
        : `${cmdName}: ${err instanceof Error ? err.message : String(err)}\n`
    return [null, new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(line) })]
  }
}

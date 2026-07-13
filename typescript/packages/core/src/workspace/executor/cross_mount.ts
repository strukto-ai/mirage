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
  handleCrossMount as routeCrossMount,
  type DispatchFn,
  type RunSingle,
} from '../../commands/builtin/generic/crossmount/index.ts'
import { materialize, type ByteSource, type IOResult } from '../../io/types.ts'
import type { PathSpec } from '../../types.ts'
import { ExecutionNode } from '../types.ts'

export { isCrossMount } from '../../commands/builtin/generic/crossmount/index.ts'
export type { DispatchFn } from '../../commands/builtin/generic/crossmount/index.ts'

type Flags = Record<string, string | boolean | string[]>
type Result = [ByteSource | null, IOResult, ExecutionNode]

// Workspace-level adapter over the generic crossmount router: run the command
// via the strategy runners (STREAM/FANOUT through the injected single-mount
// runner, RELAY through dispatch), then build the recorded execution node
// (with materialized stderr) the executor expects.
export async function handleCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flags: Flags,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  stdin: ByteSource | null,
  cmdStr: string,
): Promise<Result> {
  const [stdout, io] = await routeCrossMount(
    cmdName,
    scopes,
    textArgs,
    flags,
    dispatch,
    runSingle,
    stdin,
  )
  const stderrBytes = await materialize(io.stderr)
  const exec = new ExecutionNode({ command: cmdStr, stderr: stderrBytes, exitCode: io.exitCode })
  return [stdout, io, exec]
}

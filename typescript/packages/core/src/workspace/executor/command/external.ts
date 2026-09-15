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

import { CommandTimeoutError } from '../../../commands/errors.ts'
import { mergeSignals } from '../../abort.ts'
import { runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import { resolveLimit } from '../../../policy/index.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { isProcessExecutor } from '../../../runtime/mixin.ts'
import type { RouteDecision } from '../../../runtime/routing/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import { PathSpec } from '../../../types.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'

/** Execute one admitted program; its surrounding shell stays in Mirage. */
export async function runExternal(
  argv: Argv,
  stdin: ByteSource | null,
  session: Session,
  registry: MountRegistry,
  routing?: RouteDecision,
  signal?: AbortSignal,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const key =
    routing === undefined
      ? registry.runtimeEntries.some((entry) => entry.captures.includes(argv.name))
        ? argv.name
        : EXTERNAL_COMMANDS
      : Object.hasOwn(routing.bindings, argv.name)
        ? argv.name
        : EXTERNAL_COMMANDS
  const runtime =
    routing === undefined
      ? registry.runtimeEntries.find((entry) => entry.captures.includes(key))
      : routing.bindings[key]
  const command = shellJoin(argv.tokens)
  if (runtime == null) {
    const stderr = new TextEncoder().encode(`${argv.name}: no runtime accepted this line\n`)
    return [
      null,
      new IOResult({ exitCode: 126, stderr }),
      new ExecutionNode({ command, exitCode: 126, stderr }),
    ]
  }
  const guard = resolveLimit(argv.name, registry.allMounts())
  const timeout = guard?.timeoutSeconds ?? null
  const deadline = timeout !== null && timeout > 0 ? new AbortController() : null
  const runSignal = mergeSignals(signal, deadline?.signal)
  const execute = async () => {
    const input = stdin === null ? null : await materialize(stdin)
    runSignal?.throwIfAborted()
    const common = {
      cwd: PathSpec.fromStrPath(session.cwd),
      env: envSnapshot(session),
      stdin: input,
      ...(runSignal !== undefined ? { signal: runSignal } : {}),
    }
    return runtime.execute(
      isProcessExecutor(runtime)
        ? { kind: 'process', argv: argv.tokens, ...common }
        : { kind: 'shell', line: command, ...common },
    )
  }
  try {
    const result = await runWithTimeout(execute(), timeout, argv.name)
    return [
      result.stdout,
      new IOResult({
        exitCode: result.exitCode,
        stderr: result.stderr,
        producer: {
          command: argv.name,
          declared: null,
          prefixes: registry.allMounts().map((mount) => mount.prefix),
        },
      }),
      new ExecutionNode({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr ?? new Uint8Array(),
      }),
    ]
  } catch (err) {
    if (err instanceof CommandTimeoutError) deadline?.abort()
    throw err
  } finally {
    await registry.invalidateAfterExternal()
  }
}

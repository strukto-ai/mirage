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

import { isStdin, resolveSource } from '../../utils/stream.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { NamespaceView, SessionView } from '../../../../ops/types.ts'
import { formatFsError, isFsError } from '../../../../utils/errors.ts'
import { strategyFor } from './detect.ts'
import { runFanout } from './fanout/index.ts'
import type { AggregateFn } from '../../../config.ts'
import { runOperands, mergeOperandIos } from './utils.ts'
import { Strategy, type Cmd, type CrossResult, type DispatchFn, type RunSingle } from './types.ts'
import { runRelay } from './relay/index.ts'
import { runStream } from './stream/index.ts'
import { runSearch } from './search.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { readFailExitCode } from '../../../spec/usage.ts'
import { UsageError } from '../../../errors.ts'
import { encodeText } from '../../../../shell/bytes.ts'

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
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  stdin: ByteSource | null = null,
  // Maps an operand to its storage identity (RELAY's transfer commands).
  storageKey?: (path: PathSpec) => string,
  // Name-plane facts for the RELAY generics that render them (ls).
  ns?: NamespaceView,
  // The session plane's door, for the RELAY generic that renders the
  // session's profile (ls).
  sessionView?: SessionView,
  // The session's working directory, which a typed operand resolves against
  // (cp's link sources).
  cwd = '/',
  argv: readonly string[] = [],
  aggregate: AggregateFn | null = null,
): Promise<CrossResult> {
  const native = runSingle
  const input = resolveSource(stdin)
  runSingle = (name, paths, texts, flags, options) =>
    native(name, paths, texts, flags, {
      ...options,
      stdin: paths.some((p) => isStdin(p)) ? input : (options?.stdin ?? null),
    })
  try {
    if (aggregate !== null) {
      const results = await runOperands(runSingle, cmdName, scopes, textArgs, flagKwargs)
      const body = aggregate(results.map((r) => [r.scope.virtual, r.data]))
      return [
        body,
        await mergeOperandIos(results, Math.max(0, ...results.map((r) => r.io.exitCode))),
      ]
    }
    if (cmdName === 'grep' || cmdName === 'rg') {
      return await runSearch(
        cmdName,
        scopes,
        textArgs,
        flagKwargs,
        dispatch,
        runSingle,
        cwd,
        ns,
        input,
      )
    }
    const cmd = cmdName as Cmd
    const strategy = strategyFor(cmd)
    if (strategy === Strategy.RELAY) {
      return await runRelay(
        cmd,
        scopes,
        textArgs,
        flagKwargs,
        dispatch,
        runSingle,
        storageKey,
        ns,
        sessionView,
        stdin,
        cwd,
        argv,
      )
    }
    if (strategy === Strategy.STREAM) {
      return await runStream(cmd, scopes, textArgs, flagKwargs, runSingle)
    }
    return await runFanout(cmd, scopes, textArgs, flagKwargs, runSingle)
  } catch (err) {
    // The command's own usage refusal (cmp's bad skip, an extra operand) is
    // its result, and the rest of the line runs, as the single-mount path
    // answers it.
    if (err instanceof UsageError) {
      return [
        null,
        new IOResult({
          exitCode: err.exitCode,
          stderr: encodeText(`${err.message}\n`),
        }),
      ]
    }
    // Only typed fs errors format as a GNU operand line, matching the
    // Python chokepoint (FS_ERRORS). Internal errors keep propagating
    // instead of being mangled into a plausible-looking stderr line.
    if (!isFsError(err)) throw err
    return [
      null,
      new IOResult({
        exitCode: readFailExitCode(cmdName, err),
        stderr: formatFsError(cmdName, err, scopes),
      }),
    ]
  }
}

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

import type { PathSpec } from '../../../../../types.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import { mergeOperandIos, runOperands, streamOperands } from '../utils.ts'
import { FlagView, flagOccurrences } from '../../../../spec/flag_view.ts'
import { type FlagValue } from '../../../../spec/types.ts'
import { specOf } from '../../../../spec/builtins.ts'
import { concat } from '../../../../../utils/bytes.ts'

// Run a per-operand command whose operands span mounts. The command runs
// natively once per operand on the operand's owning mount (globs expand
// inside that native run), and the outputs combine in operand order.
// Filename-keyed commands stay correct because every native run is forced to
// name its files (head/tail `-v`); `du -c` re-totals across
// runs.
export async function runFanout(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  const flags = { ...flagKwargs }
  flagOccurrences(flags).push(...flagOccurrences(flagKwargs))
  // head and tail name every operand unless -q (or tail's --silent) says
  // otherwise.
  if (cmdName === Cmd.HEAD || cmdName === Cmd.TAIL) {
    const view = new FlagView(flags, specOf(cmdName))
    if (!(view.asBool('quiet') || (cmdName === Cmd.TAIL && view.asBool('silent')))) {
      flags.verbose = true
    }
  }
  // The commands that change a mount run every operand before their output is
  // read, so a reader that stops early leaves none undone; the rest stream,
  // find's records joining once the last run drains.
  if (![Cmd.RM, Cmd.RMDIR, Cmd.UNLINK, Cmd.TOUCH, Cmd.MKDIR].includes(cmdName)) {
    const separator =
      (cmdName === Cmd.HEAD || cmdName === Cmd.TAIL) &&
      new FlagView(flags, specOf(cmdName)).asBool('verbose')
        ? '\n'
        : ''
    return streamOperands(runSingle, cmdName, scopes, textArgs, flags, separator)
  }
  const results = await runOperands(runSingle, cmdName, scopes, [...textArgs], flags)
  const exitCode = Math.max(0, ...results.map((r) => r.io.exitCode))

  const body = concat(results.map((r) => r.data))

  const io = await mergeOperandIos(results, exitCode)
  return [body, io]
}

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

import { materialize, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { combinedExit, concatRuns, joinRunsWithBlankLine } from './combine.ts'
import { duTotal } from './du.ts'
import { combineWc } from './wc.ts'
import type { CrossResult, RunSingle } from '../types.ts'
import { mergeOperandIos, runOperands } from '../utils.ts'

// Run a per-operand command whose operands span mounts. The command runs
// natively once per operand on the operand's owning mount (globs expand
// inside that native run), and the outputs combine in operand order.
// Filename-keyed commands stay correct because every native run is forced to
// name its files (grep `-H`, head/tail `-v`); wc and `du -c` re-total across
// runs.
export async function runFanout(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  runSingle: RunSingle,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const flags = { ...flagKwargs }
  let stdinBytes: Uint8Array | null = null
  if (cmdName === 'tee') {
    stdinBytes = stdin !== null ? await materialize(stdin) : new Uint8Array()
  }
  if (cmdName === 'grep' && flags.h !== true) {
    flags.H = true
  }
  if (cmdName === 'rg' && flags.args_I !== true) {
    flags.H = true
  }
  if ((cmdName === 'head' || cmdName === 'tail') && flags.q !== true) {
    flags.v = true
  }

  const results = await runOperands(runSingle, cmdName, scopes, [...textArgs], flags, stdinBytes)
  const exitCode = combinedExit(
    cmdName,
    results.map((r) => r.io.exitCode),
  )

  let body: Uint8Array
  if (cmdName === 'wc') {
    body = combineWc(results, flagKwargs)
  } else if (cmdName === 'du' && flagKwargs.c === true) {
    body = duTotal(results, flagKwargs.h === true)
  } else if (cmdName === 'tee') {
    body = stdinBytes ?? new Uint8Array()
  } else if (
    ((cmdName === 'head' || cmdName === 'tail') && flags.v === true) ||
    (cmdName === 'ls' && flagKwargs.R === true)
  ) {
    // Blank line between per-operand blocks, like one native run separates
    // its own file blocks.
    body = joinRunsWithBlankLine(results)
  } else {
    body = concatRuns(results)
  }

  const io = await mergeOperandIos(results, exitCode)
  return [body, io]
}

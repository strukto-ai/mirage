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
import { combinedExit } from './exit.ts'
import { duTotal } from './du.ts'
import { combineWc } from './wc.ts'
import { Cmd, type CrossResult, type OperandRun, type RunSingle } from '../types.ts'
import { mergeOperandIos, runOperands } from '../utils.ts'

const ENC = new TextEncoder()

function concatRuns(results: OperandRun[]): Uint8Array {
  const nonEmpty = results.map((r) => r.data).filter((d) => d.byteLength > 0)
  const size = nonEmpty.reduce((n, d) => n + d.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const d of nonEmpty) {
    out.set(d, offset)
    offset += d.byteLength
  }
  return out
}

function joinRunsWithBlankLine(results: OperandRun[]): Uint8Array {
  const parts = results.map((r) => r.data).filter((d) => d.byteLength > 0)
  const sep = ENC.encode('\n')
  const size =
    parts.reduce((n, d) => n + d.byteLength, 0) + sep.byteLength * Math.max(0, parts.length - 1)
  const out = new Uint8Array(size)
  let offset = 0
  parts.forEach((d, i) => {
    if (i > 0) {
      out.set(sep, offset)
      offset += sep.byteLength
    }
    out.set(d, offset)
    offset += d.byteLength
  })
  return out
}

// Run a per-operand command whose operands span mounts. The command runs
// natively once per operand on the operand's owning mount (globs expand
// inside that native run), and the outputs combine in operand order.
// Filename-keyed commands stay correct because every native run is forced to
// name its files (grep `-H`, head/tail `-v`); wc and `du -c` re-total across
// runs.
export async function runFanout(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  runSingle: RunSingle,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const flags = { ...flagKwargs }
  let stdinBytes: Uint8Array | null = null
  if (cmdName === Cmd.TEE) {
    stdinBytes = stdin !== null ? await materialize(stdin) : new Uint8Array()
  }
  if (cmdName === Cmd.GREP && flags.h !== true) {
    flags.H = true
  }
  if (cmdName === Cmd.RG && flags.args_I !== true) {
    flags.H = true
  }
  if ((cmdName === Cmd.HEAD || cmdName === Cmd.TAIL) && flags.q !== true) {
    flags.v = true
  }

  const results = await runOperands(runSingle, cmdName, scopes, [...textArgs], flags, stdinBytes)
  const exitCode = combinedExit(
    cmdName,
    results.map((r) => r.io.exitCode),
  )

  let body: Uint8Array
  if (cmdName === Cmd.WC) {
    body = combineWc(results, flagKwargs)
  } else if (cmdName === Cmd.DU && flagKwargs.c === true) {
    body = duTotal(results, flagKwargs.h === true)
  } else if (cmdName === Cmd.TEE) {
    body = stdinBytes ?? new Uint8Array()
  } else if (
    ((cmdName === Cmd.HEAD || cmdName === Cmd.TAIL) && flags.v === true) ||
    (cmdName === Cmd.LS && flagKwargs.R === true)
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

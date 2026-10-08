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

import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { NamespaceView } from '../../../../../doors/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../../../types.ts'
import { isFsError } from '../../../../../errors/fs.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { runDispatch } from '../../../generic_bind/dispatch.ts'
import { isStdin } from '../../../utils/stream.ts'
import { formatCountRows, numberWidth, parseFlags, type WcRow } from '../../wc.ts'
import { DISPATCH_BUILDERS } from '../constants.ts'
import {
  Cmd,
  type CrossResult,
  type DispatchFn,
  type OperandRun,
  type RunSingle,
} from '../types.ts'
import { mergeOperandIos, runOperands, statOp } from '../utils.ts'

const ENC = new TextEncoder()

// GNU prints a row's counts in this order whichever flags ask for them.
const COLUMNS = ['lines', 'words', 'chars', 'bytes', 'maxLineLength'] as const
type Column = (typeof COLUMNS)[number]

/**
 * The size GNU sizes the columns by, which it takes from fstat. A stream or a
 * directory has none. A file whose size stat cannot give without rendering it,
 * or that is gone by the time it is sized, counts as its widest count, a lower
 * bound, which is the width a count-only mount pads to on its own. Mirrors
 * Python's operand_size.
 */
async function operandSize(
  dispatch: DispatchFn,
  path: PathSpec,
  counts: number[],
): Promise<number | null> {
  if (isStdin(path)) return null
  let info: FileStat
  try {
    info = await statOp(dispatch)(path)
  } catch (err) {
    // Gone since its mount counted it: the width is only layout, so the
    // counts already taken still print, padded to the lower bound.
    if (!isFsError(err)) throw err
    return Math.max(...counts)
  }
  if (info.type === FileType.DIRECTORY) return null
  return info.size ?? Math.max(...counts)
}

/**
 * The run as counted, recounting it through the dispatcher if needed. A
 * mount's wc that succeeds without counts (one not built on the generic)
 * leaves its operand to the generic over the dispatcher, and only that
 * operand: the others keep what their own mount counted. Mirrors Python's
 * recount.
 */
export async function recount(
  run: OperandRun,
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  cwd: string,
  ns: NamespaceView | undefined,
  stdin: ByteSource | null,
): Promise<OperandRun> {
  if (run.io.countedRuns !== null || run.io.exitCode !== 0) return run
  const builder = DISPATCH_BUILDERS.get(Cmd.WC)
  if (builder === undefined) throw new Error('No dispatch builder for wc')
  const [, io] = await runDispatch(builder, [run.scope], [], bag, dispatch, cwd, ns, stdin)
  return { scope: run.scope, data: new Uint8Array(0), io }
}

/**
 * Count each operand on its own mount and lay the rows out together. Each
 * operand runs through its owning mount's wc, so a mount that counts without
 * reading its file (a database row count) still does, and reading mounts
 * stream. Only the layout spans the line: the counts each run reports
 * (`IOResult.countedRuns`) go through the generic's formatter with GNU's
 * column width, and no mount's output text is read back. A run that succeeds
 * without counts is recounted on its own (`recount`). Mirrors Python's
 * run_wc.
 */
export async function runWc(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  cwd = '/',
  ns?: NamespaceView,
  stdin: ByteSource | null = null,
): Promise<CrossResult> {
  const parsed = parseFlags(flagKwargs)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const asked = COLUMNS.filter((c) => parsed[c])
  const columns: readonly Column[] = asked.length > 0 ? asked : ['lines', 'words', 'bytes']
  const each = { ...flagKwargs, total: 'never' }
  const runs: OperandRun[] = []
  for (const run of await runOperands(runSingle, Cmd.WC, scopes, [], each)) {
    runs.push(await recount(run, each, dispatch, cwd, ns, stdin))
  }
  const rows: WcRow[] = []
  const sizes: (number | null)[] = []
  const totals = columns.map(() => 0)
  for (const run of runs) {
    for (const counted of run.io.countedRuns ?? []) {
      const values = [...counted.values]
      rows.push({ values, label: counted.label })
      sizes.push(await operandSize(dispatch, run.scope, values))
      values.forEach((value, i) => {
        const sum = totals[i] ?? 0
        totals[i] = columns[i] === 'maxLineLength' ? Math.max(sum, value) : sum + value
      })
    }
  }
  const width = numberWidth(sizes, scopes.length, columns.length)
  const body = formatCountRows(rows, totals, scopes.length, parsed.total, width)
  return [body, await mergeOperandIos(runs, Math.max(...runs.map((run) => run.io.exitCode)))]
}

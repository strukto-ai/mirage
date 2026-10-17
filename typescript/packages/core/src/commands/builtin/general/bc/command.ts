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

import type { PathSpec } from '../../../../types.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'

import type { BcNumber, BcState, BcStatement } from './types.ts'
import { ZERO } from './numbers.ts'
import * as constants from './constants.ts'
import { BcParseError, BcRuntimeError, BcHalt, parseErrorLine, runtimeErrorLine } from './errors.ts'
import { OutputColumn, outputLineSize } from './render.ts'
import { parseInput } from './lexer.ts'
import { evalStatement } from './parser.ts'

const ENC = new TextEncoder()

export function snapshotState(state: BcState): BcState {
  return {
    scale: state.scale,
    mathMode: state.mathMode,
    ibase: state.ibase,
    obase: state.obase,
    last: state.last,
    variables: new Map(state.variables),
    warnings: [],
  }
}

export function restoreState(state: BcState, saved: BcState): void {
  state.scale = saved.scale
  state.ibase = saved.ibase
  state.obase = saved.obase
  state.last = saved.last
  state.variables = new Map(saved.variables)
}

export function errorLine(statement: BcStatement, error: BcParseError): number {
  if (error.incomplete) return statement.incompleteLine
  return statement.lines[error.pos] ?? statement.lines[0] ?? statement.incompleteLine
}

export async function* runLines(
  lines: AsyncIterable<BcStatement[] | string>,
  state: BcState,
  folder: OutputColumn,
  errors: string[],
): AsyncGenerator<Uint8Array> {
  let halted = false
  for await (const statements of lines) {
    if (typeof statements === 'string') {
      errors.push(statements)
      continue
    }
    const saved = snapshotState(state)
    const savedCol = folder.col
    const lineResults: string[] = []
    const lineErrors: string[] = []
    const parseErrors: string[] = []
    let aborted = false
    for (const statement of statements) {
      const runs: boolean = statement.execute && !halted && !aborted
      const target = runs ? state : snapshotState(state)
      const writes: string[] = []
      try {
        evalStatement(statement.text, target, writes)
      } catch (err) {
        if (err instanceof BcParseError) {
          parseErrors.push(parseErrorLine(errorLine(statement, err), err.text))
        } else if (err instanceof BcRuntimeError) {
          if (runs) {
            lineErrors.push(...state.warnings)
            state.warnings.length = 0
            lineErrors.push(runtimeErrorLine(err.message))
            aborted = true
          }
        } else if (err instanceof BcHalt) {
          halted = runs
        } else {
          throw err
        }
      }
      if (runs) lineErrors.push(...state.warnings)
      state.warnings.length = 0
      if (!runs) continue
      for (const piece of writes) lineResults.push(folder.write(piece))
    }
    if (parseErrors.length > 0) {
      errors.push(...parseErrors)
      restoreState(state, saved)
      folder.col = savedCol
      halted = false
      continue
    }
    errors.push(...lineErrors)
    if (lineResults.length > 0) yield ENC.encode(lineResults.join(''))
    if (halted) break
  }
}

export function bc(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('bc'))
  const useMath = fl.asBool('args_l')
  const state: BcState = {
    scale: useMath ? constants.MATH_LIBRARY_SCALE : 0,
    mathMode: useMath,
    ibase: constants.DEFAULT_BASE,
    obase: constants.DEFAULT_BASE,
    last: ZERO,
    variables: new Map<string, BcNumber>(),
    warnings: [],
  }
  const folder = new OutputColumn(outputLineSize(ctx.env))
  const errors: string[] = []
  const lines = parseInput(ctx.stdin ?? new Uint8Array(), ctx.signal)
  const io = new IOResult()
  async function* output(): AsyncGenerator<Uint8Array> {
    try {
      yield* runLines(lines, state, folder, errors)
    } finally {
      await lines.return(undefined)
      io.stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
    }
  }
  return Promise.resolve([output(), io])
}

export const GENERAL_BC = command({
  name: 'bc',
  vfs: null,
  spec: specOf('bc'),
  fn: bc,
})

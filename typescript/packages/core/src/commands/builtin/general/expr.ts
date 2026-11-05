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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { byteView, fromByteView, utf8Locale } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import { openStream, closeStream } from '../../../rs/stream.ts'
import { UsageError } from '../../errors.ts'

/** Evaluate byte views, or text under a UTF-8 locale, through the shared core. */
export async function exprEval(
  args: string[],
  utf8 = false,
  signal?: AbortSignal,
): Promise<[string, number]> {
  const engine = await openStream('expr', {
    words: args.map((word) => (utf8 ? byteView(word) : word)),
    utf8,
  })
  const budget = new YieldBudget(signal)
  const out: Uint8Array[] = []
  try {
    while (engine.busy()) {
      await budget.run()
      out.push(engine.drain())
    }
    if (engine.status() === 2)
      throw new UsageError(byteView(engine.takeStderr(), utf8).replace(/\n$/, ''))
    return [byteView(concat(out), utf8), engine.status()]
  } finally {
    await closeStream(engine)
  }
}

async function expr(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const utf8 = utf8Locale(ctx.env)
  try {
    const [result, exitCode] = await exprEval(
      texts.map((text) => byteView(text, utf8)),
      utf8,
      ctx.signal,
    )
    return [fromByteView(result + '\n', utf8), new IOResult({ exitCode })]
  } catch (err) {
    if (err instanceof UsageError)
      return [null, new IOResult({ exitCode: 2, stderr: fromByteView(`${err.message}\n`, utf8) })]
    throw err
  }
}

export const GENERAL_EXPR = command({ name: 'expr', vfs: null, spec: specOf('expr'), fn: expr })

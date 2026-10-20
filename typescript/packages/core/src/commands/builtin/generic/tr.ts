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

import { byteView } from '../../../shell/bytes.ts'
import { IOResult } from '../../../io/types.ts'
import { openStream, streamOutput, type OpenStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { extraOperandError, missingOperandError, usageHint } from '../../spec/usage.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const TRY_HELP = `\n${usageHint('tr')}`

interface TrFlags {
  readonly delete: boolean
  readonly squeeze: boolean
  readonly complement: boolean
  readonly truncateSet1: boolean
}

function parseFlags(bag: Record<string, FlagValue>): TrFlags {
  const fl = new FlagView(bag, specOf('tr'))
  return {
    delete: fl.asBool('delete'),
    squeeze: fl.asBool('squeeze_repeats'),
    complement: fl.asBool('C') || fl.asBool('complement'),
    truncateSet1: fl.asBool('truncate_set1'),
  }
}

function buildConfig(
  texts: readonly string[],
  bag: Record<string, FlagValue>,
): Readonly<Record<string, JsonValue>> {
  if (texts.length === 0) throw missingOperandError(CommandName.TR, null)
  const { delete: del, squeeze, complement, truncateSet1 } = parseFlags(bag)
  const operandLimit = del && !squeeze ? 1 : 2
  if (texts.length > operandLimit) {
    if (texts.length === 2) {
      throw new Error(
        `tr: extra operand '${quoteText(texts[1] ?? '')}'\n` +
          `Only one string may be given when deleting without squeezing repeats.${TRY_HELP}`,
      )
    }
    throw extraOperandError(CommandName.TR, texts[operandLimit] ?? '')
  }
  return {
    set1: byteView(texts[0] ?? ''),
    set2: texts.length >= 2 ? byteView(texts[1] ?? '') : null,
    delete: del,
    squeeze,
    complement,
    truncate_set1: truncateSet1,
  }
}

export async function trGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  let engine: OpenStream
  try {
    engine = await openStream('tr', buildConfig(texts, ctx.flags))
  } catch (err) {
    if (err instanceof UsageError) throw err
    const msg =
      err instanceof StreamRefusal && err.message === 'tr: missing translation operand'
        ? `tr: missing operand after '${quoteText(texts[0] ?? '')}'\n` +
          `Two strings must be given when translating.${TRY_HELP}`
        : err instanceof Error
          ? err.message
          : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const first = paths[0]
  try {
    const source = first === undefined ? resolveSource(ctx.stdin) : stream(first)
    return [streamOutput(engine, source, ctx.signal), new IOResult()]
  } catch (error) {
    engine.close()
    throw error
  }
}

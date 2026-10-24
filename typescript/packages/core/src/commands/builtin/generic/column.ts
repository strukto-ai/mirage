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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { byteView } from '../../../shell/bytes.ts'
import { chainOutput, closeStream, openStream } from '../../../rs/stream.ts'

interface ColumnFlags {
  readonly table: boolean
  readonly separator: string | null
  readonly outputSeparator: string
}

function parseFlags(bag: Record<string, FlagValue>): ColumnFlags {
  const fl = new FlagView(bag, specOf('column'))
  return {
    table: fl.asBool('t'),
    separator: fl.asStr('s') ?? null,
    outputSeparator: fl.asStr('o', '  '),
  }
}

async function* columned(
  config: Readonly<Record<string, JsonValue>>,
  sources: readonly ByteSource[],
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const stream = await openStream('column', config)
  try {
    yield* chainOutput(stream, sources, signal)
  } finally {
    await closeStream(stream)
  }
}

// util-linux column over every operand, or stdin without one. Mirrors
// Python's column_generic.
export async function columnGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  const sources: ByteSource[] = []
  for (const path of paths) sources.push(await materialize(stream(path)))
  const config = {
    table: parsed.table,
    separator: parsed.separator === null ? null : byteView(parsed.separator),
    output_separator: byteView(parsed.outputSeparator),
    columns: ctx.env?.COLUMNS ?? null,
    inputs: Math.max(1, sources.length),
  }
  if (sources.length === 0) sources.push(ctx.stdin ?? new Uint8Array())
  return [columned(config, sources, ctx.signal), new IOResult()]
}

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
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { byteView } from '../../../shell/bytes.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import { chainOutput, closeStream, openStream } from '../../../rs/stream.ts'

interface ColumnFlags {
  readonly table: boolean
  readonly separator: string | null
  readonly outputSeparator: string
  readonly outputWidth: string | null
  readonly fillrows: boolean
  readonly json: boolean
  readonly tableName: string | null
  readonly names: string | null
  readonly columnSpecs: readonly string[]
  readonly order: string | null
  readonly limit: string | null
  readonly right: string | null
  readonly hide: string | null
  readonly truncate: string | null
  readonly wrap: string | null
  readonly noextreme: string | null
  readonly noHeadings: boolean
  readonly maxout: boolean
}

function parseFlags(bag: Record<string, FlagValue>): ColumnFlags {
  const fl = new FlagView(bag, specOf('column'))
  const text = (name: string): string | null => fl.asStr(name) ?? null
  return {
    table: fl.asBool('table'),
    separator: text('separator'),
    outputSeparator: fl.asStr('output_separator', '  '),
    outputWidth: text('output_width'),
    fillrows: fl.asBool('fillrows'),
    json: fl.asBool('json'),
    tableName: text('table_name'),
    names: text('table_columns'),
    columnSpecs: fl.asList('table_column'),
    order: text('table_order'),
    limit: text('table_columns_limit'),
    right: text('table_right'),
    hide: text('table_hide'),
    truncate: text('table_truncate'),
    wrap: text('table_wrap'),
    noextreme: text('table_noextreme'),
    noHeadings: fl.asBool('table_noheadings'),
    maxout: fl.asBool('table_maxout'),
  }
}

function bytesOf(text: string | null): string | null {
  return text === null ? null : byteView(text)
}

// What mirage-rs's column takes for one invocation. Mirrors Python's
// stream_config.
function streamConfig(
  parsed: ColumnFlags,
  columns: string | null,
  inputs: number,
): Readonly<Record<string, JsonValue>> {
  return {
    table: parsed.table,
    separator: bytesOf(parsed.separator),
    output_separator: byteView(parsed.outputSeparator),
    columns,
    inputs,
    output_width: bytesOf(parsed.outputWidth),
    fillrows: parsed.fillrows,
    json: parsed.json,
    table_name: bytesOf(parsed.tableName),
    names: bytesOf(parsed.names),
    column_specs: parsed.columnSpecs.map((text) => byteView(text)),
    order: bytesOf(parsed.order),
    limit: bytesOf(parsed.limit),
    right: bytesOf(parsed.right),
    hide: bytesOf(parsed.hide),
    truncate: bytesOf(parsed.truncate),
    wrap: bytesOf(parsed.wrap),
    noextreme: bytesOf(parsed.noextreme),
    no_headings: parsed.noHeadings,
    maxout: parsed.maxout,
  }
}

// The engine's output, with what it refuses settled on `io`. Mirrors
// Python's _columned.
async function* columned(
  config: Readonly<Record<string, JsonValue>>,
  sources: readonly ByteSource[],
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  try {
    const stream = await openStream('column', config)
    try {
      yield* chainOutput(stream, sources, signal)
    } finally {
      await closeStream(stream)
    }
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    const settled = refused(error)
    io.exitCode = settled.exitCode
    io.stderr = settled.stderr
  }
}

// util-linux column over every operand, or stdin without one; output is
// never colored. Mirrors Python's column_generic.
export function columnGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(ctx.flags)
  const sources: ByteSource[] = []
  for (const path of paths) sources.push(stream(path))
  const config = streamConfig(parsed, ctx.env?.COLUMNS ?? null, Math.max(1, sources.length))
  if (sources.length === 0) sources.push(ctx.stdin ?? new Uint8Array())
  const io = new IOResult()
  return Promise.resolve([columned(config, sources, io, ctx.signal), io])
}

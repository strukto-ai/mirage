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

import { stdinStat, stdinStream } from '../utils/stream.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { OutputStream } from '../../../io/stream.ts'
import type { FileStat, JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { closeStream, openStream } from '../../../rs/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { byteView } from '../../../shell/bytes.ts'
import { resolveSource, streamOutput } from '../utils/stream.ts'
import { operandsIo, reportedStream, splitReadable } from '../utils/operands.ts'
import { matchWord } from '../../spec/word_choice.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

interface CutFlags {
  ranges: string
  mode: 'bytes' | 'characters' | 'fields'
  delimiter: string
  complement: boolean
  onlyDelimited: boolean
  whitespace: 'default' | 'trimmed' | null
  noPartial: boolean
  outputDelimiter: string | null
  zeroTerminated: boolean
}

const WHITESPACE_ARGS: readonly string[] = ['trimmed']

function parseFlags(bag: Record<string, FlagValue>): CutFlags | string {
  const fl = new FlagView(bag, specOf('cut'))
  const bytesRange = fl.asStr('bytes')
  const charsRange = fl.asStr('characters')
  const fieldsRange = fl.asStr('F') ?? fl.asStr('fields')
  const selected = [bytesRange, charsRange, fieldsRange].filter((value) => value !== undefined)
  if (selected.length === 0) {
    return 'cut: you must specify a list of bytes, characters, or fields\n'
  }
  if (selected.length > 1) return 'cut: only one type of list may be specified\n'
  const mode: CutFlags['mode'] =
    bytesRange !== undefined ? 'bytes' : charsRange !== undefined ? 'characters' : 'fields'
  const range = bytesRange ?? charsRange ?? fieldsRange ?? ''
  const rawWhitespace = fl.raw('whitespace_delimited')
  let whitespace: CutFlags['whitespace'] = null
  if (fl.asBool('w') || fl.asStr('F') !== undefined || rawWhitespace === true) {
    whitespace = 'default'
  } else if (typeof rawWhitespace === 'string') {
    if (!matchWord(rawWhitespace, WHITESPACE_ARGS).matched) {
      return (
        `cut: invalid argument '${quoteText(rawWhitespace)}' for ` + "'--whitespace-delimited'\n"
      )
    }
    whitespace = 'trimmed'
  }
  if (whitespace !== null && mode !== 'fields') {
    return "cut: '-w' is only meaningful with fields\n"
  }
  let outputDelimiter = fl.asStr('args_O') ?? fl.asStr('output_delimiter')
  if (fl.asStr('F') !== undefined && outputDelimiter === undefined) outputDelimiter = ' '
  // GNU reads an empty -d or --output-delimiter as its terminating NUL:
  // `cut -d ''` splits on NUL bytes and writes one between fields.
  if (outputDelimiter === '') outputDelimiter = '\0'
  const typedDelimiter = fl.asStr('delimiter')
  const explicitDelimiter = typedDelimiter === '' ? '\0' : typedDelimiter
  if (explicitDelimiter !== undefined && Array.from(explicitDelimiter).length !== 1) {
    return 'cut: the delimiter must be a single character\n'
  }
  return {
    ranges: range,
    mode,
    delimiter: explicitDelimiter ?? '\t',
    complement: fl.asBool('complement'),
    onlyDelimited: fl.asBool('only_delimited'),
    whitespace,
    noPartial: fl.asBool('no_partial'),
    outputDelimiter: outputDelimiter ?? null,
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

export async function cutGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stat: (path: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const config = {
    list: byteView(parsed.ranges),
    mode: parsed.mode,
    delimiter: Array.from(parsed.delimiter, (character) => character.codePointAt(0) ?? 0),
    complement: parsed.complement,
    only_delimited: parsed.onlyDelimited,
    whitespace: parsed.whitespace,
    no_partial: parsed.noPartial,
    output_delimiter:
      parsed.outputDelimiter === null
        ? null
        : { kind: 'bytes', value: byteView(ENC.encode(parsed.outputDelimiter)) },
    zero_terminated: parsed.zeroTerminated,
  } satisfies Record<string, JsonValue>
  let engine: Awaited<ReturnType<typeof openStream>>
  try {
    engine = await openStream('cut', config)
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${error.message}\n`) })]
  }
  if (paths.length > 0) {
    let inspected: Awaited<ReturnType<typeof splitReadable>>
    try {
      inspected = await splitReadable(paths, stdinStat(stat), 'cut')
    } catch (error) {
      engine.close()
      throw error
    }
    const [ok, err] = inspected
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') {
      engine.close()
      return [null, io]
    }
    async function* outputs(): AsyncIterable<Uint8Array> {
      try {
        for (const [index, operand] of ok.entries()) {
          const current = index === 0 ? engine : await openStream('cut', config)
          try {
            yield* reportedStream(
              streamOutput(current, stream(operand), ctx.signal),
              io,
              operand,
              'cut',
            )
          } finally {
            await closeStream(current)
          }
        }
      } finally {
        await closeStream(engine)
      }
    }
    const out: ByteSource = new OutputStream(outputs()[Symbol.asyncIterator](), () =>
      closeStream(engine),
    )
    return [out, io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(ctx.stdin)
  } catch (error) {
    engine.close()
    const message = error instanceof Error ? error.message : String(error)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
  }
  return [streamOutput(engine, source, ctx.signal), new IOResult()]
}

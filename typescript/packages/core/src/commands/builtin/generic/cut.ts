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

import { asyncChain } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { cutStream, parseRanges, type CutOptions } from '../cut_ranges.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

function parseFlags(flags: Record<string, FlagValue>): CutOptions | string {
  const fl = new FlagView(flags, specOf('cut'))
  const bytesRange = fl.asStr('bytes')
  const charsRange = fl.asStr('characters')
  const fieldsRange = fl.asStr('F') ?? fl.asStr('fields')
  const selected = [bytesRange, charsRange, fieldsRange].filter((value) => value !== undefined)
  if (selected.length === 0) {
    return 'cut: you must specify a list of bytes, characters, or fields\n'
  }
  if (selected.length > 1) return 'cut: only one type of list may be specified\n'
  const mode: CutOptions['mode'] =
    bytesRange !== undefined ? 'bytes' : charsRange !== undefined ? 'characters' : 'fields'
  const range = bytesRange ?? charsRange ?? fieldsRange ?? ''
  const rawWhitespace = fl.raw('whitespace_delimited')
  let whitespace: CutOptions['whitespace'] = null
  if (fl.asBool('w') || fl.asStr('F') !== undefined || rawWhitespace === true) {
    whitespace = 'default'
  } else if (typeof rawWhitespace === 'string') {
    if (rawWhitespace !== 'trimmed') {
      return `cut: invalid argument '${rawWhitespace}' for '--whitespace-delimited'\n`
    }
    whitespace = 'trimmed'
  }
  if (whitespace !== null && mode !== 'fields') {
    return "cut: '-w' is only meaningful with fields\n"
  }
  let outputDelimiter = fl.asStr('args_O') ?? fl.asStr('output_delimiter')
  if (fl.asStr('F') !== undefined && outputDelimiter === undefined) outputDelimiter = ' '
  const explicitDelimiter = fl.asStr('delimiter')
  if (explicitDelimiter !== undefined && Array.from(explicitDelimiter).length !== 1) {
    return 'cut: the delimiter must be a single character\n'
  }
  return {
    ranges: parseRanges(range),
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
  opts: CommandOpts,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  if (paths.length > 0) {
    const [ok, err] = await readOperands(paths, stream, 'cut')
    const io = operandsIo(err, { cache: ok.map((operand) => operand.path.virtual) })
    if (ok.length === 0 && err !== '') return [null, io]
    const outputs = ok.map((operand) => cutStream(singleChunk(operand.data), parsed))
    const out: ByteSource = asyncChain(...outputs)
    return [out, io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, 'cut: missing operand')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
  }
  return [cutStream(source, parsed), new IOResult()]
}

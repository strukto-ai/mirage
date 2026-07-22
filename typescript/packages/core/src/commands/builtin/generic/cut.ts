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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { cutStream, parseCutRanges, type CutOptions } from '../cut_helper.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()

async function* chainStreams(
  streams: readonly AsyncIterable<Uint8Array>[],
): AsyncIterable<Uint8Array> {
  for (const stream of streams) {
    for await (const chunk of stream) yield chunk
  }
}

function stringFlag(
  flags: Record<string, string | boolean | string[]>,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = flags[name]
    if (typeof value === 'string') return value
  }
  return null
}

function parseFlags(flags: Record<string, string | boolean | string[]>): CutOptions | string {
  const bytesRange = stringFlag(flags, 'b', 'bytes')
  const charsRange = stringFlag(flags, 'c', 'characters')
  const fieldsRange = stringFlag(flags, 'F', 'f', 'fields')
  const selected = [bytesRange, charsRange, fieldsRange].filter((value) => value !== null)
  if (selected.length === 0) {
    return 'cut: you must specify a list of bytes, characters, or fields\n'
  }
  if (selected.length > 1) return 'cut: only one type of list may be specified\n'
  const mode: CutOptions['mode'] =
    bytesRange !== null ? 'bytes' : charsRange !== null ? 'characters' : 'fields'
  const range = bytesRange ?? charsRange ?? fieldsRange ?? ''
  const rawWhitespace = flags.whitespace_delimited
  let whitespace: CutOptions['whitespace'] = null
  if (flags.w === true || typeof flags.F === 'string' || rawWhitespace === true) {
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
  let outputDelimiter = stringFlag(flags, 'args_O', 'output_delimiter')
  if (typeof flags.F === 'string' && outputDelimiter === null) outputDelimiter = ' '
  const explicitDelimiter = stringFlag(flags, 'd', 'delimiter')
  if (explicitDelimiter !== null && Array.from(explicitDelimiter).length !== 1) {
    return 'cut: the delimiter must be a single character\n'
  }
  return {
    ranges: parseCutRanges(range),
    mode,
    delimiter: explicitDelimiter ?? '\t',
    complement: flags.complement === true,
    onlyDelimited: flags.s === true || flags.only_delimited === true,
    whitespace,
    noPartial: flags.n === true || flags.no_partial === true,
    outputDelimiter,
    zeroTerminated: flags.z === true || flags.zero_terminated === true,
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
    const out: ByteSource = chainStreams(outputs)
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

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

import { isStdin, neverOpened } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '0': '' }

// GNU paste recognizes exactly \n, \t, \\ and \0, where \0 means the empty
// delimiter (fields are concatenated) rather than a NUL byte. A single
// left-to-right scan keeps \\0 reading as a backslash followed by 0.
function decodeDelimiters(value: string): string[] {
  const chars: string[] = []
  let index = 0
  while (index < value.length) {
    const char = value[index] ?? ''
    const next = value[index + 1]
    if (char === '\\' && next !== undefined && Object.hasOwn(ESCAPES, next)) {
      chars.push(ESCAPES[next] ?? '')
      index += 2
      continue
    }
    chars.push(char)
    index += 1
  }
  return chars.length > 0 ? chars : ['']
}

function joinFields(fields: readonly string[], delimiters: readonly string[]): string {
  if (fields.length === 0) return ''
  let output = fields[0] ?? ''
  for (let index = 1; index < fields.length; index += 1) {
    output += (delimiters[(index - 1) % delimiters.length] ?? '') + (fields[index] ?? '')
  }
  return output
}

export function pasteGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const fl = new FlagView(ctx.flags, specOf('paste'))
  const delimiterValue = fl.asStr('delimiters')
  const delimiters = decodeDelimiters(typeof delimiterValue === 'string' ? delimiterValue : '\t')
  const serial = fl.asBool('serial')
  const zeroTerminated = fl.asBool('zero_terminated')
  const shared = new AsyncLineIterator(ctx.stdin ?? new Uint8Array())
  const operands = paths.length === 0 ? [PathSpec.fromStrPath('-')] : paths
  const inputs = operands.map(
    (p) => [p, isStdin(p) ? shared : new AsyncLineIterator(stream(p))] as const,
  )
  const io = new IOResult()
  return [pasteStream(inputs, delimiters, serial, zeroTerminated ? 0 : 10, io), io]
}

/**
 * Paste the operands' records, in rows or one operand per line. A failed
 * read is reported, exit 1, and its operand reads as ended, as GNU's does;
 * one that never opened stops the rows before any is written, and under -s
 * leaves that operand out. Mirrors Python's _paste_stream.
 */
async function* pasteStream(
  inputs: readonly (readonly [PathSpec, AsyncLineIterator])[],
  delimiters: string[],
  serial: boolean,
  separator: number,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const errors: string[] = []
  const line = async (
    path: PathSpec,
    reader: AsyncLineIterator,
  ): Promise<[Uint8Array | null, boolean]> => {
    try {
      return [await reader.readline(undefined, separator), false]
    } catch (error) {
      if (!isFsError(error)) throw error
      errors.push(fsErrorLine('paste', path, error))
      io.stderr = ENC.encode(errors.join(''))
      io.exitCode = 1
      return [null, neverOpened(reader, path, error)]
    }
  }
  try {
    if (serial) {
      for (const [path, reader] of inputs) {
        let index = 0
        let unopened = false
        for (;;) {
          const [record, failed] = await line(path, reader)
          unopened = failed
          if (record === null) break
          const prefix = index === 0 ? '' : (delimiters[(index - 1) % delimiters.length] ?? '')
          yield ENC.encode(prefix + DEC.decode(record))
          index += 1
        }
        if (!unopened) yield new Uint8Array([separator])
      }
    } else {
      for (;;) {
        const row: (Uint8Array | null)[] = []
        for (const [path, reader] of inputs) {
          const [record, unopened] = await line(path, reader)
          if (unopened) return
          row.push(record)
        }
        if (row.every((record) => record === null)) return
        yield ENC.encode(
          joinFields(
            row.map((record) => (record === null ? '' : DEC.decode(record))),
            delimiters,
          ) + String.fromCharCode(separator),
        )
      }
    }
  } finally {
    for (const reader of new Set(inputs.map(([, reader]) => reader))) await reader.discard()
  }
}

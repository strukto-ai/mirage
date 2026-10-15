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

import { isStdin } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
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
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const fl = new FlagView(opts.flags, specOf('paste'))
  const delimiterValue = fl.asStr('delimiters')
  const delimiters = decodeDelimiters(typeof delimiterValue === 'string' ? delimiterValue : '\t')
  const serial = fl.asBool('serial')
  const zeroTerminated = fl.asBool('zero_terminated')
  const shared = new AsyncLineIterator(opts.stdin ?? new Uint8Array())
  const readers =
    paths.length === 0
      ? [shared]
      : paths.map((p) => (isStdin(p) ? shared : new AsyncLineIterator(stream(p))))
  return [pasteStream(readers, delimiters, serial, zeroTerminated ? 0 : 10), new IOResult()]
}

async function* pasteStream(
  readers: AsyncLineIterator[],
  delimiters: string[],
  serial: boolean,
  separator: number,
): AsyncIterable<Uint8Array> {
  try {
    if (serial) {
      for (const reader of readers) {
        let index = 0
        for (;;) {
          const record = await reader.readline(undefined, separator)
          if (record === null) break
          const prefix = index === 0 ? '' : (delimiters[(index - 1) % delimiters.length] ?? '')
          yield ENC.encode(prefix + DEC.decode(record))
          index += 1
        }
        yield new Uint8Array([separator])
      }
    } else {
      for (;;) {
        const row: (Uint8Array | null)[] = []
        for (const reader of readers) row.push(await reader.readline(undefined, separator))
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
    for (const reader of new Set(readers)) await reader.discard()
  }
}

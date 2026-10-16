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
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { resolveSource, stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { RecordSpool } from '../../../io/record_spool.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

async function* reverseSource(
  source: AsyncIterable<Uint8Array>,
  separator: string,
  before: boolean,
  regex: boolean,
): AsyncGenerator<Uint8Array> {
  if (!regex) {
    const delimiter = encodeText(separator)
    const reader = new AsyncLineIterator(source)
    const records = new RecordSpool()
    try {
      let prefix: Uint8Array = new Uint8Array()
      try {
        for (;;) {
          const [raw, found] = await reader.readUntil(delimiter)
          const record = before ? concat([prefix, raw]) : found ? concat([raw, delimiter]) : raw
          if (record.length > 0) await records.append(record)
          if (!found) break
          prefix = delimiter
        }
      } finally {
        await reader.discard()
      }
      for (let index = records.count - 1; index >= 0; index--) yield* records.stream(index)
    } finally {
      await records.close()
    }
    return
  }
  const text = DEC.decode(await materialize(source))
  const matcher = new RegExp(`(${separator})`, 'g')
  const parts = text.split(matcher)
  const found: string[] = []
  for (let index = 0; index < parts.length - 1; index += 2) {
    found.push(
      before
        ? (parts[index + 1] ?? '') + (parts[index] ?? '')
        : (parts[index] ?? '') + (parts[index + 1] ?? ''),
    )
  }
  if (parts.length % 2 === 1 && parts.at(-1) !== '') found.push(parts.at(-1) ?? '')
  yield ENC.encode(found.reverse().join(''))
}

/** `-s` as tac reads it: a newline when absent, and NUL when empty, as the
 * C string's terminator. Mirrors Python's _separator_of. */
function separatorOf(raw: string | undefined): string {
  if (raw === undefined) return '\n'
  return raw === '' ? '\0' : raw
}

interface TacFlags {
  readonly separator: string
  readonly before: boolean
  readonly regex: boolean
}

function parseFlags(bag: Record<string, FlagValue>): TacFlags {
  const fl = new FlagView(bag, specOf('tac'))
  return {
    separator: separatorOf(fl.asStr('separator')),
    before: fl.asBool('before'),
    regex: fl.asBool('regex'),
  }
}

export function tacGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<[ByteSource | null, IOResult]> {
  stream = stdinStream(stream, opts.stdin)
  const { separator, before, regex } = parseFlags(opts.flags)
  const io = new IOResult()
  if (paths.length > 0) {
    return Promise.resolve([
      asyncChain(
        paths.map((path) =>
          reportedStream(reverseSource(stream(path), separator, before, regex), io, path, 'tac'),
        ),
      ),
      io,
    ])
  }
  return Promise.resolve([reverseSource(resolveSource(opts.stdin), separator, before, regex), io])
}

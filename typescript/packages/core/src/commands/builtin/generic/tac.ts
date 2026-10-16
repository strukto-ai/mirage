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
import { asyncChain, rechunk } from '../../../io/stream.ts'
import { CHUNK_SIZE } from '../../../io/cooperative.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { RecordSpool, delimited } from '../../../io/record_spool.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat, findBytes } from '../../../utils/bytes.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function reverseSource(
  source: ByteSource,
  separator: string,
  before: boolean,
  regex: boolean,
): AsyncIterable<Uint8Array> {
  return rechunk(
    regex
      ? reversedRegex(source, separator, before)
      : reversed(source, encodeText(separator), before),
    CHUNK_SIZE,
  )
}

async function* reversed(
  source: ByteSource,
  separator: Uint8Array,
  before: boolean,
): AsyncGenerator<Uint8Array> {
  let records: RecordSpool
  if (separator.length === 1) records = await delimited([source], separator[0] ?? 0)
  else {
    records = new RecordSpool()
    const reader = new AsyncLineIterator(source)
    try {
      for (;;) {
        const [raw, found] = await reader.readUntil(separator)
        if (raw.length > 0 || found) await records.append(found ? concat([raw, separator]) : raw)
        if (!found) break
      }
    } catch (error) {
      await records.close()
      throw error
    } finally {
      await reader.discard()
    }
  }
  try {
    for (let index = records.count - 1; index >= 0; index--) {
      const [offset, whole] = await records.window(index)
      let size = whole
      if (before) {
        const tail =
          size >= separator.length
            ? await records.data.read(offset + size - separator.length, separator.length)
            : null
        if (tail !== null && findBytes(tail, separator) === 0) {
          size -= separator.length
          if (index === records.count - 1) yield separator
        }
        if (index > 0) yield separator
      }
      yield* records.data.stream(offset, size)
    }
  } finally {
    await records.close()
  }
}

async function* reversedRegex(
  source: ByteSource,
  separator: string,
  before: boolean,
): AsyncGenerator<Uint8Array> {
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

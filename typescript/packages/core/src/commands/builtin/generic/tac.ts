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
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat, findBytes } from '../../../utils/bytes.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

/**
 * `data` cut into tac's records, in file order. A record ends with the
 * separator, or with `before` (`-b`) starts with it; the text before the first
 * separator, or after the last, is a record without one. Mirrors Python's
 * _records.
 */
function records(data: Uint8Array, separator: Uint8Array, before: boolean): Uint8Array[] {
  const texts: Uint8Array[] = []
  let from = 0
  for (let at = findBytes(data, separator); at !== -1; at = findBytes(data, separator, from)) {
    texts.push(data.subarray(from, at))
    from = at + separator.byteLength
  }
  texts.push(data.subarray(from))
  const out = before
    ? [texts[0] ?? new Uint8Array(), ...texts.slice(1).map((text) => concat([separator, text]))]
    : [
        ...texts.slice(0, -1).map((text) => concat([text, separator])),
        texts.at(-1) ?? new Uint8Array(),
      ]
  return out.filter((record) => record.byteLength > 0)
}

async function reverseSource(
  source: AsyncIterable<Uint8Array>,
  separator: string,
  before: boolean,
  regex: boolean,
): Promise<Uint8Array> {
  const data = await materialize(source)
  if (!regex) return concat(records(data, encodeText(separator), before).reverse())
  const text = DEC.decode(data)
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
  return ENC.encode(found.reverse().join(''))
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

export async function tacGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<[ByteSource | null, IOResult]> {
  stream = stdinStream(stream, opts.stdin)
  const { separator, before, regex } = parseFlags(opts.flags)
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still reverse (GNU tac).
    const [ok, err] = await readOperands(paths, stream, 'tac')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: Uint8Array[] = []
    let total = 0
    for (const o of ok) {
      const part = await reverseSource(singleChunk(o.data), separator, before, regex)
      parts.push(part)
      total += part.byteLength
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    const result: ByteSource = out
    return [result, io]
  }
  const result: ByteSource = await reverseSource(
    resolveSource(opts.stdin),
    separator,
    before,
    regex,
  )
  return [result, new IOResult()]
}

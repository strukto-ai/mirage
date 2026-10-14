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
import type { PathSpec, ReadRangeFn } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'
import { operandsIo, singleChunk } from '../utils/operands.ts'
import { RANGE_FIRST_BLOCK, RANGE_MAX_BLOCK } from '../constants.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function indexOf(data: Uint8Array, separator: Uint8Array, from: number): number {
  const first = separator[0]
  if (first === undefined) return -1
  for (let at = data.indexOf(first, from); at !== -1; at = data.indexOf(first, at + 1)) {
    if (at + separator.byteLength > data.byteLength) return -1
    let k = 1
    while (k < separator.byteLength && data[at + k] === separator[k]) k += 1
    if (k === separator.byteLength) return at
  }
  return -1
}

/**
 * `data` cut into tac's records, in file order. A record ends with the
 * separator, or with `before` (`-b`) starts with it; the text before the first
 * separator, or after the last, is a record without one. Mirrors Python's
 * _records.
 */
function records(data: Uint8Array, separator: Uint8Array, before: boolean): Uint8Array[] {
  const texts: Uint8Array[] = []
  let from = 0
  for (let at = indexOf(data, separator, 0); at !== -1; at = indexOf(data, separator, from)) {
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

/**
 * A file's records last first, read from its end a block at a time. Only a
 * whole record is let out, so a reader that stops after the last lines leaves
 * the rest unread. For a one-byte separator, which no record boundary can
 * straddle unseen. Mirrors Python's _reverse_ranged.
 */
async function* reverseRanged(
  readRange: ReadRangeFn,
  p: PathSpec,
  size: number,
  separator: Uint8Array,
  before: boolean,
): AsyncIterable<Uint8Array> {
  let pos = size
  let held: Uint8Array = new Uint8Array()
  let block = RANGE_FIRST_BLOCK
  while (pos > 0) {
    const start = Math.max(pos - block, 0)
    held = concat([await readRange(p, start, pos - start), held])
    pos = start
    block = Math.min(block * 2, RANGE_MAX_BLOCK)
    const at = indexOf(held, separator, 0)
    if (pos === 0 || at < 0) continue
    const cut = before ? at : at + 1
    const out = concat(records(held.subarray(cut), separator, before).reverse())
    held = held.slice(0, cut)
    if (out.byteLength > 0) yield out
  }
  if (held.byteLength > 0) yield concat(records(held, separator, before).reverse())
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

interface TacFlags {
  readonly separator: string
  readonly before: boolean
  readonly regex: boolean
}

function parseFlags(bag: Record<string, FlagValue>): TacFlags {
  const fl = new FlagView(bag, specOf('tac'))
  return {
    separator: fl.asStr('separator') ?? '\n',
    before: fl.asBool('before'),
    regex: fl.asBool('regex'),
  }
}

/** Each operand's records last first, one operand after another: a size
 * reads the file from its end, bytes are the file read whole. An operand that
 * fails to read is reported on `io` and the next one goes on, as GNU tac
 * does. */
async function* reversed(
  plans: readonly [PathSpec, number | Uint8Array][],
  readRange: ReadRangeFn | null,
  separator: string,
  before: boolean,
  regex: boolean,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  for (const [p, plan] of plans) {
    try {
      if (typeof plan === 'number') {
        if (readRange !== null)
          yield* reverseRanged(readRange, p, plan, encodeText(separator), before)
      } else {
        yield await reverseSource(singleChunk(plan), separator, before, regex)
      }
    } catch (e) {
      if (!isFsError(e)) throw e
      const held = io.stderr === null ? new Uint8Array() : await materialize(io.stderr)
      io.stderr = concat([held, encodeText(fsErrorLine('tac', p, e))])
      io.exitCode = 1
    }
  }
}

/**
 * Run tac over resolved operands. A file the mount serves ranges for, with a
 * size its stat knows and a one-byte separator, is read from its end as the
 * output is pulled; any other is read whole. A missing operand is reported
 * and skipped; the remaining operands still reverse (GNU tac). Mirrors
 * Python's tac_generic.
 */
export async function tacGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readRange: ReadRangeFn | null = null,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
): Promise<[ByteSource | null, IOResult]> {
  stream = stdinStream(stream, opts.stdin)
  const { separator, before, regex } = parseFlags(opts.flags)
  if (paths.length > 0) {
    const ranged =
      readRange !== null && sizeOf !== undefined && !regex && encodeText(separator).byteLength === 1
    const plans: [PathSpec, number | Uint8Array][] = []
    let err = ''
    for (const p of paths) {
      try {
        const size = ranged && !isStdin(p) ? await sizeOf(p) : null
        plans.push([p, size ?? (await materialize(stream(p)))])
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tac', p, e)
      }
    }
    const io = operandsIo(err)
    if (plans.length === 0 && err !== '') return [null, io]
    return [reversed(plans, readRange, separator, before, regex, io), io]
  }
  const result: ByteSource = await reverseSource(
    resolveSource(opts.stdin),
    separator,
    before,
    regex,
  )
  return [result, new IOResult()]
}

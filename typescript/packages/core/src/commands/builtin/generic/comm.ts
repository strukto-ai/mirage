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

import { chunks } from '../../../io/cooperative.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { concat } from '../../../utils/bytes.ts'
import { closeStream, openStream } from '../../../rs/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { isStdin } from '../utils/stream.ts'
import { recordSeparator } from '../utils/lines.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'

const ENC = new TextEncoder()

// comm's options; `checkOrder` is the later of --check-order and
// --nocheck-order, null when neither was given.
interface CommFlags {
  readonly suppress1: boolean
  readonly suppress2: boolean
  readonly suppress3: boolean
  readonly checkOrder: boolean | null
  readonly outputDelimiter: string
  readonly total: boolean
  readonly zeroTerminated: boolean
}

function parseFlags(bag: Record<string, FlagValue>): CommFlags {
  const fl = new FlagView(bag, specOf('comm'))
  // An empty delimiter is its own terminating NUL: GNU writes one byte.
  const delimiter = fl.asStr('output_delimiter', '\t')
  const order = fl
    .occurrences('check_order', 'nocheck_order')
    .filter(([, value]) => value === true)
    .map(([name]) => name)
  return {
    suppress1: fl.asBool('args_1'),
    suppress2: fl.asBool('2'),
    suppress3: fl.asBool('3'),
    checkOrder: order.length > 0 ? order.at(-1) === 'check_order' : null,
    outputDelimiter: delimiter === '' ? '\0' : delimiter,
    total: fl.asBool('total'),
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

export function commGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const parsed = parseFlags(ctx.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.COMM, paths[2]?.rawPath ?? '')
  if (paths.length < 2) throw missingOperandError(CommandName.COMM, paths[0]?.rawPath ?? null)
  const p1 = paths[0]
  const p2 = paths[1]
  if (p1 === undefined || p2 === undefined) return [null, new IOResult()]
  const shared = new AsyncLineIterator(ctx.stdin ?? new Uint8Array())
  const reader = (p: PathSpec): AsyncLineIterator =>
    isStdin(p) ? shared : new AsyncLineIterator(read(p))
  const io = new IOResult()
  return [commStream([reader(p1), reader(p2)], io, parsed, [p1, p2], ctx.signal), io]
}

async function* commChunks(
  reader: AsyncLineIterator,
  separator: number,
): AsyncIterable<Uint8Array> {
  for (;;) {
    const record = await reader.readline(undefined, separator)
    if (record === null) return
    yield record
    yield Uint8Array.of(separator)
  }
}

async function* commStream(
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  io: IOResult,
  flags: CommFlags,
  paths: readonly [PathSpec, PathSpec],
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const separator = recordSeparator(flags.zeroTerminated)
  const stream = await openStream('comm', {
    suppressed: [flags.suppress1, flags.suppress2, flags.suppress3],
    check_order: flags.checkOrder,
    delimiter: flags.outputDelimiter,
    total: flags.total,
    terminator: separator,
  })
  const sources = [
    chunks(commChunks(readers[0], separator), signal),
    chunks(commChunks(readers[1], separator), signal),
  ] as const
  const errors: Uint8Array[] = []
  const budget = new YieldBudget(signal)
  function recordResult(): void {
    const error = stream.takeStderr()
    if (error.byteLength > 0) errors.push(error)
    io.stderr = concat(errors)
    io.exitCode = Math.max(io.exitCode, stream.status())
  }
  try {
    for (;;) {
      await budget.run()
      let output: Uint8Array
      if (stream.busy()) output = stream.drain()
      else {
        const wanted = stream.wants()
        if (wanted === null) break
        const side = wanted === 0 ? 0 : 1
        try {
          const next = await sources[side].next()
          output = next.done === true ? stream.endInput(side) : stream.feedInput(side, next.value)
        } catch (error) {
          if (!isFsError(error)) throw error
          errors.push(ENC.encode(fsErrorLine('comm', paths[side], error)))
          io.stderr = concat(errors)
          io.exitCode = 1
          return
        }
      }
      recordResult()
      if (output.byteLength > 0) yield output
    }
    if (!stream.done() && paths.every((path) => path.rawPath === '-')) {
      errors.push(ENC.encode('comm: -: Bad file descriptor\n'))
      io.stderr = concat(errors)
      io.exitCode = 1
      return
    }
    const output = stream.finish()
    recordResult()
    if (output.byteLength > 0) yield output
    while (stream.busy()) {
      await budget.run()
      const output = stream.drain()
      recordResult()
      if (output.byteLength > 0) yield output
    }
  } finally {
    recordResult()
    await closeStream(stream)
    for (const source of sources) await source.return?.()
    for (const reader of new Set(readers)) await reader.discard()
  }
}

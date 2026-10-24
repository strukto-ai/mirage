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
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { isStdin } from '../utils/stream.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { closeStream, mergeOutput, openStream } from '../../../rs/stream.ts'
import { byteView, encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'

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
  const readers: [AsyncLineIterator, AsyncLineIterator] = [reader(p1), reader(p2)]
  const io = new IOResult()
  return [commStream(parsed, readers, io, [p1, p2]), io]
}

/**
 * Run comm's merge over the two inputs; a failed read ends the run, named
 * for its operand after what comm already printed to stderr. Mirrors
 * Python's _comm_stream.
 */
async function* commStream(
  flags: CommFlags,
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  io: IOResult,
  paths: readonly [PathSpec, PathSpec],
): AsyncIterable<Uint8Array> {
  const stream = await openStream('comm', {
    suppress: [flags.suppress1, flags.suppress2, flags.suppress3],
    check_order: flags.checkOrder,
    delimiter: byteView(flags.outputDelimiter),
    total: flags.total,
    zero_terminated: flags.zeroTerminated,
    shared: readers[0] === readers[1],
    stdin_twice: paths[0].rawPath === '-' && paths[1].rawPath === '-',
  })
  let failed: 0 | 1 = 0
  const pull = (which: number): Promise<Uint8Array | null> => {
    failed = which === 0 ? 0 : 1
    return readers[failed].readChunk()
  }
  let error = ''
  try {
    try {
      yield* mergeOutput(stream, pull)
    } catch (caught) {
      if (!isFsError(caught)) throw caught
      error = fsErrorLine('comm', paths[failed], caught)
    }
  } finally {
    const stderr = concat([stream.takeStderr(), encodeText(error)])
    io.stderr = stderr.byteLength > 0 ? stderr : null
    io.exitCode = error === '' ? stream.status() : 1
    await closeStream(stream)
    for (const reader of new Set(readers)) await reader.discard()
  }
}

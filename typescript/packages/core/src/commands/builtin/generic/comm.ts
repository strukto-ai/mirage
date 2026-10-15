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

import { compareCodePoints } from '../../../utils/sort.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { stdinStream } from '../utils/stream.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface CommFlags {
  readonly suppress1: boolean
  readonly suppress2: boolean
  readonly suppress3: boolean
  readonly checkOrder: boolean
  readonly outputDelimiter: string
  readonly total: boolean
  readonly zeroTerminated: boolean
}

function parseFlags(bag: Record<string, FlagValue>): CommFlags {
  const fl = new FlagView(bag, specOf('comm'))
  return {
    suppress1: fl.asBool('args_1'),
    suppress2: fl.asBool('2'),
    suppress3: fl.asBool('3'),
    checkOrder: fl.asBool('check_order'),
    outputDelimiter: fl.asStr('output_delimiter') ?? '\t',
    total: fl.asBool('total'),
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

export function commGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const parsed = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.COMM, paths[2]?.rawPath ?? '')
  if (paths.length < 2) throw missingOperandError(CommandName.COMM, paths[0]?.rawPath ?? null)
  const p1 = paths[0]
  const p2 = paths[1]
  if (p1 === undefined || p2 === undefined) return [null, new IOResult()]
  const stream = stdinStream(read, opts.stdin)
  const readers = [new AsyncLineIterator(stream(p1)), new AsyncLineIterator(stream(p2))] as const
  const io = new IOResult()
  return [commStream(readers, io, parsed), io]
}

async function* commStream(
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  io: IOResult,
  flags: CommFlags,
): AsyncIterable<Uint8Array> {
  const separator = flags.zeroTerminated ? 0 : 10
  const previous: (string | null)[] = [null, null]
  const warned = [false, false]
  const counts = [0, 0, 0]
  const suppressed = [flags.suppress1, flags.suppress2, flags.suppress3]
  async function read(which: 0 | 1): Promise<string | null> {
    const raw = await readers[which].readline(undefined, separator)
    const line = raw === null ? null : DEC.decode(raw)
    const before = previous[which]
    if (
      flags.checkOrder &&
      line !== null &&
      before !== null &&
      before !== undefined &&
      compareCodePoints(line, before) < 0
    ) {
      warned[which] = true
      io.stderr = ENC.encode(`comm: file ${warned[0] ? '1' : '2'} is not in sorted order\n`)
      io.exitCode = 1
    }
    previous[which] = line
    return line
  }
  try {
    let left = await read(0),
      right = await read(1)
    while (left !== null || right !== null) {
      const column =
        right === null || (left !== null && compareCodePoints(left, right) < 0)
          ? 1
          : left === null || compareCodePoints(right, left) < 0
            ? 2
            : 3
      const text = column === 2 ? right : left
      counts[column - 1] = (counts[column - 1] ?? 0) + 1
      if (!suppressed[column - 1])
        yield ENC.encode(
          flags.outputDelimiter.repeat(
            suppressed.slice(0, column - 1).filter((hidden) => !hidden).length,
          ) +
            (text ?? '') +
            String.fromCharCode(separator),
        )
      if (column !== 2) left = await read(0)
      if (column !== 1) right = await read(1)
    }
    if (flags.total)
      yield ENC.encode(
        [...counts.filter((_, i) => !suppressed[i]).map(String), 'total'].join(
          flags.outputDelimiter,
        ) + String.fromCharCode(separator),
      )
  } finally {
    for (const reader of readers) await reader.discard()
  }
}

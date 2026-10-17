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
import type { CommandFnResult, Context } from '../../config.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { isStdin } from '../utils/stream.ts'
import { recordSeparator } from '../utils/lines.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

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
  return [commStream([reader(p1), reader(p2)], io, parsed, [p1, p2]), io]
}

/**
 * Merge the two inputs, checking each one's order as GNU comm does.
 *
 * Each newly read line is checked against its file's previous one: always
 * under --check-order, where the first disorder ends the run, never under
 * --nocheck-order, and by default only once a line unique to one file has
 * printed, warning once per file and closing with `input is not in sorted
 * order`. Both exit 1. A failed read ends the run too, named for its
 * operand; two `-` operands share one stdin reader, and GNU, closing stdin
 * twice, ends with `comm: -: Bad file descriptor`, exit 1, before --total.
 */
async function* commStream(
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  io: IOResult,
  flags: CommFlags,
  paths: readonly [PathSpec, PathSpec],
): AsyncIterable<Uint8Array> {
  const separator = recordSeparator(flags.zeroTerminated)
  const lines: [string | null, string | null] = [null, null]
  const warned = [false, false]
  const counts = [0, 0, 0]
  const errors: string[] = []
  const suppressed = [flags.suppress1, flags.suppress2, flags.suppress3]
  let unpairable = false
  // Read file WHICH's next line; whether its order ends the run.
  async function pull(which: 0 | 1): Promise<boolean> {
    let raw: Uint8Array | null
    try {
      raw = await readers[which].readline(undefined, separator)
    } catch (error) {
      if (!isFsError(error)) throw error
      errors.push(fsErrorLine('comm', paths[which], error))
      io.stderr = ENC.encode(errors.join(''))
      io.exitCode = 1
      return true
    }
    const before = lines[which]
    const line = raw === null ? null : DEC.decode(raw)
    lines[which] = line
    if (
      flags.checkOrder === false ||
      !(flags.checkOrder === true || unpairable) ||
      warned[which] === true ||
      line === null ||
      before === null ||
      compareCodePoints(line, before) >= 0
    )
      return false
    warned[which] = true
    errors.push(`comm: file ${String(which + 1)} is not in sorted order\n`)
    io.stderr = ENC.encode(errors.join(''))
    io.exitCode = 1
    return flags.checkOrder === true
  }
  try {
    if ((await pull(0)) || (await pull(1))) return
    for (;;) {
      const [left, right] = lines
      if (left === null && right === null) break
      const column =
        right === null || (left !== null && compareCodePoints(left, right) < 0)
          ? 1
          : left === null || compareCodePoints(right, left) < 0
            ? 2
            : 3
      unpairable ||= column !== 3
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
      if (column !== 2 && (await pull(0))) return
      if (column !== 1 && (await pull(1))) return
    }
    if (paths.every((p) => p.rawPath === '-')) {
      errors.push('comm: -: Bad file descriptor\n')
      io.stderr = ENC.encode(errors.join(''))
      io.exitCode = 1
      return
    }
    if (flags.total)
      yield ENC.encode(
        [...counts.filter((_, i) => !suppressed[i]).map(String), 'total'].join(
          flags.outputDelimiter,
        ) + String.fromCharCode(separator),
      )
    if (warned.includes(true)) {
      errors.push('comm: input is not in sorted order\n')
      io.stderr = ENC.encode(errors.join(''))
    }
  } finally {
    for (const reader of new Set(readers)) await reader.discard()
  }
}

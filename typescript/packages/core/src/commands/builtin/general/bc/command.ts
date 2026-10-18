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

import type { Accessor } from '../../../../accessor/base.ts'
import { chunks } from '../../../../io/cooperative.ts'
import { OutputStream, closeQuietly } from '../../../../io/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import { YieldBudget } from '../../../../io/yield_budget.ts'
import { openStream, type OpenStream } from '../../../../rs/stream.ts'
import type { PathSpec } from '../../../../types.ts'
import { concat } from '../../../../utils/bytes.ts'
import { command, type CommandFnResult, type Context } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'

async function* diagnostics(
  parts: readonly Uint8Array[],
  count: number,
): AsyncGenerator<Uint8Array> {
  await Promise.resolve()
  for (const part of parts) {
    if (count === 0) return
    count -= 1
    yield part
  }
}

/** Collect diagnostics before yielding output and drain pending work. */
export async function* drained(
  stream: OpenStream,
  output: Uint8Array,
  io: IOResult,
  budget: YieldBudget,
  errors: Uint8Array[],
): AsyncGenerator<Uint8Array> {
  for (;;) {
    io.exitCode = stream.status()
    const notice = stream.takeStderr()
    if (notice.byteLength > 0) {
      errors.push(notice)
      io.stderr = diagnostics(errors, errors.length)
    }
    if (output.byteLength > 0) yield output
    if (!stream.busy()) return
    await budget.run()
    output = stream.drain()
  }
}

export function bc(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('bc'))
  const config = {
    math_mode: fl.asBool('args_l'),
    line_length: ctx.env?.BC_LINE_LENGTH ?? null,
  }
  const source = ctx.stdin ?? new Uint8Array()
  const io = new IOResult()
  const errors: Uint8Array[] = []
  let inputStarted = false
  const input =
    source instanceof Uint8Array
      ? source
      : {
          [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]()
            inputStarted = true
            return iterator
          },
        }
  async function* output(): AsyncGenerator<Uint8Array> {
    const stream = await openStream('bc', config)
    const budget = new YieldBudget(ctx.signal)
    try {
      for await (const chunk of chunks(input, ctx.signal)) {
        await budget.run()
        yield* drained(stream, stream.feed(chunk), io, budget, errors)
        if (stream.done()) break
      }
      yield* drained(stream, stream.finish(), io, budget, errors)
    } finally {
      // Snapshots serve reads while output drains; once it stops, the
      // command record copies stderr only as bytes, so join it once.
      if (errors.length > 0) io.stderr = concat(errors)
      stream.close()
    }
  }
  return Promise.resolve([
    new OutputStream(output(), async () => {
      if (!inputStarted) await closeQuietly(source)
    }),
    io,
  ])
}

export const GENERAL_BC = command({
  name: 'bc',
  vfs: null,
  spec: specOf('bc'),
  fn: bc,
})

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

import { IOResult } from '../../../../io/types.ts'
import { YieldBudget } from '../../../../io/yield_budget.ts'
import { closeStream, openStream } from '../../../../rs/stream.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'

/**
 * Format raw shell arguments through the shared bounded engine. The output
 * comes out as the engine drains it, one bounded step at a time, so a wide
 * field or a long reuse of the format is never held whole, and a reader that
 * stops early stops the engine. The status and stderr settle on `io` as the
 * output ends, or as its reader stops: the status the format reached, unless
 * an output limit set one first, and the stderr ahead of that limit's notice.
 * Mirrors Python's printf_output.
 */
export async function* printfOutput(
  fmt: string,
  args: string[],
  io: IOResult,
  program = false,
  posix = false,
  utf8 = false,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const stream = await openStream('printf', {
    mode: program ? 'program' : 'builtin',
    posix,
    argument_count: args.length,
    utf8,
  })
  const budget = new YieldBudget(signal)
  const errors: Uint8Array[] = []
  try {
    for (const [index, text] of [fmt, ...args].entries()) {
      for (let at = 0; at < text.length;) {
        let end = Math.min(at + 4096, text.length)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        stream.feedInput(index, encodeText(text.slice(at, end)))
        at = end
        await budget.run()
      }
      stream.endInput(index)
      await budget.run()
    }
    const output = stream.finish()
    const first = stream.takeStderr()
    if (first.byteLength > 0) errors.push(first)
    if (output.byteLength > 0) yield output
    while (stream.busy()) {
      const part = stream.drain()
      const more = stream.takeStderr()
      if (more.byteLength > 0) errors.push(more)
      if (part.byteLength > 0) yield part
      await budget.run()
    }
  } finally {
    if (stream.live) {
      if (io.exitCode === 0) io.exitCode = stream.status()
      const err = concat(errors)
      if (err.byteLength > 0) {
        io.stderr = io.stderr instanceof Uint8Array ? concat([err, io.stderr]) : err
      }
    }
    await closeStream(stream)
  }
}

/** `printfOutput` collected whole, for `printf -v`. Mirrors Python's run_printf. */
export async function runPrintf(
  fmt: string,
  args: string[],
  program = false,
  posix = false,
  utf8 = false,
  signal?: AbortSignal,
): Promise<[Uint8Array, Uint8Array, number]> {
  const io = new IOResult()
  const output: Uint8Array[] = []
  for await (const part of printfOutput(fmt, args, io, program, posix, utf8, signal)) {
    output.push(part)
  }
  return [
    concat(output),
    io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(),
    io.exitCode,
  ]
}

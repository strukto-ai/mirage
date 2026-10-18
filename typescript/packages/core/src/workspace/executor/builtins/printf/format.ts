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

import { YieldBudget } from '../../../../io/yield_budget.ts'
import { openStream } from '../../../../rs/stream.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'

/** Format raw shell arguments through the shared bounded engine. */
export async function runPrintf(
  fmt: string,
  args: string[],
  program = false,
  posix = false,
  utf8 = false,
  signal?: AbortSignal,
): Promise<[Uint8Array, Uint8Array, number, boolean]> {
  const stream = await openStream('printf', {
    mode: program ? 'program' : 'builtin',
    posix,
    argument_count: args.length,
    utf8,
  })
  const budget = new YieldBudget(signal)
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
    const output = [stream.finish()]
    const errors = [stream.takeStderr()]
    while (stream.busy()) {
      output.push(stream.drain())
      errors.push(stream.takeStderr())
      await budget.run()
    }
    return [concat(output), concat(errors), stream.status(), stream.done()]
  } finally {
    stream.close()
  }
}

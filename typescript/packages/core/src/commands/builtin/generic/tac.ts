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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

async function collectLines(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const lines: Uint8Array[] = []
  const iter = new AsyncLineIterator(source)
  for await (const line of iter) lines.push(line)
  return lines
}

function reverseJoin(lines: Uint8Array[]): Uint8Array {
  lines.reverse()
  let total = 0
  for (const l of lines) total += l.byteLength + 1
  const out = new Uint8Array(total)
  let offset = 0
  for (const l of lines) {
    out.set(l, offset)
    offset += l.byteLength
    out[offset] = 0x0a
    offset += 1
  }
  return out
}

export async function tacGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  // Each operand is reversed independently and the outputs concatenate in
  // operand order, like GNU tac.
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still reverse (GNU tac).
    const [ok, err] = await readOperands(paths, stream, 'tac')
    const io = operandsIo(err, { cache: ok.map((o) => o.path.virtual) })
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: Uint8Array[] = []
    let total = 0
    for (const o of ok) {
      const part = reverseJoin(await collectLines(singleChunk(o.data)))
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
  const lines = await collectLines(resolveSource(opts.stdin))
  const result: ByteSource = reverseJoin(lines)
  return [result, new IOResult()]
}

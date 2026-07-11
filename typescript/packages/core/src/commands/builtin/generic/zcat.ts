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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()

export async function zcatGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  // Each operand decompresses independently and the outputs concatenate
  // in operand order, like GNU zcat.
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still decompress (GNU zcat).
    const [ok, err] = await readOperands(paths, stream, 'zcat')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: Uint8Array[] = []
    let total = 0
    for (const o of ok) {
      const part = await gunzip(o.data)
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
  const stdinBytes = await readStdinAsync(opts.stdin)
  if (stdinBytes === null) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('zcat: (stdin): unexpected end of file\n'),
      }),
    ]
  }
  const result: ByteSource = await gunzip(stdinBytes)
  return [result, new IOResult()]
}

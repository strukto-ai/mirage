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
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function reverseString(s: string): string {
  return Array.from(s).reverse().join('')
}

async function* revStream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const iter = new AsyncLineIterator(source)
  for await (const line of iter) {
    yield ENC.encode(reverseString(DEC.decode(line)) + '\n')
  }
}

async function* revMulti(buffers: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const data of buffers) {
    for await (const chunk of revStream(singleChunk(data))) yield chunk
  }
}

export async function revGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length > 0) {
    // Operands read eagerly so a missing one is reported up front and the
    // remaining operands still print (GNU rev).
    const [ok, err] = await readOperands(paths, stream, 'rev')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    return [revMulti(ok.map((o) => o.data)), io]
  }
  try {
    const source = resolveSource(opts.stdin, 'rev: missing operand')
    return [revStream(source), new IOResult()]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}

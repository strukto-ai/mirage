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
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { cutStream, parseCutRanges } from '../cut_helper.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()

async function* chainStreams(
  streams: readonly AsyncIterable<Uint8Array>[],
): AsyncIterable<Uint8Array> {
  for (const s of streams) {
    for await (const chunk of s) yield chunk
  }
}

export async function cutGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const f = typeof opts.flags.f === 'string' ? opts.flags.f : null
  const d = typeof opts.flags.d === 'string' ? opts.flags.d : null
  const c = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const complement = opts.flags.complement === true
  const z = opts.flags.z === true
  const fields = f !== null ? parseCutRanges(f) : null
  const chars = c !== null ? parseCutRanges(c) : null
  const delim = d ?? '\t'

  if (paths.length > 0) {
    // Each operand is read eagerly (a missing one is reported and skipped,
    // GNU-style), cut independently, and the outputs concatenate in operand
    // order (a file without a trailing newline never merges its last line
    // into the next operand's first).
    const [ok, err] = await readOperands(paths, stream, 'cut')
    const io = operandsIo(err, { cache: ok.map((o) => o.path.virtual) })
    if (ok.length === 0 && err !== '') return [null, io]
    const outputs = ok.map((o) =>
      cutStream(singleChunk(o.data), delim, fields, chars, complement, z),
    )
    const out: ByteSource = chainStreams(outputs)
    return [out, io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, 'cut: missing operand')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const out: ByteSource = cutStream(source, delim, fields, chars, complement, z)
  return [out, new IOResult()]
}

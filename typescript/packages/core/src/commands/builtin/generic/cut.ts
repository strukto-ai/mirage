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

const ENC = new TextEncoder()

export function cutGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const f = typeof opts.flags.f === 'string' ? opts.flags.f : null
  const d = typeof opts.flags.d === 'string' ? opts.flags.d : null
  const c = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const complement = opts.flags.complement === true
  const z = opts.flags.z === true
  const fields = f !== null ? parseCutRanges(f) : null
  const chars = c !== null ? parseCutRanges(c) : null
  const delim = d ?? '\t'

  let source: AsyncIterable<Uint8Array>
  const cache: string[] = []
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    source = stream(first)
    cache.push(first.virtual)
  } else {
    try {
      source = resolveSource(opts.stdin, 'cut: missing operand')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
  }
  const out: ByteSource = cutStream(source, delim, fields, chars, complement, z)
  return [out, new IOResult({ cache })]
}

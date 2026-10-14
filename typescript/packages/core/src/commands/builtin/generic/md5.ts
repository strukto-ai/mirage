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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { md5Hex } from '../../../utils/hash.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatRecords } from '../utils/output.ts'
import { operandsIo } from '../utils/operands.ts'
import { isStdin } from '../utils/stream.ts'
import { isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import type { StoredDigest } from './checksum.ts'

/**
 * Run BSD md5 over resolved operands. An operand's digest is asked of
 * `stored` first, once `stat` has found a file there, and the file is read
 * only when there is none. Mirrors Python's md5_generic.
 */
export async function md5Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: (p: PathSpec) => Promise<unknown>,
  stored?: StoredDigest,
): Promise<CommandFnResult> {
  const lines: string[] = []
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the good hashes still
    // print (GNU md5sum).
    let err = ''
    for (const p of paths) {
      try {
        let digest: string | null = null
        if (stat !== undefined && stored !== undefined && !isStdin(p)) {
          await stat(p)
          digest = await stored(p, 'md5')
        }
        digest ??= md5Hex(await materialize(stream(p)))
        lines.push(`${digest}  ${p.rawPath}`)
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('md5', p, e)
      }
    }
    const io = operandsIo(err)
    if (lines.length === 0 && err !== '') return [null, io]
    const out: ByteSource = formatRecords(lines)
    return [out, io]
  }
  const data = opts.stdin === null ? new Uint8Array(0) : await materialize(opts.stdin)
  lines.push(`${md5Hex(data)}  -`)
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult()]
}
